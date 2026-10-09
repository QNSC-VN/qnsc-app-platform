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

/**
 * How the rate-limit guard gets its counters.
 *
 * - `cache` (default): counters in Valkey.
 * - `edge-only`: limits are enforced by Cloudflare rules; the application allows every
 *   request. A deliberate posture.
 * - `disabled`: no limiting at all (local development, CI). In production this is a
 *   security control switched off, and is reported as one.
 */
export type RateLimitMode = 'cache' | 'edge-only' | 'disabled';

/** How the idempotency interceptor gets its store. */
export type IdempotencyMode = 'cache' | 'disabled';

/** Mode variable for {@link RateLimitGuard}. */
export const RATE_LIMIT_MODE_ENV = 'RATE_LIMIT_MODE';

/** @deprecated Spelled `RATE_LIMIT_MODE=disabled` now; `true` is still honoured as an alias. */
export const DISABLE_RATE_LIMIT_ENV = 'DISABLE_RATE_LIMIT';

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

/**
 * Read {@link RATE_LIMIT_MODE_ENV}. Throws on an unknown value.
 *
 * Unset means `cache`, except that the deprecated `DISABLE_RATE_LIMIT=true` still means
 * `disabled`. An explicit `RATE_LIMIT_MODE` always wins over the alias, so the new
 * variable is the one place to read the answer.
 */
export function readRateLimitMode(env: NodeJS.ProcessEnv = process.env): RateLimitMode {
  const explicit = env[RATE_LIMIT_MODE_ENV]?.trim();
  const fallback: RateLimitMode = usesDeprecatedDisableAlias(env) ? 'disabled' : 'cache';
  if (explicit === undefined || explicit === '') return fallback;
  return readMode<RateLimitMode>(
    env,
    RATE_LIMIT_MODE_ENV,
    ['cache', 'edge-only', 'disabled'],
    fallback,
  );
}

/** Whether the deprecated `DISABLE_RATE_LIMIT=true` is set (to be warned about). */
export function usesDeprecatedDisableAlias(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[DISABLE_RATE_LIMIT_ENV] === 'true';
}

/**
 * What became of a `DISABLE_RATE_LIMIT=true` in the environment:
 *
 * - `unset`: not `true`, nothing to say.
 * - `honoured`: it is the reason the mode is `disabled` (no `RATE_LIMIT_MODE` set).
 * - `ignored`: `RATE_LIMIT_MODE` is set and wins, so the limiter is NOT disabled by it —
 *   the case an operator who still believes the old variable works needs to be told about.
 */
export type DisableAliasStatus = 'unset' | 'honoured' | 'ignored';

export function disableAliasStatus(env: NodeJS.ProcessEnv = process.env): DisableAliasStatus {
  if (!usesDeprecatedDisableAlias(env)) return 'unset';
  const explicit = env[RATE_LIMIT_MODE_ENV]?.trim();
  return explicit === undefined || explicit === '' ? 'honoured' : 'ignored';
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
