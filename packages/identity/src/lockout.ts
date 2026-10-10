import { createHash } from 'node:crypto';
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import type { BetterAuthPlugin } from 'better-auth';
import { DEFAULTS } from './defaults';
import { emitSafely, type SecurityEventSink } from './events';
import {
  bumpDeviceEpoch,
  knownDeviceId,
  rememberDevice,
  reissueDevice,
  validDevice,
} from './known-device';

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
    // of guesses from other addresses exhausts, and they must not reach the owner.
    //
    // Per device FIRST. A request this device's own limit refuses must not touch the shared budget:
    // otherwise one stolen cookie burns the whole account's allowance in a few dozen requests and the
    // owner's other devices are refused with it.
    const mine = await storage.increment(
      lockoutKeys.device(kind, gen, subject, deviceId),
      knownDevice.windowSeconds,
    );
    if (mine > knownDevice.maxAttempts) await refuse();
    // The cookie is a bypass, so ALL valid devices of the account share a budget, spent only by
    // attempts that passed the device limit; past it a cookie counts for nothing and the request is
    // judged like any other.
    const together = await storage.increment(
      lockoutKeys.devices(kind, gen, subject),
      knownDevice.accountWindowSeconds,
    );
    if (together <= knownDevice.accountMaxAttempts) return;
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
  // What a before hook learned and the matching after hook needs, keyed by the CALL. A browser request
  // has `ctx.request`; a server-side `auth.api.x({ headers })` call has none (review L2), only its headers
  // (or just a body). Whichever exists is the same object in both hooks of one call.
  const resetUser = new WeakMap<object, string>();
  const revoked = new WeakMap<
    object,
    { userId: string; device?: { deviceId: string; iat: number } }
  >();
  const callKey = (ctx: {
    request?: Request | undefined;
    headers?: Headers | undefined;
    body?: unknown;
  }): object | undefined =>
    ctx.request ?? ctx.headers ?? (ctx.body && typeof ctx.body === 'object' ? ctx.body : undefined);
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
          // "Sign out everywhere" and "sign out OTHER sessions" must also forget remembered devices
          // (see known-device.ts). For "other", this browser stays remembered: note its cookie now,
          // while it is still valid, and re-issue it under the new epoch afterwards.
          matcher: (ctx) =>
            ctx.path === '/revoke-sessions' || ctx.path === '/revoke-other-sessions',
          handler: createAuthMiddleware(async (ctx) => {
            const key = callKey(ctx);
            const session = key ? await getSessionFromCtx(ctx) : null;
            if (!key || !session) return;
            const userId = session.user.id;
            const device =
              ctx.path === '/revoke-other-sessions'
                ? await validDevice(ctx, async () => userId)
                : undefined;
            revoked.set(key, { userId, ...(device ? { device } : {}) });
          }),
        },
        {
          // Remember whose reset this is while the token still exists; cleared on success below.
          matcher: (ctx) => ctx.path === '/reset-password',
          handler: createAuthMiddleware(async (ctx) => {
            const token = (ctx.body as { token?: unknown } | undefined)?.token;
            const key = callKey(ctx);
            if (typeof token !== 'string' || !key) return;
            const pending = await ctx.context.internalAdapter.findVerificationValue(
              `reset-password:${token}`,
            );
            const user = pending
              ? await ctx.context.internalAdapter.findUserById(pending.value)
              : null;
            if (user) resetUser.set(key, user.email);
          }),
        },
      ],
      after: [
        {
          matcher: (ctx) =>
            ctx.path === '/revoke-sessions' ||
            ctx.path === '/revoke-other-sessions' ||
            ctx.path === '/admin/revoke-user-sessions',
          handler: createAuthMiddleware(async (ctx) => {
            if (ctx.context.returned instanceof Error) return;
            if (ctx.path === '/admin/revoke-user-sessions') {
              const target = (ctx.body as { userId?: unknown } | undefined)?.userId;
              if (typeof target === 'string') await bumpDeviceEpoch(ctx, target);
              return;
            }
            const key = callKey(ctx);
            const seen = key ? revoked.get(key) : undefined;
            if (!seen) return;
            await bumpDeviceEpoch(ctx, seen.userId);
            // "Other sessions" keeps the one asking: its cookie, valid until now, gets the new epoch.
            if (seen.device) await reissueDevice(ctx, seen.userId, seen.device);
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
            const key = callKey(ctx);
            const email = key ? resetUser.get(key) : undefined;
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
