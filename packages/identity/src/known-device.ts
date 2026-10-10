import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import type { createAuthMiddleware } from 'better-auth/api';
import { DEFAULTS } from './defaults';

/**
 * The known-device cookie (OWASP "remember this device"): a browser that has signed in carries a token,
 * and a request that carries a valid one for the account is exempt from the account-wide throttle
 * (`lockout.ts`). It is therefore a bypass, and so it is bound tightly (review S5 and its re-review):
 *
 *  - **Our own HMAC, domain-separated.** `v2.<userId>.<deviceId>.<iat>.<epoch>.<tag>`, where the tag is
 *    HMAC-SHA256 under a key derived (HKDF) from `BETTER_AUTH_SECRET` for this purpose alone, over the
 *    cookie NAME and the payload. It is not one of Better Auth's signed cookies, and a value signed for
 *    another cookie cannot be replayed as this one.
 *  - **Server-side expiry.** `iat` is inside the signed value; older than `maxAgeSeconds` is rejected
 *    regardless of what the browser kept.
 *  - **Bound to the credential.** `epoch` is a keyed fingerprint of the user's credential account
 *    (password hash and update time) and the user's own `updatedAt`. It changes on password change and
 *    reset, and `bumpDeviceEpoch` moves `user.updatedAt` on "sign out everywhere" and the admin's revoke-all.
 *    The hash itself never leaves the server: the cookie carries only the keyed fingerprint.
 *  - **Capped per account** (see `admit` in `lockout.ts`): all valid devices together, not each one.
 *
 * A cookie in any other shape, including the first (8.0.0-pre) one, is simply no cookie.
 */
type Ctx = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

const COOKIE = 'known_device';
const PATTERN =
  /^v2\.([^.]+)\.([A-Za-z0-9_-]{24})\.(\d{9,12})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;
const CLOCK_SKEW_SECONDS = 60;

const keyFor = (secret: string): Buffer =>
  Buffer.from(hkdfSync('sha256', secret, 'qnsc-identity', 'known-device:v2', 32));

const mac = (secret: string, input: string): Buffer =>
  createHmac('sha256', keyFor(secret)).update(input).digest();

const equal = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * `payload` + its tag for the cookie called `name`. Exported for the package's own tests, which forge
 * values (an old `iat`, another cookie's name) that only the secret's holder could sign.
 */
export function signDeviceValue(secret: string, name: string, payload: string): string {
  return `${payload}.${mac(secret, `${name}\n${payload}`).toString('base64url')}`;
}

/** What the epoch is made of, read once so a decision and the cookie it mints agree (see `bumpAndReissue`). */
export interface EpochInputs {
  userUpdatedAt: Date;
  password: string;
  credentialUpdatedAt: Date;
}

export async function readEpochInputs(ctx: Ctx, userId: string): Promise<EpochInputs | undefined> {
  const ia = ctx.context.internalAdapter;
  const [user, accounts] = await Promise.all([ia.findUserById(userId), ia.findAccounts(userId)]);
  const credential = accounts.find((a) => a.providerId === 'credential');
  if (!user || !credential) return undefined;
  return {
    userUpdatedAt: new Date(user.updatedAt),
    password: credential.password ?? '',
    credentialUpdatedAt: new Date(credential.updatedAt),
  };
}

/** Keyed fingerprint of everything that must invalidate a remembered device when it changes. */
function fingerprint(secret: string, userId: string, inputs: EpochInputs): string {
  const material = [
    userId,
    inputs.password,
    inputs.credentialUpdatedAt.toISOString(),
    inputs.userUpdatedAt.toISOString(),
  ].join('\n');
  return mac(secret, `epoch\n${material}`).subarray(0, 16).toString('base64url');
}

async function epochOf(ctx: Ctx, userId: string, known?: EpochInputs): Promise<string | undefined> {
  const inputs = known ?? (await readEpochInputs(ctx, userId));
  return inputs ? fingerprint(ctx.context.secret, userId, inputs) : undefined;
}

interface Parsed {
  userId: string;
  deviceId: string;
  iat: number;
  epoch: string;
}

async function parse(ctx: Ctx): Promise<Parsed | undefined> {
  const { name } = ctx.context.createAuthCookie(COOKIE);
  const raw = ctx.getCookie(name);
  const m = raw ? PATTERN.exec(raw) : null;
  if (!m) return undefined;
  const payload = raw!.slice(0, raw!.lastIndexOf('.'));
  const expected = mac(ctx.context.secret, `${name}\n${payload}`).toString('base64url');
  if (!equal(m[5]!, expected)) return undefined;
  return { userId: m[1]!, deviceId: m[2]!, iat: Number(m[3]), epoch: m[4]! };
}

/**
 * The device id of a known-device cookie that is valid FOR THIS USER now, else `undefined`: a forged,
 * expired, other-account or pre-password-change cookie is no cookie. `userId` is resolved lazily so a
 * request without the cookie costs no lookup.
 */
export async function knownDeviceId(
  ctx: Ctx,
  userId: () => Promise<string | undefined>,
  now: () => number = () => Math.floor(Date.now() / 1000),
): Promise<string | undefined> {
  return (await validDevice(ctx, userId, now))?.deviceId;
}

/** As {@link knownDeviceId}, with the cookie's `iat` too (a re-issue must not extend its life). */
export async function validDevice(
  ctx: Ctx,
  userId: () => Promise<string | undefined>,
  now: () => number = () => Math.floor(Date.now() / 1000),
  /** Judge the cookie against THIS snapshot of the epoch inputs instead of reading them again. */
  inputs?: EpochInputs,
): Promise<{ deviceId: string; iat: number } | undefined> {
  const device = await parse(ctx);
  if (!device) return undefined;
  const age = now() - device.iat;
  if (age > DEFAULTS.lockout.knownDevice.maxAgeSeconds || age < -CLOCK_SKEW_SECONDS)
    return undefined;
  if ((await userId()) !== device.userId) return undefined;
  const epoch = await epochOf(ctx, device.userId, inputs);
  return epoch && equal(epoch, device.epoch)
    ? { deviceId: device.deviceId, iat: device.iat }
    : undefined;
}

async function writeDevice(
  ctx: Ctx,
  userId: string,
  deviceId: string,
  iat: number,
  epochInputs?: EpochInputs,
): Promise<boolean> {
  const epoch = await epochOf(ctx, userId, epochInputs);
  if (!epoch) return false; // no password account: nothing to throttle, nothing to remember
  const cookie = ctx.context.createAuthCookie(COOKIE, {
    maxAge: DEFAULTS.lockout.knownDevice.maxAgeSeconds,
  });
  const payload = ['v2', userId, deviceId, iat, epoch].join('.');
  ctx.setCookie(
    cookie.name,
    signDeviceValue(ctx.context.secret, cookie.name, payload),
    cookie.attributes,
  );
  return true;
}

/** Set the cookie after a completed sign-in, unless this browser already has a valid one for the user. */
export async function rememberDevice(ctx: Ctx, userId: string): Promise<void> {
  if (await knownDeviceId(ctx, async () => userId)) return;
  await writeDevice(
    ctx,
    userId,
    randomBytes(18).toString('base64url'),
    Math.floor(Date.now() / 1000),
  );
}

/**
 * "Sign out OTHER sessions": bump the epoch so every other device's cookie dies, and re-issue THIS
 * browser's cookie under the new one (same device id, same original `iat`, so it neither resets its
 * per-device counter nor lives longer).
 *
 * The re-issue happens only if THIS call performed the bump. The bump is a compare-and-set on
 * `user.updatedAt` from the value `inputs` was read at; if another bump (a second concurrent "other
 * sessions", the admin's revoke-all) got there first this one re-issues nothing, and the cookie is
 * minted from `inputs` plus the value just written rather than from a fresh read, so a password change
 * that landed in between (it moves the credential part of the epoch) makes the new cookie dead on
 * arrival. Two devices racing therefore end with at most one cookie, never two.
 */
export async function bumpAndReissue(
  ctx: Ctx,
  userId: string,
  device: { deviceId: string; iat: number },
  inputs: EpochInputs,
): Promise<void> {
  const next = new Date(Math.max(Date.now(), inputs.userUpdatedAt.getTime() + 1));
  const won = await ctx.context.adapter.updateMany({
    model: 'user',
    where: [
      { field: 'id', value: userId },
      { field: 'updatedAt', value: inputs.userUpdatedAt },
    ],
    update: { updatedAt: next },
  });
  if (won === 0) {
    // Lost to another bump, which already killed the other devices. But if nothing moved (the stored
    // value has more precision than a JS Date, say) NO bump happened, and the others must still die.
    const now = await ctx.context.internalAdapter.findUserById(userId);
    if (now && new Date(now.updatedAt).getTime() === inputs.userUpdatedAt.getTime()) {
      await bumpDeviceEpoch(ctx, userId);
    }
    return;
  }
  await writeDevice(ctx, userId, device.deviceId, device.iat, { ...inputs, userUpdatedAt: next });
}

/**
 * Invalidate every remembered device of `userId` without touching the password: "sign out everywhere"
 * and the admin's revoke-all call this. It moves `user.updatedAt`, which is part of the epoch.
 */
export async function bumpDeviceEpoch(ctx: Ctx, userId: string): Promise<void> {
  await ctx.context.internalAdapter.updateUser(userId, { updatedAt: new Date() });
}
