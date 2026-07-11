/**
 * Rate limit tier definitions.
 *
 * Each tier defines a `{ limit, windowSeconds }` pair used by
 * {@link RateLimitGuard} to call `CacheService.consumeRateLimit()`. Tiers are
 * named by intent, not by numbers, so call sites read like documentation.
 *
 * Tier selection guide:
 *  - `DEFAULT`      — apply via a global `APP_GUARD` to all undecorated routes
 *  - `STRICT`       — sensitive writes (delete, member removal, etc.)
 *  - `AUTH_LOGIN`   — brute-force prevention on credential submission
 *  - `AUTH_REFRESH` — token rotation endpoint
 */

export const RATE_LIMIT_METADATA_KEY = 'qnsc:rate_limit:tier';
export const SKIP_RATE_LIMIT_KEY = 'qnsc:rate_limit:skip';

export const RATE_LIMIT_TIERS = {
  /** All routes without an explicit `@RateLimit()` decorator: 100 req/min. */
  DEFAULT: { limit: 100, windowSeconds: 60 },

  /** Sensitive write operations: 20 req/min. */
  STRICT: { limit: 20, windowSeconds: 60 },

  /**
   * Login endpoint: 5 attempts per 15 minutes per IP.
   * Stops credential-stuffing and password-spray attacks. The 15-min window
   * (vs 1-min) prevents burst-then-wait circumvention.
   */
  AUTH_LOGIN: { limit: 5, windowSeconds: 15 * 60 },

  /**
   * Token refresh: 30 req/min per session.
   *
   * Keyed by SHA-256 of the HttpOnly refresh-token cookie rather than client
   * IP, so each browser session gets its own bucket and teams behind a shared
   * corporate NAT/proxy don't exhaust each other's quota. Falls back to IP when
   * no cookie is present (unauthenticated probe).
   */
  AUTH_REFRESH: { limit: 30, windowSeconds: 60, keyBy: 'refreshToken' as const },
} as const;

export type RateLimitTier = keyof typeof RATE_LIMIT_TIERS;
