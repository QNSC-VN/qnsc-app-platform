/**
 * Options for the Valkey/Redis client used across QNSC product backends.
 */
export interface ValkeyModuleOptions {
  /** Valkey/Redis connection URL, e.g. `redis://localhost:6379`. */
  url: string;
  /**
   * Key prefix applied to every key (namespacing, e.g. `rally:` / `opshub:`),
   * so multiple products may share a node without colliding.
   */
  keyPrefix?: string;
}

/** DI token carrying the resolved {@link ValkeyModuleOptions}. */
export const VALKEY_OPTIONS = Symbol('VALKEY_OPTIONS');
