/**
 * `@qnsc/platform-cache`
 *
 * Shared Valkey/Redis cache service (ioredis wrapper, key-prefix, fail-open)
 * for QNSC product backends.
 *
 * The concrete `CacheService` / `ValkeyService` implementation is extracted from
 * the product repos in **Phase 2** of the Identity Platform Migration Plan. This
 * Phase 1 skeleton exists to establish the publishable package and its release
 * pipeline.
 */
export const PACKAGE_NAME = '@qnsc/platform-cache';
