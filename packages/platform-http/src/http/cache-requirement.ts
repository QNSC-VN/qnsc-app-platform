import type { CacheService } from '@quynhonsemiconductor/platform-cache';

/**
 * Startup rules for the two features that are only as good as their cache.
 *
 * `CacheService` in `optional` mode with no URL disables itself, and everything that
 * leans on it then degrades *quietly*: the rate-limit guard allows every request, the
 * idempotency interceptor stores nothing. On EKS that was the default and nobody saw it.
 * In production that quiet state is now an error at startup, unless the deployment says
 * out loud that it means it.
 */

/** How the rate-limit guard gets its counters. */
export type RateLimitMode = 'cache' | 'edge-only';

/** How the idempotency interceptor gets its store. */
export type IdempotencyMode = 'cache' | 'disabled';

/** Opt-out variable for {@link RateLimitGuard}: `edge-only` = Cloudflare rules only. */
export const RATE_LIMIT_MODE_ENV = 'RATE_LIMIT_MODE';

/** Opt-out variable for {@link IdempotencyInterceptor}: `disabled`. */
export const IDEMPOTENCY_MODE_ENV = 'IDEMPOTENCY_MODE';

function readMode<T extends string>(
  env: NodeJS.ProcessEnv,
  name: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  if ((allowed as readonly string[]).includes(raw)) return raw as T;
  // A typo must not quietly become the default: `edge_only` silently meaning "cache"
  // would either crash a deploy for the wrong reason or hide the intent.
  throw new Error(
    `${name}=${JSON.stringify(raw)} is not valid; expected one of: ${allowed.join(', ')}.`,
  );
}

/** Read {@link RATE_LIMIT_MODE_ENV}. Unset means `cache`. Throws on an unknown value. */
export function readRateLimitMode(env: NodeJS.ProcessEnv = process.env): RateLimitMode {
  return readMode<RateLimitMode>(env, RATE_LIMIT_MODE_ENV, ['cache', 'edge-only'], 'cache');
}

/** Read {@link IDEMPOTENCY_MODE_ENV}. Unset means `cache`. Throws on an unknown value. */
export function readIdempotencyMode(env: NodeJS.ProcessEnv = process.env): IdempotencyMode {
  return readMode<IdempotencyMode>(env, IDEMPOTENCY_MODE_ENV, ['cache', 'disabled'], 'cache');
}

/**
 * Throw when `NODE_ENV=production` and the cache has no client — i.e. `CacheModule` was
 * configured in `optional` mode with no URL. (`required` mode already throws on its own.)
 *
 * Call it from `onApplicationBootstrap`, not a constructor: the client is created in
 * `CacheService.onModuleInit`, which has completed for every module by then.
 *
 * @param feature   What needs the cache, for the message.
 * @param optOut    The exact setting that makes the absence deliberate.
 */
export function assertCacheInProduction(
  cache: Pick<CacheService, 'redis'>,
  feature: string,
  optOut: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env['NODE_ENV'] !== 'production') return;
  if (cache.redis) return;

  throw new Error(
    `${feature} needs a cache, but NODE_ENV=production and CacheModule has no connection url ` +
      `(optional mode). Without one the feature silently does nothing. ` +
      `Configure the cache, or set ${optOut} to run without it on purpose.`,
  );
}
