/**
 * Connection mode for the shared cache primitive.
 *
 * - `required` (default): a URL must be supplied; the client connects eagerly and
 *   {@link CacheService.instance} is always available. Use when the cache is on a
 *   critical path (e.g. auth denylist) and the service must fail loudly if misconfigured.
 * - `optional`: a missing URL disables the cache gracefully (methods no-op / return
 *   empty) instead of throwing. Use when the product treats cache as best-effort and
 *   fails open when it is unavailable.
 */
export type CacheMode = 'optional' | 'required';

/**
 * Options for the shared Valkey/Redis cache primitive used across QNSC product backends.
 */
export interface CacheModuleOptions {
  /**
   * Valkey/Redis connection URL, e.g. `redis://localhost:6379`. May be omitted only
   * in `optional` mode, in which case the cache is disabled.
   */
  url?: string;
  /**
   * Key prefix applied to every key (namespacing, e.g. `rally:` / `opshub:`),
   * so multiple products may share a node without colliding.
   */
  keyPrefix?: string;
  /** Connection mode. Defaults to `required`. */
  mode?: CacheMode;
}

/** DI token carrying the resolved {@link CacheModuleOptions}. */
export const CACHE_OPTIONS = Symbol('CACHE_OPTIONS');
