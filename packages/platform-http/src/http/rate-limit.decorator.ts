import { SetMetadata, applyDecorators } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import { RATE_LIMIT_METADATA_KEY, SKIP_RATE_LIMIT_KEY } from './rate-limit.constants';
import type { RateLimitTier } from './rate-limit.constants';

/**
 * Override the default rate-limit tier on a controller or route handler.
 *
 * @example
 * // Login endpoint — 5 attempts per 15-min window
 * `@RateLimit('AUTH_LOGIN')`
 * async login(...) {}
 *
 * // Sensitive write — 20/min
 * `@RateLimit('STRICT')`
 * async deleteProject(...) {}
 */
export const RateLimit = (tier: RateLimitTier): MethodDecorator & ClassDecorator =>
  applyDecorators(
    SetMetadata(RATE_LIMIT_METADATA_KEY, tier),
    // Auto-document the 429 response in Swagger.
    ApiResponse({
      status: 429,
      description: 'Too Many Requests — rate limit exceeded. Check the Retry-After header.',
    }),
  );

/**
 * Opt a route completely out of rate limiting.
 * Use only for infrastructure endpoints (health probes, metrics scrapes).
 *
 * @example
 * `@SkipRateLimit()`
 * `@Get('healthz')`
 * healthz() { return { status: 'ok' }; }
 */
export const SkipRateLimit = (): MethodDecorator & ClassDecorator =>
  SetMetadata(SKIP_RATE_LIMIT_KEY, true);
