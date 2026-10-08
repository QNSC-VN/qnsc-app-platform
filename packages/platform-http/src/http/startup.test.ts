import 'reflect-metadata';
import { Controller, Logger, Module, Post, type INestApplicationContext } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, NestFactory } from '@nestjs/core';
import { SecurityMetrics } from '@quynhonsemiconductor/observability';
import { CacheModule, CacheService } from '@quynhonsemiconductor/platform-cache';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IdempotencyInterceptor, UseIdempotency } from './idempotency.interceptor';
import { RateLimitGuard } from './rate-limit.guard';

/**
 * Real Nest bootstrap, not constructor calls: the production check runs in
 * `onApplicationBootstrap`, so what matters is that Nest actually calls it — for a global
 * guard, a global interceptor AND a per-route `@UseIdempotency()` — and that a throw
 * there stops the application from starting.
 */

/** `CacheModule` exactly as a product with no Valkey would configure it. */
const NO_CACHE = CacheModule.forRoot({ mode: 'optional' });

/** A product with a cache: the real token, with a client present. */
const WITH_CACHE = {
  module: class WithCacheModule {},
  global: true,
  providers: [{ provide: CacheService, useValue: { redis: {}, instance: {} } }],
  exports: [CacheService],
};

const contexts: INestApplicationContext[] = [];

async function boot(
  cache: typeof NO_CACHE | typeof WITH_CACHE,
  providers: unknown[],
  controllers: unknown[] = [],
): Promise<INestApplicationContext> {
  @Module({
    imports: [cache],
    providers: providers as never[],
    controllers: controllers as never[],
  })
  class TestModule {}

  const context = await NestFactory.createApplicationContext(TestModule, {
    logger: false,
    // Nest's default on a failed bootstrap is process.abort() — exactly what production
    // wants (the pod crash-loops instead of serving without a limiter). Here it would
    // kill the test worker, so ask for the rejection instead.
    abortOnError: false,
  });
  contexts.push(context);
  return context;
}

const rateLimitGuard = [{ provide: APP_GUARD, useClass: RateLimitGuard }];
const idempotencyGlobal = [{ provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor }];

@Controller()
class PerRouteController {
  @Post('x')
  @UseIdempotency()
  create(): string {
    return 'ok';
  }
}

describe('production startup without a cache', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('DISABLE_RATE_LIMIT', '');
    vi.stubEnv('RATE_LIMIT_MODE', '');
    vi.stubEnv('IDEMPOTENCY_MODE', '');
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(contexts.splice(0).map((c) => c.close()));
  });

  it('refuses to start with the rate-limit guard', async () => {
    await expect(boot(NO_CACHE, rateLimitGuard)).rejects.toThrow(
      /RateLimitGuard needs a cache.*RATE_LIMIT_MODE=edge-only/s,
    );
  });

  it('refuses to start with a global idempotency interceptor', async () => {
    await expect(boot(NO_CACHE, idempotencyGlobal)).rejects.toThrow(
      /IdempotencyInterceptor needs a cache.*IDEMPOTENCY_MODE=disabled/s,
    );
  });

  it('refuses to start when idempotency is applied to one route only', async () => {
    // @UseIdempotency() instantiates the interceptor as an injectable of the controller
    // module; its startup check must still run.
    await expect(boot(NO_CACHE, [], [PerRouteController])).rejects.toThrow(
      /IdempotencyInterceptor needs a cache/,
    );
  });

  it('starts with RATE_LIMIT_MODE=edge-only, and the guard then allows everything', async () => {
    vi.stubEnv('RATE_LIMIT_MODE', 'edge-only');
    // Registered by class (not APP_GUARD) so the test can fetch the instance; the
    // bootstrap hook runs the same way for both.
    const context = await boot(NO_CACHE, [RateLimitGuard]);
    const guard = context.get(RateLimitGuard);

    await expect(guard.canActivate({} as never)).resolves.toBe(true);
  });

  describe('RATE_LIMIT_MODE=disabled in production', () => {
    it.each([
      ['RATE_LIMIT_MODE=disabled', { RATE_LIMIT_MODE: 'disabled' }, false],
      ['the deprecated DISABLE_RATE_LIMIT=true', { DISABLE_RATE_LIMIT: 'true' }, true],
    ])(
      'starts without a cache, warns with securityFailOpen and records a fail-open (%s)',
      async (_label, env, deprecated) => {
        for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
        const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        const record = vi.spyOn(SecurityMetrics.prototype, 'recordFailOpen');

        await expect(boot(NO_CACHE, rateLimitGuard)).resolves.toBeDefined();

        expect(record).toHaveBeenCalledWith('rate_limit');
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({ securityFailOpen: 'rate_limit' }),
          expect.stringContaining('does not rate limit'),
        );
        const deprecations = warn.mock.calls.filter(([m]) =>
          String(m).includes('DISABLE_RATE_LIMIT is deprecated'),
        );
        expect(deprecations).toHaveLength(deprecated ? 1 : 0);
        warn.mockRestore();
        record.mockRestore();
      },
    );

    it('outside production it starts quietly: no fail-open warning, no metric', async () => {
      vi.stubEnv('NODE_ENV', 'development');
      vi.stubEnv('RATE_LIMIT_MODE', 'disabled');
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const record = vi.spyOn(SecurityMetrics.prototype, 'recordFailOpen');

      await boot(NO_CACHE, rateLimitGuard);

      expect(record).not.toHaveBeenCalled();
      // (CacheModule's own "cache disabled" warning is expected and unrelated.)
      expect(
        warn.mock.calls.filter(([m]) => /securityFailOpen|rate limit/.test(JSON.stringify(m))),
      ).toEqual([]);
      warn.mockRestore();
      record.mockRestore();
    });
  });

  it('starts with IDEMPOTENCY_MODE=disabled, and the interceptor passes requests through', async () => {
    vi.stubEnv('IDEMPOTENCY_MODE', 'disabled');
    const context = await boot(NO_CACHE, [IdempotencyInterceptor]);
    const interceptor = context.get(IdempotencyInterceptor);
    let handled = false;

    interceptor.intercept(
      { getType: () => 'http' } as never,
      { handle: () => ((handled = true), undefined as never) } as never,
    );
    expect(handled).toBe(true);
  });

  it('starts with both opt-outs when they are registered as APP_GUARD / APP_INTERCEPTOR', async () => {
    vi.stubEnv('RATE_LIMIT_MODE', 'edge-only');
    vi.stubEnv('IDEMPOTENCY_MODE', 'disabled');
    await expect(boot(NO_CACHE, [...rateLimitGuard, ...idempotencyGlobal])).resolves.toBeDefined();
  });

  it('starts when a cache is configured', async () => {
    await expect(
      boot(WITH_CACHE, [...rateLimitGuard, ...idempotencyGlobal]),
    ).resolves.toBeDefined();
  });

  it('refuses to start on an unknown mode instead of guessing', async () => {
    vi.stubEnv('RATE_LIMIT_MODE', 'edge_only');
    await expect(boot(WITH_CACHE, rateLimitGuard)).rejects.toThrow(/RATE_LIMIT_MODE/);
  });
});

describe('outside production', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('DISABLE_RATE_LIMIT', '');
    vi.stubEnv('RATE_LIMIT_MODE', '');
    vi.stubEnv('IDEMPOTENCY_MODE', '');
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(contexts.splice(0).map((c) => c.close()));
  });

  it('starts without a cache, as local development and CI do', async () => {
    await expect(boot(NO_CACHE, [...rateLimitGuard, ...idempotencyGlobal])).resolves.toBeDefined();
  });
});
