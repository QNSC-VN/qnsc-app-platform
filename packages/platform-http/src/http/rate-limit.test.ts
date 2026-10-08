import 'reflect-metadata';
import type { CacheService } from '@quynhonsemiconductor/platform-cache';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SecurityMetrics } from '@quynhonsemiconductor/observability';
import { RateLimitedException } from '../errors';
import { RateLimitGuard } from './rate-limit.guard';
import { RATE_LIMIT_METADATA_KEY, SKIP_RATE_LIMIT_KEY } from './rate-limit.constants';

interface HeaderSink {
  headers: Record<string, string>;
}

function makeContext(req: Record<string, unknown>): {
  context: ExecutionContext;
  sink: HeaderSink;
} {
  const sink: HeaderSink = { headers: {} };
  const reply = {
    header: (name: string, value: string) => {
      sink.headers[name] = value;
    },
  };
  const context = {
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => reply,
    }),
  } as unknown as ExecutionContext;
  return { context, sink };
}

/** Reflector fake: returns the skip flag and/or tier the test wants. */
function makeReflector(values: { skip?: boolean; tier?: string }): Reflector {
  return {
    getAllAndOverride: (key: string) => {
      if (key === SKIP_RATE_LIMIT_KEY) return values.skip;
      if (key === RATE_LIMIT_METADATA_KEY) return values.tier;
      return undefined;
    },
  } as unknown as Reflector;
}

function makeValkey(result: { allowed: boolean; remaining: number; resetAt: number } | Error): {
  valkey: CacheService;
  spy: ReturnType<typeof vi.fn>;
} {
  const spy = vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  return { valkey: { consumeRateLimit: spy } as unknown as CacheService, spy };
}

describe('RateLimitGuard', () => {
  // The guard reads DISABLE_RATE_LIMIT at construction; force it off so these
  // tests exercise real limiting regardless of the ambient shell/CI env.
  beforeEach(() => {
    vi.stubEnv('DISABLE_RATE_LIMIT', '');
    vi.stubEnv('RATE_LIMIT_MODE', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('allows and sets informational headers when under the limit', async () => {
    const { valkey, spy } = makeValkey({ allowed: true, remaining: 4, resetAt: 9_999 });
    const guard = new RateLimitGuard(makeReflector({ tier: 'AUTH_LOGIN' }), valkey);
    const { context, sink } = makeContext({ ip: '1.2.3.4' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    // AUTH_LOGIN tier: 5 attempts / 15-min window, keyed by IP.
    expect(spy).toHaveBeenCalledWith('AUTH_LOGIN:ip:1.2.3.4', 5, 900);
    expect(sink.headers['RateLimit-Limit']).toBe('5');
    expect(sink.headers['RateLimit-Remaining']).toBe('4');
    expect(sink.headers['RateLimit-Reset']).toBe('9999');
  });

  it('throws RateLimitedException and sets Retry-After when over the limit', async () => {
    const resetAt = Math.floor(Date.now() / 1000) + 42;
    const { valkey } = makeValkey({ allowed: false, remaining: 0, resetAt });
    const guard = new RateLimitGuard(makeReflector({ tier: 'AUTH_LOGIN' }), valkey);
    const { context, sink } = makeContext({ ip: '1.2.3.4' });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(RateLimitedException);
    expect(Number(sink.headers['Retry-After'])).toBeGreaterThan(0);
  });

  it('keys authenticated requests by user id, not IP', async () => {
    const { valkey, spy } = makeValkey({ allowed: true, remaining: 99, resetAt: 1 });
    const guard = new RateLimitGuard(makeReflector({}), valkey); // DEFAULT tier
    const { context } = makeContext({ ip: '1.2.3.4', user: { sub: 'user-7' } });

    await guard.canActivate(context);
    expect(spy).toHaveBeenCalledWith('DEFAULT:uid:user-7', 100, 60);
  });

  it('keys AUTH_REFRESH by a hash of the refresh-token cookie', async () => {
    const { valkey, spy } = makeValkey({ allowed: true, remaining: 29, resetAt: 1 });
    const guard = new RateLimitGuard(makeReflector({ tier: 'AUTH_REFRESH' }), valkey);
    const { context } = makeContext({ ip: '1.2.3.4', cookies: { refresh_token: 'secret' } });

    await guard.canActivate(context);
    const key = spy.mock.calls[0][0] as string;
    expect(key).toMatch(/^AUTH_REFRESH:session:[0-9a-f]{32}$/);
    expect(key).not.toContain('secret');
  });

  it('falls back to IP for AUTH_REFRESH when no cookie is present', async () => {
    const { valkey, spy } = makeValkey({ allowed: true, remaining: 29, resetAt: 1 });
    const guard = new RateLimitGuard(makeReflector({ tier: 'AUTH_REFRESH' }), valkey);
    const { context } = makeContext({ ip: '9.9.9.9' });

    await guard.canActivate(context);
    expect(spy).toHaveBeenCalledWith('AUTH_REFRESH:ip:9.9.9.9', 30, 60);
  });

  it('bypasses when @SkipRateLimit() is set', async () => {
    const { valkey, spy } = makeValkey({ allowed: true, remaining: 1, resetAt: 1 });
    const guard = new RateLimitGuard(makeReflector({ skip: true }), valkey);
    const { context } = makeContext({ ip: '1.2.3.4' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it('fails open when the Valkey backend is unavailable', async () => {
    const { valkey } = makeValkey(new Error('valkey down'));
    const guard = new RateLimitGuard(makeReflector({ tier: 'AUTH_LOGIN' }), valkey);
    const { context } = makeContext({ ip: '1.2.3.4' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  // Fail-open must be visible to the alert that matches `securityFailOpen`; the shared
  // guard used to log it without the field, so a Valkey outage never reached the alert.
  it('records the fail-open metric as well as the log', async () => {
    const record = vi.spyOn(SecurityMetrics.prototype, 'recordFailOpen');
    const { valkey } = makeValkey(new Error('valkey down'));
    const guard = new RateLimitGuard(makeReflector({ tier: 'AUTH_LOGIN' }), valkey);
    const { context } = makeContext({ ip: '1.2.3.4' });

    await expect(guard.canActivate(context)).resolves.toBe(true);

    expect(record).toHaveBeenCalledWith('rate_limit');
    record.mockRestore();
  });

  it('still allows the request when recording the metric throws', async () => {
    const record = vi.spyOn(SecurityMetrics.prototype, 'recordFailOpen').mockImplementation(() => {
      throw new Error('meter exploded');
    });
    const { valkey } = makeValkey(new Error('valkey down'));
    const guard = new RateLimitGuard(makeReflector({ tier: 'AUTH_LOGIN' }), valkey);
    const { context } = makeContext({ ip: '1.2.3.4' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    record.mockRestore();
  });

  it('does not record a fail-open for a normal allowed or rejected request', async () => {
    const record = vi.spyOn(SecurityMetrics.prototype, 'recordFailOpen');
    const { valkey } = makeValkey({ allowed: true, remaining: 4, resetAt: 1 });
    const guard = new RateLimitGuard(makeReflector({}), valkey);
    await guard.canActivate(makeContext({ ip: '1.2.3.4' }).context);

    expect(record).not.toHaveBeenCalled();
    record.mockRestore();
  });

  describe('RATE_LIMIT_MODE=disabled', () => {
    it.each([
      ['RATE_LIMIT_MODE=disabled', { RATE_LIMIT_MODE: 'disabled' }],
      ['the deprecated DISABLE_RATE_LIMIT=true', { DISABLE_RATE_LIMIT: 'true' }],
    ])('allows every request without touching the cache (%s)', async (_label, env) => {
      for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
      const { valkey, spy } = makeValkey({ allowed: false, remaining: 0, resetAt: 1 });
      const guard = new RateLimitGuard(makeReflector({ tier: 'AUTH_LOGIN' }), valkey);

      await expect(guard.canActivate(makeContext({ ip: '1.2.3.4' }).context)).resolves.toBe(true);
      expect(spy).not.toHaveBeenCalled();
    });

    it('records a fail-open per request in production, and not outside it', async () => {
      const record = vi.spyOn(SecurityMetrics.prototype, 'recordFailOpen');
      vi.stubEnv('RATE_LIMIT_MODE', 'disabled');
      const { valkey } = makeValkey({ allowed: true, remaining: 1, resetAt: 1 });
      const { context } = makeContext({ ip: '1.2.3.4' });

      vi.stubEnv('NODE_ENV', 'development');
      await new RateLimitGuard(makeReflector({}), valkey).canActivate(context);
      expect(record).not.toHaveBeenCalled();

      vi.stubEnv('NODE_ENV', 'production');
      const prod = new RateLimitGuard(makeReflector({}), valkey);
      await prod.canActivate(context);
      await prod.canActivate(context);
      expect(record).toHaveBeenCalledTimes(2);
      expect(record).toHaveBeenCalledWith('rate_limit');
      record.mockRestore();
    });
  });

  it('tags the fail-open log with securityFailOpen=rate_limit', async () => {
    const { valkey } = makeValkey(new Error('valkey down'));
    const guard = new RateLimitGuard(makeReflector({ tier: 'AUTH_LOGIN' }), valkey);
    const error = vi.spyOn(
      (guard as unknown as { logger: { error: (o: unknown, m: string) => void } }).logger,
      'error',
    );
    const { context } = makeContext({ ip: '1.2.3.4' });

    await guard.canActivate(context);

    expect(error.mock.calls[0][0]).toMatchObject({ securityFailOpen: 'rate_limit' });
  });

  describe('client address', () => {
    it('keys by cf-connecting-ip, not the tunnel address in req.ip', async () => {
      const { valkey, spy } = makeValkey({ allowed: true, remaining: 4, resetAt: 1 });
      const guard = new RateLimitGuard(makeReflector({ tier: 'AUTH_LOGIN' }), valkey);
      // `req.ip` is cloudflared's address: without clientIp every user shares one bucket.
      const { context } = makeContext({
        ip: '10.42.0.9',
        headers: { 'cf-connecting-ip': '203.0.113.7' },
      });

      await guard.canActivate(context);

      expect(spy).toHaveBeenCalledWith('AUTH_LOGIN:ip:203.0.113.7', 5, 900);
    });

    it('cannot be given another bucket by a forged x-forwarded-for', async () => {
      const { valkey, spy } = makeValkey({ allowed: true, remaining: 4, resetAt: 1 });
      const guard = new RateLimitGuard(makeReflector({ tier: 'AUTH_LOGIN' }), valkey);
      const attempt = (forged: string) =>
        makeContext({
          ip: '10.42.0.9',
          headers: { 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': forged },
        }).context;

      await guard.canActivate(attempt('1.1.1.1'));
      await guard.canActivate(attempt('2.2.2.2'));

      expect(spy.mock.calls.map(([key]) => key)).toEqual([
        'AUTH_LOGIN:ip:203.0.113.7',
        'AUTH_LOGIN:ip:203.0.113.7',
      ]);
    });

    it('keys the refresh-token tier fallback by client address too', async () => {
      const { valkey, spy } = makeValkey({ allowed: true, remaining: 4, resetAt: 1 });
      const guard = new RateLimitGuard(makeReflector({ tier: 'AUTH_REFRESH' }), valkey);
      const { context } = makeContext({
        ip: '10.42.0.9',
        headers: { 'cf-connecting-ip': '203.0.113.7' },
      });

      await guard.canActivate(context);

      expect(spy).toHaveBeenCalledWith('AUTH_REFRESH:ip:203.0.113.7', 30, 60);
    });
  });
});
