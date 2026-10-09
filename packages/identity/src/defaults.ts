import { AUTH_MAIL_PRIORITY } from './ports';

/**
 * The secure defaults of identity plan §5.4, in one frozen object. Products cannot change them
 * through `createIdentity` (zero product knobs, P4); the conformance kit asserts every value here
 * is still what a built instance enforces. The owner of `app-platform` approves any edit.
 */
export const DEFAULTS = Object.freeze({
  password: Object.freeze({
    /** OWASP baseline for argon2id: m = 19 MiB, t = 2, p = 1. */
    argon2: Object.freeze({ memoryCost: 19456, timeCost: 2, parallelism: 1 }),
    minLength: 12,
    maxLength: 128,
  }),
  reset: Object.freeze({ tokenTtlSeconds: 15 * 60, revokeSessions: true }),
  session: Object.freeze({
    public: Object.freeze({
      expiresInSeconds: 7 * 86400,
      updateAgeSeconds: 86400,
      cookieCache: true,
    }),
    staff: Object.freeze({
      expiresInSeconds: 12 * 3600,
      updateAgeSeconds: 3600,
      cookieCache: false,
    }),
    /** Public cookie cache window: how long a revoked session can still be believed. */
    cookieCacheSeconds: 5 * 60,
  }),
  /**
   * Sign-in and 2FA attempts (identity plan D14, review S5). Two layers, because a hard per-account
   * lock is a denial-of-service: anyone could lock any user out by guessing wrong 5 times.
   *  - per account AND client address: 5 failures in 15 minutes lock THAT address out for that account;
   *  - per account, any address: no lock, a progressive delay from the 6th attempt in the hour
   *    (200 ms per attempt over the 5th, at most 5 s), and a ceiling of 50 attempts an hour.
   * A successful sign-in, and a successful password reset, clear both.
   */
  lockout: Object.freeze({
    perAccountAndIp: Object.freeze({ maxAttempts: 5, windowSeconds: 15 * 60 }),
    perAccount: Object.freeze({
      freeAttempts: 5,
      delayStepMs: 200,
      maxDelayMs: 5000,
      ceiling: 50,
      windowSeconds: 3600,
    }),
    /**
     * A KNOWN DEVICE (OWASP): a signed, HttpOnly cookie set on a successful sign-in (see
     * `known-device.ts`: server-side expiry, bound to the credential). A request that carries a valid
     * one for the account skips the account-wide delay and ceiling (which anyone can exhaust from many
     * addresses) and is limited per device, and 20 attempts an hour across all of the account's devices.
     */
    knownDevice: Object.freeze({
      maxAgeSeconds: 90 * 24 * 3600,
      /** Per device. */
      maxAttempts: 5,
      windowSeconds: 15 * 60,
      /** All valid devices of one account together; past it a cookie is treated as absent. */
      accountMaxAttempts: 20,
      accountWindowSeconds: 3600,
    }),
  }),
  /** Reset requests and verification re-sends, per email address; over the limit is silent (D14). */
  mailPerEmail: Object.freeze({ max: 3, windowSeconds: 3600 }),
  /** Responses that must not reveal whether an address has an account take at least this long. */
  timingFloorMs: 150,
  unverifiedAccountTtlHours: 72,
  purge: Object.freeze({
    queue: 'identity.purge-unverified',
    cron: '0 * * * *',
    tz: 'Asia/Ho_Chi_Minh',
  }),
  mailPriority: AUTH_MAIL_PRIORITY,
  /** Client IP is exposed to Better Auth under this one header; the mount overwrites it. */
  clientIpHeader: 'x-qnsc-client-ip',
  encryptionKeyEnv: 'IDENTITY_ENCRYPTION_KEY',
  secretEnv: 'BETTER_AUTH_SECRET',
  ssoSecretPrefix: 'enc:v1:',
});

export type Preset = 'public' | 'staff' | 'organizations';
