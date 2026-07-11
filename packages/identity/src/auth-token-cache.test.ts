import 'reflect-metadata';
import { beforeEach, describe, expect, it } from 'vitest';
import type { CacheService } from '@qnsc-vn/platform-cache';
import { AuthTokenCache } from './auth-token-cache.service';

// AuthTokenCache depends only on `CacheService.redis` (the raw ioredis client)
// and uses just set(key,val,'EX',ttl) / get / del. Back it with a tiny
// in-memory fake so the test needs no live Redis and no cross-package mock.
function makeFakeRedis() {
  const store = new Map<string, string>();
  return {
    async set(key: string, value: string) {
      store.set(key, value);
      return 'OK';
    },
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async del(...keys: string[]) {
      let n = 0;
      for (const k of keys) if (store.delete(k)) n++;
      return n;
    },
  };
}

function makeAuthCache(client: unknown): AuthTokenCache {
  return new AuthTokenCache({ redis: client } as CacheService);
}

describe('AuthTokenCache', () => {
  let authCache: AuthTokenCache;

  beforeEach(() => {
    authCache = makeAuthCache(makeFakeRedis());
  });

  it('denylists a token and reports it denied', async () => {
    expect(await authCache.isTokenDenied('jti-1')).toBe(false);
    await authCache.denylistToken('jti-1', 60);
    expect(await authCache.isTokenDenied('jti-1')).toBe(true);
  });

  it('revokes a user, then clears the revocation with unrevokeUser', async () => {
    expect(await authCache.isUserRevoked('user-1')).toBe(false);

    await authCache.revokeUser('user-1', 60);
    expect(await authCache.isUserRevoked('user-1')).toBe(true);

    await authCache.unrevokeUser('user-1');
    expect(await authCache.isUserRevoked('user-1')).toBe(false);
  });

  it('stores and reads a refresh-rotation grace payload', async () => {
    expect(await authCache.getRotationGrace('hash-1')).toBeNull();
    await authCache.storeRotationGrace('hash-1', 'payload', 60);
    expect(await authCache.getRotationGrace('hash-1')).toBe('payload');
  });
});

describe('AuthTokenCache (cache disabled)', () => {
  it('degrades gracefully: writes no-op, checks fail open', async () => {
    const authCache = makeAuthCache(null);

    await authCache.revokeUser('user-1', 60);
    expect(await authCache.isUserRevoked('user-1')).toBe(false);

    await authCache.unrevokeUser('user-1'); // must not throw
    await authCache.denylistToken('jti-1', 60);
    expect(await authCache.isTokenDenied('jti-1')).toBe(false);
  });
});
