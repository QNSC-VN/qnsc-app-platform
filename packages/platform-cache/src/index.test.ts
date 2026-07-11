import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Back the ioredis client with an in-memory mock so the service under test
// exercises real command semantics (multi/incr/expire, SET NX PX, EX) without a
// live server.
vi.mock('ioredis', async () => {
  const RedisMock = (await import('ioredis-mock')).default;
  return { default: RedisMock };
});

import { CacheModule } from './cache.module';
import { CacheService } from './cache.service';
import { CACHE_OPTIONS } from './cache.types';

function makeService(): CacheService {
  const service = new CacheService({ url: 'redis://localhost:6379', keyPrefix: 'test:' });
  service.onModuleInit();
  return service;
}

describe('CacheService', () => {
  let service: CacheService;

  beforeEach(() => {
    service = makeService();
  });

  it('stores and reads a string value with TTL', async () => {
    expect(await service.get('k')).toBeNull();
    await service.set('k', 'v', 60);
    expect(await service.get('k')).toBe('v');
  });

  it('stores and reads a JSON value', async () => {
    expect(await service.getJson('j')).toBeNull();
    await service.setJson('j', { a: 1, b: 'two' }, 60);
    expect(await service.getJson('j')).toEqual({ a: 1, b: 'two' });
  });

  it('returns null for corrupt JSON', async () => {
    await service.set('bad', 'not-json');
    expect(await service.getJson('bad')).toBeNull();
  });

  it('deletes keys', async () => {
    await service.set('d', 'v');
    await service.del('d');
    expect(await service.get('d')).toBeNull();
  });

  it('reports availability and exposes the raw client', () => {
    expect(service.redis).not.toBeNull();
    expect(() => service.instance).not.toThrow();
  });

  it('allows requests up to the limit then blocks', async () => {
    const first = await service.consumeRateLimit('login', 2, 60);
    const second = await service.consumeRateLimit('login', 2, 60);
    const third = await service.consumeRateLimit('login', 2, 60);

    expect(first.allowed).toBe(true);
    expect(first.remaining).toBe(1);
    expect(second.allowed).toBe(true);
    expect(second.remaining).toBe(0);
    expect(third.allowed).toBe(false);
    expect(third.resetAt).toBeGreaterThan(0);
  });

  it('grants a lock once and refuses a second holder until released', async () => {
    expect(await service.acquireLock('k', 1000)).toBe(true);
    expect(await service.acquireLock('k', 1000)).toBe(false);
    await service.releaseLock('k');
    expect(await service.acquireLock('k', 1000)).toBe(true);
  });
});

describe('CacheService (optional mode, disabled)', () => {
  function makeDisabled(): CacheService {
    const service = new CacheService({ mode: 'optional' });
    service.onModuleInit();
    return service;
  }

  it('degrades gracefully when no url is supplied', async () => {
    const service = makeDisabled();
    expect(service.redis).toBeNull();
    expect(service.isAvailable).toBe(false);
    expect(() => service.instance).toThrow();

    // Generic ops no-op / return empty.
    await service.set('k', 'v');
    expect(await service.get('k')).toBeNull();
    expect(await service.getJson('k')).toBeNull();
    await service.del('k');

    // Rate-limit fails open; locks refuse.
    const rl = await service.consumeRateLimit('x', 5, 60);
    expect(rl.allowed).toBe(true);
    expect(await service.acquireLock('x', 1000)).toBe(false);
  });

  it('throws in required mode when no url is supplied', () => {
    const service = new CacheService({ mode: 'required' });
    expect(() => service.onModuleInit()).toThrow();
  });
});

describe('CacheModule', () => {
  it('forRoot wires the options value and the service', () => {
    const mod = CacheModule.forRoot({ url: 'redis://localhost:6379', keyPrefix: 'rally:' });
    expect(mod.module).toBe(CacheModule);
    expect(mod.exports).toContain(CacheService);
    const optionsProvider = (mod.providers ?? []).find(
      (p): p is { provide: symbol; useValue: unknown } =>
        typeof p === 'object' && 'provide' in p && p.provide === CACHE_OPTIONS,
    );
    expect(optionsProvider?.useValue).toEqual({
      url: 'redis://localhost:6379',
      keyPrefix: 'rally:',
    });
  });

  it('forRootAsync exposes an options factory and the service', () => {
    const mod = CacheModule.forRootAsync({
      useFactory: () => ({ url: 'redis://localhost:6379' }),
    });
    expect(mod.module).toBe(CacheModule);
    expect(mod.exports).toContain(CacheService);
    const optionsProvider = (mod.providers ?? []).find(
      (p): p is { provide: symbol; useFactory: () => unknown; inject: unknown[] } =>
        typeof p === 'object' && 'provide' in p && p.provide === CACHE_OPTIONS,
    );
    expect(optionsProvider?.useFactory).toBeTypeOf('function');
  });
});
