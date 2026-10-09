import type { BetterAuthOptions } from 'better-auth';
import type { CacheService } from '@quynhonsemiconductor/platform-cache';

/** `SecondaryStorage` is not re-exported by `better-auth`; derive it from the options type. */
type SecondaryStorage = NonNullable<BetterAuthOptions['secondaryStorage']>;

/** Called when Valkey fails and the adapter degrades instead of throwing. */
export type StorageDegraded = (operation: string, error: unknown) => void;

/** KEYS[1] counter, ARGV[1] ttl seconds. TTL is applied on creation only, as Better Auth requires. */
const INCREMENT_LUA = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1])) end
return n`;

/**
 * Better Auth `secondaryStorage` over the shared `platform-cache` client (Valkey).
 *
 * Better Auth 1.7 needs FIVE operations, not the three the identity plan assumed:
 * `get`, `set`, `delete` plus ATOMIC `getAndDelete` and `increment` (rate limiting on secondary
 * storage refuses to start without `increment`). `CacheService` offers neither, so those two go
 * through its raw client — keyPrefix still applies to them, because ioredis prefixes `GETDEL`
 * and the KEYS of `EVAL`.
 *
 * Failure policy (decided here, not by Better Auth, which simply propagates a rejected promise
 * and so turns a Valkey outage into a 500 on every request):
 *  - reads/writes/deletes degrade to "absent"/no-op, so sessions fall back to the database
 *    (`session.storeSessionInDatabase`), and the caller is told through `onDegraded`;
 *  - `increment` degrades to `0` — the rate limiter ADMITS the request. That is fail-OPEN for
 *    rate limiting, deliberately: the alternative locks every user out when the cache blips.
 */
export function valkeySecondaryStorage(
  cache: CacheService,
  onDegraded: StorageDegraded = () => undefined,
): SecondaryStorage {
  const guard = async <T>(op: string, fallback: T, fn: () => Promise<T>): Promise<T> => {
    // Short-circuit on the cache's own readiness, the convention platform-cache documents
    // ("callers short-circuit on `isAvailable`"). Measured without it, against a refused port:
    // every storage call blocks on ioredis' offline queue for seconds, and one sign-in makes
    // several, so an outage turned a ~15 ms sign-in into a multi-second one.
    if (!cache.isAvailable) {
      onDegraded(op, new Error('cache not ready'));
      return fallback;
    }
    try {
      return await fn();
    } catch (error) {
      onDegraded(op, error);
      return fallback;
    }
  };

  return {
    get: (key) => guard('get', null, () => cache.get(key)),
    set: (key, value, ttl) =>
      guard('set', undefined, async () => {
        await cache.set(key, value, ttl);
      }),
    delete: (key) =>
      guard('delete', undefined, async () => {
        await cache.del(key);
      }),
    getAndDelete: (key) => guard('getAndDelete', null, () => cache.instance.getdel(key)),
    increment: (key, ttl) =>
      guard('increment', 0, async () => {
        return Number(await cache.instance.eval(INCREMENT_LUA, 1, key, String(ttl)));
      }),
  };
}
