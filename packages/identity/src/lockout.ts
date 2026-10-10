import { createHash } from 'node:crypto';
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import type { BetterAuthPlugin } from 'better-auth';
import { DEFAULTS } from './defaults';
import { emitSafely, type SecurityEventSink } from './events';
import { bumpDeviceEpoch, knownDeviceId, rememberDevice } from './known-device';

const digest = (value: string): string =>
  createHash('sha256').update(value.trim().toLowerCase()).digest('hex');

/** Counter keys. `gen` is bumped to clear every counter of an account at once (see below). */
export const lockoutKeys = {
  gen: (subject: string) => `lockout:gen:${digest(subject)}`,
  account: (kind: string, gen: number, subject: string) =>
    `lockout:${kind}:acct:${gen}:${digest(subject)}`,
  accountAndIp: (kind: string, gen: number, subject: string, ip: string) =>
    `lockout:${kind}:ip:${gen}:${digest(subject)}:${ip}`,
  devices: (kind: string, gen: number, subject: string) =>
    `lockout:${kind}:devs:${gen}:${digest(subject)}`,
  device: (kind: string, gen: number, subject: string, deviceId: string) =>
    `lockout:${kind}:dev:${gen}:${digest(subject)}:${deviceId}`,
};

const TWO_FACTOR_PATHS = new Set([
  '/two-factor/verify-totp',
  '/two-factor/verify-backup-code',
  '/two-factor/verify-otp',
]);
const TWO_FACTOR_COOKIE = 'two_factor';

type Storage = NonNullable<
  Parameters<Parameters<typeof createAuthMiddleware>[0]>[0]['context']['secondaryStorage']
>;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function generation(storage: Storage, subject: string): Promise<number> {
  return Number(await storage.get(lockoutKeys.gen(subject))) || 0;
}

/**
 * Count one attempt against `subject` (an email for sign-in, a user id for 2FA) from `ip`.
 * Throws 429 at the per-account-and-address limit or at the hourly ceiling; otherwise waits out the
 * progressive delay. Counting happens BEFORE the attempt with an atomic `increment`, so N parallel
 * guesses cannot all slip through ahead of the first recorded failure.
 */
async function admit(
  storage: Storage,
  kind: string,
  subject: string,
  ip: string,
  refuse: () => Promise<never>,
  deviceId?: string,
): Promise<void> {
  const { perAccountAndIp, perAccount, knownDevice } = DEFAULTS.lockout;
  const gen = await generation(storage, subject);
  if (deviceId) {
    // A known device is limited per device: the account-wide delay and ceiling are exactly what a flood
    // of guesses from other addresses exhausts, and they must not reach the owner. But the cookie is a
    // bypass, so ALL valid devices of the account share a budget; past it a cookie counts for nothing
    // and the request is judged like any other.
    const together = await storage.increment(
      lockoutKeys.devices(kind, gen, subject),
      knownDevice.accountWindowSeconds,
    );
    if (together <= knownDevice.accountMaxAttempts) {
      const mine = await storage.increment(
        lockoutKeys.device(kind, gen, subject, deviceId),
        knownDevice.windowSeconds,
      );
      if (mine > knownDevice.maxAttempts) await refuse();
      return;
    }
  }
  const here = await storage.increment(
    lockoutKeys.accountAndIp(kind, gen, subject, ip),
    perAccountAndIp.windowSeconds,
  );
  if (here > perAccountAndIp.maxAttempts) await refuse();
  const total = await storage.increment(
    lockoutKeys.account(kind, gen, subject),
    perAccount.windowSeconds,
  );
  if (total > perAccount.ceiling) await refuse();
  if (total > perAccount.freeAttempts) {
    await sleep(
      Math.min((total - perAccount.freeAttempts) * perAccount.delayStepMs, perAccount.maxDelayMs),
    );
  }
}

/** Forget every counter of `subject`: bump the generation the keys carry. */
export async function clearAttempts(storage: Storage, subject: string): Promise<void> {
  const gen = await generation(storage, subject);
  await storage.set(lockoutKeys.gen(subject), String(gen + 1), 30 * 24 * 3600);
}

/**
 * Per-account throttling of password guessing (identity plan §5.4, D14, review S5). Better Auth 1.7
 * rate-limits per `IP|path` only, so one account guessed from many addresses is never throttled by its
 * built-in limiter; this adds the per-account layers (see `DEFAULTS.lockout`), on `/sign-in/email` and
 * on 2FA verification. Sign-up is limited per IP only, by the built-in rule.
 */
export function accountLockout(sink: SecurityEventSink): BetterAuthPlugin {
  const resetUser = new WeakMap<Request, string>();
  const revokedUser = new WeakMap<Request, string>();
  const refuse = async (): Promise<never> => {
    await emitSafely(sink, { name: 'account.locked' });
    throw APIError.from('TOO_MANY_REQUESTS', {
      code: 'ACCOUNT_LOCKED',
      message: 'Too many attempts. Try again later.',
    });
  };
  const ipOf = (ctx: { request?: Request | undefined }) =>
    ctx.request?.headers.get(DEFAULTS.clientIpHeader) ?? 'unknown';

  return {
    id: 'qnsc-account-lockout',
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === '/sign-in/email',
          handler: createAuthMiddleware(async (ctx) => {
            const email = (ctx.body as { email?: unknown } | undefined)?.email;
            const storage = ctx.context.secondaryStorage;
            if (typeof email !== 'string' || !storage) return;
            const device = await knownDeviceId(
              ctx,
              async () => (await ctx.context.internalAdapter.findUserByEmail(email))?.user.id,
            );
            await admit(storage, 'signin', email, ipOf(ctx), refuse, device);
          }),
        },
        {
          matcher: (ctx) => ctx.path !== undefined && TWO_FACTOR_PATHS.has(ctx.path),
          handler: createAuthMiddleware(async (ctx) => {
            const storage = ctx.context.secondaryStorage;
            const userId = await pendingUserId(ctx);
            if (!storage || !userId) return;
            const device = await knownDeviceId(ctx, async () => userId);
            await admit(storage, '2fa', userId, ipOf(ctx), refuse, device);
          }),
        },
        {
          // "Sign out everywhere" must also forget the remembered devices (see known-device.ts).
          matcher: (ctx) => ctx.path === '/revoke-sessions',
          handler: createAuthMiddleware(async (ctx) => {
            const session = await getSessionFromCtx(ctx);
            if (session && ctx.request) revokedUser.set(ctx.request, session.user.id);
          }),
        },
        {
          // Remember whose reset this is while the token still exists; cleared on success below.
          matcher: (ctx) => ctx.path === '/reset-password',
          handler: createAuthMiddleware(async (ctx) => {
            const token = (ctx.body as { token?: unknown } | undefined)?.token;
            if (typeof token !== 'string' || !ctx.request) return;
            const pending = await ctx.context.internalAdapter.findVerificationValue(
              `reset-password:${token}`,
            );
            const user = pending
              ? await ctx.context.internalAdapter.findUserById(pending.value)
              : null;
            if (user) resetUser.set(ctx.request, user.email);
          }),
        },
      ],
      after: [
        {
          matcher: (ctx) =>
            ctx.path === '/revoke-sessions' || ctx.path === '/admin/revoke-user-sessions',
          handler: createAuthMiddleware(async (ctx) => {
            if (ctx.context.returned instanceof Error) return;
            const body = ctx.body as { userId?: unknown } | undefined;
            const userId =
              ctx.path === '/admin/revoke-user-sessions'
                ? typeof body?.userId === 'string'
                  ? body.userId
                  : undefined
                : ctx.request
                  ? revokedUser.get(ctx.request)
                  : undefined;
            if (userId) await bumpDeviceEpoch(ctx, userId);
          }),
        },
        {
          matcher: (ctx) => ctx.path === '/sign-in/email',
          handler: createAuthMiddleware(async (ctx) => {
            const email = (ctx.body as { email?: unknown } | undefined)?.email;
            const storage = ctx.context.secondaryStorage;
            if (typeof email !== 'string' || !storage) return;
            // A 2FA challenge is not a completed sign-in: the counters stay until the factor verifies.
            const challenge = (ctx.context.returned as { twoFactorRedirect?: boolean } | undefined)
              ?.twoFactorRedirect;
            const userId = ctx.context.newSession?.user.id;
            if (!(ctx.context.returned instanceof Error) && !challenge) {
              await clearAttempts(storage, email);
              if (userId) await rememberDevice(ctx, userId);
            }
          }),
        },
        {
          matcher: (ctx) => ctx.path !== undefined && TWO_FACTOR_PATHS.has(ctx.path),
          handler: createAuthMiddleware(async (ctx) => {
            const storage = ctx.context.secondaryStorage;
            const userId = ctx.context.newSession?.user.id;
            if (storage && userId && !(ctx.context.returned instanceof Error)) {
              await clearAttempts(storage, userId);
              await rememberDevice(ctx, userId);
            }
          }),
        },
        {
          matcher: (ctx) => ctx.path === '/reset-password',
          handler: createAuthMiddleware(async (ctx) => {
            const storage = ctx.context.secondaryStorage;
            const email = ctx.request ? resetUser.get(ctx.request) : undefined;
            if (!storage || !email || ctx.context.returned instanceof Error) return;
            await clearAttempts(storage, email);
          }),
        },
      ],
    },
  };
}

/** The user a 2FA attempt is about: the pending challenge's cookie. */
async function pendingUserId(
  ctx: Parameters<Parameters<typeof createAuthMiddleware>[0]>[0],
): Promise<string | undefined> {
  const cookie = ctx.context.createAuthCookie(TWO_FACTOR_COOKIE);
  const identifier = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
  if (!identifier) return undefined;
  const pending = await ctx.context.internalAdapter.findVerificationValue(identifier);
  return pending?.value;
}
