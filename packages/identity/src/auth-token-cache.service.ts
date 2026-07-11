import { Inject, Injectable } from '@nestjs/common';
import { CacheService } from '@qnsc-vn/platform-cache';

/**
 * Auth-token cache: the identity domain's policy over the shared cache primitive.
 *
 * Owns the token-lifecycle key schemes — access-token denylist, refresh-rotation
 * grace window, and user-level fast revocation — composing the generic
 * {@link CacheService} from `@qnsc-vn/platform-cache`. Keeping these semantics in
 * identity (rather than the cache package) puts token-revocation policy where the
 * bounded context that owns tokens can evolve it.
 *
 * All reads/writes go through the nullable client so the service degrades
 * gracefully when the cache is disabled (optional mode / a transient outage):
 * writes no-op and denial checks fail open, matching the "tokens still expire via
 * their JWT `exp` claim" fallback in the guards.
 */
@Injectable()
export class AuthTokenCache {
  constructor(@Inject(CacheService) private readonly cache: CacheService) {}

  // ── Access-token denylist (logout) ───────────────────────────────────────────

  async denylistToken(jti: string, ttlSeconds: number): Promise<void> {
    const client = this.cache.redis;
    if (!client) return;
    await client.set(`denylist:${jti}`, '1', 'EX', ttlSeconds);
  }

  async isTokenDenied(jti: string): Promise<boolean> {
    const client = this.cache.redis;
    if (!client) return false;
    const val = await client.get(`denylist:${jti}`);
    return val !== null;
  }

  // ── Refresh-token rotation grace window ──────────────────────────────────────
  //
  // Enables idempotent single-use refresh-token rotation. The result of a
  // successful rotation is cached briefly under the *consumed* token's hash so
  // that a benign concurrent/retried reuse (multiple tabs, a retried request
  // after a lost response, React StrictMode) can replay the same successor
  // tokens instead of tripping theft detection.

  async storeRotationGrace(
    consumedTokenHash: string,
    payload: string,
    ttlSeconds: number,
  ): Promise<void> {
    const client = this.cache.redis;
    if (!client) return;
    await client.set(`refresh:grace:${consumedTokenHash}`, payload, 'EX', ttlSeconds);
  }

  async getRotationGrace(consumedTokenHash: string): Promise<string | null> {
    const client = this.cache.redis;
    if (!client) return null;
    return client.get(`refresh:grace:${consumedTokenHash}`);
  }

  // ── User-level fast revocation ───────────────────────────────────────────────
  //
  // Used when an admin suspends / deactivates a user account. Sets a key that the
  // JWT guard checks on every request — active access tokens (up to their full
  // lifetime) are immediately invalidated without waiting for expiry.

  /**
   * Fast-revoke ALL active access tokens for a user.
   * TTL should match the longest possible access-token lifetime (JWT_ACCESS_EXPIRY).
   */
  async revokeUser(userId: string, ttlSeconds: number): Promise<void> {
    const client = this.cache.redis;
    if (!client) return;
    await client.set(`denylist:user:${userId}`, '1', 'EX', ttlSeconds);
  }

  async isUserRevoked(userId: string): Promise<boolean> {
    const client = this.cache.redis;
    if (!client) return false;
    const val = await client.get(`denylist:user:${userId}`);
    return val !== null;
  }
}
