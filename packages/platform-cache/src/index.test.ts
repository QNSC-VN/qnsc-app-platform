import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Back the ioredis client with an in-memory mock so the service under test
// exercises real command semantics (multi/incr/expire, SET NX PX, EX) without a
// live server.
vi.mock('ioredis', async () => {
  const RedisMock = (await import('ioredis-mock')).default;
  return { default: RedisMock };
});

import { CacheModule } from './valkey.module';
import { ValkeyService } from './valkey.service';
import { VALKEY_OPTIONS } from './valkey.types';

function makeService(): ValkeyService {
  const service = new ValkeyService({ url: 'redis://localhost:6379', keyPrefix: 'test:' });
  service.onModuleInit();
  return service;
}

describe('ValkeyService', () => {
  let service: ValkeyService;

  beforeEach(() => {
    service = makeService();
  });

  it('denylists a token and reports it as denied', async () => {
    expect(await service.isTokenDenied('jti-1')).toBe(false);
    await service.denylistToken('jti-1', 60);
    expect(await service.isTokenDenied('jti-1')).toBe(true);
  });

  it('stores and replays a rotation-grace payload', async () => {
    expect(await service.getRotationGrace('hash-1')).toBeNull();
    await service.storeRotationGrace('hash-1', 'payload', 30);
    expect(await service.getRotationGrace('hash-1')).toBe('payload');
  });

  it('fast-revokes a user', async () => {
    expect(await service.isUserRevoked('user-1')).toBe(false);
    await service.revokeUser('user-1', 900);
    expect(await service.isUserRevoked('user-1')).toBe(true);
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

describe('CacheModule', () => {
  it('forRoot wires the options value and the service', () => {
    const mod = CacheModule.forRoot({ url: 'redis://localhost:6379', keyPrefix: 'rally:' });
    expect(mod.module).toBe(CacheModule);
    expect(mod.exports).toContain(ValkeyService);
    const optionsProvider = (mod.providers ?? []).find(
      (p): p is { provide: symbol; useValue: unknown } =>
        typeof p === 'object' && 'provide' in p && p.provide === VALKEY_OPTIONS,
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
    expect(mod.exports).toContain(ValkeyService);
    const optionsProvider = (mod.providers ?? []).find(
      (p): p is { provide: symbol; useFactory: () => unknown; inject: unknown[] } =>
        typeof p === 'object' && 'provide' in p && p.provide === VALKEY_OPTIONS,
    );
    expect(optionsProvider?.useFactory).toBeTypeOf('function');
  });
});
