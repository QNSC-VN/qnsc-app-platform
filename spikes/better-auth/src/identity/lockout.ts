import { createHash } from 'node:crypto';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import type { BetterAuthPlugin } from 'better-auth';

export interface LockoutPolicy {
  /** Attempts allowed per window, per account. */
  maxAttempts: number;
  /** Window, seconds. */
  windowSeconds: number;
}

export const DEFAULT_LOCKOUT: LockoutPolicy = { maxAttempts: 5, windowSeconds: 15 * 60 };

const key = (email: string): string =>
  `lockout:${createHash('sha256').update(email.trim().toLowerCase()).digest('hex')}`;

/**
 * Per-ACCOUNT sign-in lockout. Better Auth 1.7 rate-limits per `IP|path` only (see
 * `api/rate-limiter`), so a botnet guessing one account's password from many addresses is never
 * throttled by the built-in limiter. This counts every `/sign-in/email` attempt against the
 * email address (known or not, so unknown and known accounts behave identically), refuses past
 * the limit, and forgets the count on a successful sign-in.
 *
 * Counting BEFORE the attempt with an atomic `increment` — rather than after a failure — keeps
 * the bound exact under concurrency: N parallel guesses cannot all slip through before the first
 * failure is recorded.
 */
export function accountLockout(policy: LockoutPolicy = DEFAULT_LOCKOUT): BetterAuthPlugin {
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
            const attempts = await storage.increment(key(email), policy.windowSeconds);
            if (attempts > policy.maxAttempts) {
              throw APIError.from('TOO_MANY_REQUESTS', {
                code: 'ACCOUNT_LOCKED',
                message: 'Too many sign-in attempts. Try again later.',
              });
            }
          }),
        },
      ],
      after: [
        {
          matcher: (ctx) => ctx.path === '/sign-in/email',
          handler: createAuthMiddleware(async (ctx) => {
            const email = (ctx.body as { email?: unknown } | undefined)?.email;
            const storage = ctx.context.secondaryStorage;
            if (typeof email !== 'string' || !storage) return;
            const returned = ctx.context.returned;
            if (!(returned instanceof Error)) await storage.delete(key(email));
          }),
        },
      ],
    },
  };
}
