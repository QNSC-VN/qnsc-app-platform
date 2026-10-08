import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dockerTestsEnabled, startValkey, type ValkeyHarness } from '@quynhonsemiconductor/testing';

import { CacheModule } from './cache.module';
import { CacheService } from './cache.service';
import { CACHE_OPTIONS } from './cache.types';

// The service runs against a REAL Valkey (packages/testing), not an in-memory double: the
// rate limiter is a Lua script and the lock is `SET NX PX`, so what is under test is the
// server's behaviour. Skipped without Docker locally; on CI a missing Docker fails the run.
const dockerEnabled = await dockerTestsEnabled();

const PREFIX = 'test:';

describe.skipIf(!dockerEnabled)('CacheService (real Valkey)', () => {
  let valkey: ValkeyHarness;
  let service: CacheService;

  beforeAll(async () => {
    valkey = await startValkey();
  }, 120_000);

  afterAll(async () => {
    await valkey?.stop();
  }, 60_000);

  beforeEach(async () => {
    await valkey.flush();
    service = new CacheService({ url: valkey.url, keyPrefix: PREFIX });
    service.onModuleInit();
  });

  afterEach(async () => {
    await service.onModuleDestroy();
  });

  it('stores and reads a string value with TTL', async () => {
    expect(await service.get('k')).toBeNull();
    await service.set('k', 'v', 60);
    expect(await service.get('k')).toBe('v');
  });

  it('applies the key prefix and the TTL on the server', async () => {
    await service.set('k', 'v', 60);
    expect(await valkey.command('GET', `${PREFIX}k`)).toBe('v');
    const ttl = Number(await valkey.command('TTL', `${PREFIX}k`));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });

  it('stores no expiry when no TTL is given', async () => {
    await service.set('forever', 'v');
    expect(await valkey.command('TTL', `${PREFIX}forever`)).toBe('-1');
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

  it('reports availability and exposes the raw client', async () => {
    expect(service.redis).not.toBeNull();
    expect(() => service.instance).not.toThrow();
    await service.get('warm-up'); // a command resolves only once the connection is ready
    expect(service.isAvailable).toBe(true);
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

  it('admits exactly `limit` of many concurrent requests (the Lua script is atomic)', async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, () => service.consumeRateLimit('burst', 3, 60)),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(3);
  });

  it('frees a slot once the window has passed', async () => {
    expect((await service.consumeRateLimit('slide', 1, 1)).allowed).toBe(true);
    expect((await service.consumeRateLimit('slide', 1, 1)).allowed).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect((await service.consumeRateLimit('slide', 1, 1)).allowed).toBe(true);
  });

  it('grants a lock once and refuses a second holder until released', async () => {
    expect(await service.acquireLock('k', 1000)).toBe(true);
    expect(await service.acquireLock('k', 1000)).toBe(false);
    await service.releaseLock('k');
    expect(await service.acquireLock('k', 1000)).toBe(true);
  });

  it('expires a lock on its own so a crashed holder cannot deadlock it', async () => {
    expect(await service.acquireLock('ttl', 300)).toBe(true);
    const pttl = Number(await valkey.command('PTTL', `${PREFIX}lock:ttl`));
    expect(pttl).toBeGreaterThan(0);
    expect(pttl).toBeLessThanOrEqual(300);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await service.acquireLock('ttl', 300)).toBe(true);
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
