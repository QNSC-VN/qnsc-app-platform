import 'reflect-metadata';
import type { CacheService } from '@quynhonsemiconductor/platform-cache';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import {
  RequestContextService,
  requestContextStorage,
  type RequestContext,
} from './request-context.service';
import { HttpLoggingInterceptor } from './http-logging.interceptor';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import { PROBE_PATHS } from '@quynhonsemiconductor/observability';

function makeHttpContext(req: Record<string, unknown>, statusCode = 200): ExecutionContext {
  return {
    getType: () => 'http',
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => ({ statusCode }),
    }),
  } as unknown as ExecutionContext;
}

function makeHandler<T>(value: T, spy?: () => void): CallHandler {
  return {
    handle: () => {
      spy?.();
      return of(value);
    },
  } as CallHandler;
}

describe('RequestContextService', () => {
  const svc = new RequestContextService();
  const base: RequestContext = {
    workspaceId: undefined,
    userId: undefined,
    sessionId: undefined,
    correlationId: 'corr-1',
    traceparent: undefined,
  };

  it('runs a function within a context and exposes getters', () => {
    const result = svc.run({ ...base }, () => {
      expect(svc.getCorrelationId()).toBe('corr-1');
      expect(svc.get()).toBeDefined();
      expect(requestContextStorage.getStore()?.correlationId).toBe('corr-1');
      return 42;
    });
    expect(result).toBe(42);
    // Outside the run scope there is no context.
    expect(svc.get()).toBeUndefined();
  });

  it('getOrThrow throws outside a context', () => {
    expect(() => svc.getOrThrow()).toThrow('No request context');
  });

  it('setAuthContext mutates the active context', () => {
    svc.run({ ...base }, () => {
      svc.setAuthContext('ws-9', 'user-9', 'sess-9');
      expect(svc.getWorkspaceId()).toBe('ws-9');
      expect(svc.getUserId()).toBe('user-9');
      expect(svc.get()?.sessionId).toBe('sess-9');
    });
  });
});

describe('HttpLoggingInterceptor', () => {
  it('passes through non-http contexts', async () => {
    const interceptor = new HttpLoggingInterceptor();
    const ctx = { getType: () => 'rpc' } as unknown as ExecutionContext;
    let called = false;
    const out = await lastValueFrom(
      interceptor.intercept(
        ctx,
        makeHandler('ok', () => (called = true)),
      ),
    );
    expect(called).toBe(true);
    expect(out).toBe('ok');
  });

  it('skips access logs for configured paths', async () => {
    const interceptor = new HttpLoggingInterceptor({ skipPaths: ['/health'] });
    const ctx = makeHttpContext({ method: 'GET', url: '/health', headers: {} });
    const out = await lastValueFrom(interceptor.intercept(ctx, makeHandler('ok')));
    expect(out).toBe('ok');
  });

  // Every probe path the tracing hook ignores must also be absent from access logs —
  // both derive from observability's PROBE_PATHS. `/livez` is the kubelet's liveness path.
  it.each([...PROBE_PATHS, '/favicon.ico', '/livez?verbose=1'])(
    'does not log the probe path %s by default',
    async (url) => {
      const interceptor = new HttpLoggingInterceptor();
      const logSpy = vi.spyOn(
        (interceptor as unknown as { logger: { log: () => void } }).logger,
        'log',
      );
      const ctx = makeHttpContext({ method: 'GET', url, headers: {} }, 200);
      await lastValueFrom(interceptor.intercept(ctx, makeHandler('ok')));
      expect(logSpy).not.toHaveBeenCalled();
    },
  );

  it('still logs a route that merely starts with a probe path', async () => {
    const interceptor = new HttpLoggingInterceptor();
    const logSpy = vi.spyOn(
      (interceptor as unknown as { logger: { log: () => void } }).logger,
      'log',
    );
    const ctx = makeHttpContext({ method: 'GET', url: '/livez/deep', headers: {} }, 200);
    await lastValueFrom(interceptor.intercept(ctx, makeHandler('ok')));
    expect(logSpy).toHaveBeenCalledTimes(1);
  });

  it('logs the client address from cf-connecting-ip, ignoring a forged x-forwarded-for', async () => {
    const interceptor = new HttpLoggingInterceptor();
    const logSpy = vi.spyOn(
      (interceptor as unknown as { logger: { log: (o: unknown) => void } }).logger,
      'log',
    );
    const ctx = makeHttpContext(
      {
        method: 'GET',
        url: '/v1/things',
        ip: '10.42.0.9',
        headers: { 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '1.1.1.1' },
      },
      200,
    );
    await lastValueFrom(interceptor.intercept(ctx, makeHandler('ok')));
    expect(logSpy.mock.calls[0][0]).toMatchObject({ ip: '203.0.113.7' });
  });

  it('logs one line on success', async () => {
    const interceptor = new HttpLoggingInterceptor();
    const logSpy = vi.spyOn(
      (interceptor as unknown as { logger: { log: () => void } }).logger,
      'log',
    );
    const ctx = makeHttpContext(
      { method: 'GET', url: '/v1/things', headers: { 'x-correlation-id': 'c1' } },
      200,
    );
    await lastValueFrom(interceptor.intercept(ctx, makeHandler('ok')));
    expect(logSpy).toHaveBeenCalledTimes(1);
  });
});

describe('IdempotencyInterceptor', () => {
  function fakeValkey(overrides?: {
    get?: ReturnType<typeof vi.fn>;
    set?: ReturnType<typeof vi.fn>;
  }): { svc: CacheService; get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> } {
    const get = overrides?.get ?? vi.fn().mockResolvedValue(null);
    const set = overrides?.set ?? vi.fn().mockResolvedValue('OK');
    return { svc: { instance: { get, set } } as unknown as CacheService, get, set };
  }

  it('passes through non-idempotent methods without touching the cache', async () => {
    const { svc, get } = fakeValkey();
    const interceptor = new IdempotencyInterceptor(svc);
    const ctx = makeHttpContext({
      method: 'GET',
      url: '/v1/x',
      headers: { 'idempotency-key': 'k' },
    });
    const out = await lastValueFrom(interceptor.intercept(ctx, makeHandler('fresh')));
    expect(out).toBe('fresh');
    expect(get).not.toHaveBeenCalled();
  });

  it('passes through when the Idempotency-Key header is missing', async () => {
    const { svc, get } = fakeValkey();
    const interceptor = new IdempotencyInterceptor(svc);
    const ctx = makeHttpContext({ method: 'POST', url: '/v1/x', headers: {} });
    const out = await lastValueFrom(interceptor.intercept(ctx, makeHandler('fresh')));
    expect(out).toBe('fresh');
    expect(get).not.toHaveBeenCalled();
  });

  it('returns the cached response on a hit and does not execute the handler', async () => {
    const { svc } = fakeValkey({ get: vi.fn().mockResolvedValue(JSON.stringify({ ok: 1 })) });
    const interceptor = new IdempotencyInterceptor(svc);
    const ctx = makeHttpContext({
      method: 'POST',
      url: '/v1/x',
      headers: { 'idempotency-key': 'k' },
      user: { sub: 'u1' },
    });
    let executed = false;
    const out = await lastValueFrom(
      interceptor.intercept(
        ctx,
        makeHandler('fresh', () => (executed = true)),
      ),
    );
    expect(out).toEqual({ ok: 1 });
    expect(executed).toBe(false);
  });

  it('executes and caches the response on a miss', async () => {
    const { svc, set } = fakeValkey();
    const interceptor = new IdempotencyInterceptor(svc);
    const ctx = makeHttpContext({
      method: 'POST',
      url: '/v1/x',
      headers: { 'idempotency-key': 'k' },
      user: { sub: 'u1' },
    });
    const out = await lastValueFrom(interceptor.intercept(ctx, makeHandler({ created: true })));
    expect(out).toEqual({ created: true });
    expect(set).toHaveBeenCalledWith(
      'idem:u1:POST:/v1/x:k',
      JSON.stringify({ created: true }),
      'EX',
      24 * 60 * 60,
    );
  });
});
