import { Global, Injectable, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { CanActivate } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { CacheModule } from '@quynhonsemiconductor/platform-cache';
import { DatabaseModule } from '@quynhonsemiconductor/platform-db/nest';
import {
  dockerTestsEnabled,
  startPostgres,
  startValkey,
  type PostgresHarness,
  type ValkeyHarness,
} from '@quynhonsemiconductor/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from '../testing/app';
import {
  enableHealth,
  healthRegistryOf,
  LEGACY_LIVENESS_PATH,
  LEGACY_READINESS_PATH,
  LIVENESS_PATH,
  READINESS_DEADLINE_MS,
  READINESS_PATH,
} from './index';

/** A product's global auth guard: denies everything, as a real one does without `@Public()`. */
@Injectable()
class DenyAllGuard implements CanActivate {
  canActivate(): boolean {
    return false;
  }
}

@Module({ providers: [{ provide: APP_GUARD, useClass: DenyAllGuard }] })
class GuardedModule {}

@Global()
@Module({})
class Empty {}

const open: NestFastifyApplication[] = [];
async function start(
  module: Parameters<typeof createTestApp>[0] = Empty,
  options?: Parameters<typeof enableHealth>[1],
  prefix?: string,
) {
  const app = await createTestApp(module, (a) => {
    if (prefix) a.setGlobalPrefix(prefix, { exclude: [] });
  });
  const registry = enableHealth(app, options);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  open.push(app);
  return { app, registry };
}
const get = (app: NestFastifyApplication, url: string) => app.inject({ method: 'GET', url });

afterEach(async () => {
  await Promise.allSettled(open.splice(0).map((a) => a.close()));
});

describe('the paths are the contract with the chart and the admission policy', () => {
  it('liveness is exactly /livez and readiness defaults to /readyz', () => {
    // gitops/platform/policy/admission.yaml denies any liveness path that is not '/livez';
    // charts/qnsc-service/values.yaml defaults readiness to '/readyz'.
    expect(LIVENESS_PATH).toBe('/livez');
    expect(READINESS_PATH).toBe('/readyz');
    expect(LEGACY_LIVENESS_PATH).toBe('/v1/healthz');
    expect(LEGACY_READINESS_PATH).toBe('/v1/readyz');
  });
});

describe('GET /livez', () => {
  it('answers 200 with no checks and no dependency', async () => {
    const { app } = await start();
    const res = await get(app, '/livez');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('stays 200 when every readiness check is down: liveness must never touch a dependency', async () => {
    const { app } = await start(Empty, {
      checks: { broken: () => Promise.reject(new Error('database is on fire')) },
    });
    expect((await get(app, '/readyz')).statusCode).toBe(503);
    expect((await get(app, '/livez')).statusCode).toBe(200);
  });

  it('stays 200 once shutdown has begun, for as long as the server is listening (the endpoint delay)', async () => {
    const { app, registry } = await start();
    registry.beginShutdown();
    expect((await get(app, '/livez')).statusCode).toBe(200);
  });

  it('is served UNPREFIXED even when the product sets a global prefix', async () => {
    const { app } = await start(Empty, undefined, 'v1');
    expect((await get(app, '/livez')).statusCode).toBe(200);
    expect((await get(app, '/readyz')).statusCode).toBe(200);
  });

  it('is not behind the product global guard (which has no way to know it should let the kubelet in)', async () => {
    const { app } = await start(GuardedModule);
    expect((await get(app, '/livez')).statusCode).toBe(200);
    expect((await get(app, '/readyz')).statusCode).toBe(200);
  });

  it('keeps /v1/healthz for the ALB target group and the Dockerfile HEALTHCHECK', async () => {
    const { app } = await start();
    const res = await get(app, '/v1/healthz');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });
});

describe('GET /readyz', () => {
  it('is 200 with no checks registered', async () => {
    const { app } = await start();
    const res = await get(app, '/readyz');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', shuttingDown: false, checks: {} });
  });

  it('runs every registered check and is 200 when all are up', async () => {
    const ran: string[] = [];
    const { app } = await start(Empty, {
      checks: {
        a: () => Promise.resolve(void ran.push('a')),
        b: () => Promise.resolve(void ran.push('b')),
      },
    });
    const res = await get(app, '/readyz');
    expect(res.statusCode).toBe(200);
    expect(res.json().checks).toEqual({ a: 'up', b: 'up' });
    expect(ran.sort()).toEqual(['a', 'b']);
  });

  it('is 503 naming the failing check, and still reports the healthy ones', async () => {
    const { app } = await start(Empty, {
      checks: { good: () => Promise.resolve(), bad: () => Promise.reject(new Error('nope')) },
    });
    const res = await get(app, '/readyz');
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      status: 'error',
      shuttingDown: false,
      checks: { good: 'up', bad: 'down' },
    });
  });

  it('recovers: the same endpoint goes back to 200 when the dependency does', async () => {
    let healthy = false;
    const { app } = await start(Empty, {
      checks: { flaky: () => (healthy ? Promise.resolve() : Promise.reject(new Error('down'))) },
    });
    expect((await get(app, '/readyz')).statusCode).toBe(503);
    healthy = true;
    expect((await get(app, '/readyz')).statusCode).toBe(200);
  });

  it('never leaks the cause: the endpoint is unauthenticated', async () => {
    const { app } = await start(Empty, {
      checks: {
        db: () =>
          Promise.reject(
            new Error('Password authentication failed for pg-rova-rw as role "rova_app"'),
          ),
      },
    });
    const body = (await get(app, '/readyz')).body;
    expect(body).not.toMatch(/pg-rova-rw|rova_app|Password/i);
  });

  it(`answers inside the kubelet's 1 s probe timeout when a dependency hangs (${READINESS_DEADLINE_MS} ms deadline)`, async () => {
    const { app } = await start(Empty, {
      checks: {
        hung: () => new Promise<void>(() => undefined),
        fine: () => Promise.resolve(),
      },
    });
    const startedAt = Date.now();
    const res = await get(app, '/readyz');
    const took = Date.now() - startedAt;

    expect(res.statusCode).toBe(503);
    expect(res.json().checks).toEqual({ hung: 'down', fine: 'up' });
    expect(took).toBeGreaterThanOrEqual(READINESS_DEADLINE_MS - 50);
    expect(took).toBeLessThan(1000);
  });

  it('is 503 as soon as shutdown begins, without running any check', async () => {
    let calls = 0;
    const { app, registry } = await start(Empty, {
      checks: { counted: () => Promise.resolve(void calls++) },
    });
    expect((await get(app, '/readyz')).statusCode).toBe(200);
    expect(calls).toBe(1);

    registry.beginShutdown();
    const res = await get(app, '/readyz');
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'error', shuttingDown: true, checks: {} });
    expect(calls, 'a draining pod kept probing its dependencies').toBe(1);
  });

  it('serves the same answer at /v1/readyz, which rova points its chart readiness probe at', async () => {
    const { app } = await start(Empty, { checks: { bad: () => Promise.reject(new Error('x')) } });
    expect((await get(app, '/v1/readyz')).statusCode).toBe(503);
  });
});

describe('registration', () => {
  it('rejects two checks with the same name', async () => {
    const { registry } = await start();
    registry.register('x', () => Promise.resolve());
    expect(() => registry.register('x', () => Promise.resolve())).toThrow(/already registered/);
  });

  it('rejects a product check that shadows a built-in one', async () => {
    const app = await createTestApp(Empty);
    open.push(app);
    // A product registering `cache` itself while the cache is configured would hide the real check.
    const registry = enableHealth(app, { checks: { mine: () => Promise.resolve() } });
    expect(registry.has('mine')).toBe(true);
    expect(() => registry.register('mine', () => Promise.resolve())).toThrow();
  });

  it('refuses a second enableHealth for the same app: duplicate routes would fail at listen', async () => {
    const app = await createTestApp(Empty);
    open.push(app);
    enableHealth(app);
    expect(() => enableHealth(app)).toThrow(/already called/);
    expect(healthRegistryOf(app)).toBeDefined();
  });
});

const dockerOn = await dockerTestsEnabled();

describe.skipIf(!dockerOn)('built-in checks, against real PostgreSQL 18 and Valkey', () => {
  let pg: PostgresHarness;
  let valkey: ValkeyHarness;
  beforeAll(async () => {
    [pg, valkey] = await Promise.all([startPostgres({ tls: true }), startValkey()]);
  }, 180_000);
  afterAll(async () => {
    await Promise.allSettled([pg?.stop(), valkey?.stop()]);
  }, 60_000);

  function moduleWith(env: Record<string, string>, cacheUrl: string | undefined) {
    @Module({
      imports: [
        DatabaseModule.forRootAsync({ schema: {}, env }),
        CacheModule.forRoot({ url: cacheUrl, mode: 'optional' }),
      ],
    })
    class Wired {}
    return Wired;
  }

  it('checks the database when platform-db provides a pool, with no registration by the product', async () => {
    const { app, registry } = await start(moduleWith(pg.env(), undefined));
    expect(registry.has('database')).toBe(true);
    const res = await get(app, '/readyz');
    expect(res.statusCode).toBe(200);
    expect(res.json().checks).toEqual({ database: 'up' });
  });

  it('reports the database down (503) when it cannot be reached or authenticated', async () => {
    const { app } = await start(
      moduleWith({ ...pg.env(), DATABASE_PASSWORD: 'wrong-on-purpose' }, undefined),
    );
    const res = await get(app, '/readyz');
    expect(res.statusCode).toBe(503);
    expect(res.json().checks).toEqual({ database: 'down' });
    expect(res.body).not.toMatch(/wrong-on-purpose|Password/i);
  });

  it('has no database check when the product does not use platform-db', async () => {
    const { registry } = await start();
    expect(registry.has('database')).toBe(false);
  });

  // This test stops its Valkey, so it needs one of its own. That container is started in a hook, NOT
  // in the test body: starting a container took 0.8 s to over 4 s when the machine was busy, and the
  // test body runs under vitest's default 5 s timeout while its own poll below allows 10 s. Counting
  // container start against that budget made it fail one run in about twenty-five.
  describe('when Valkey stops', () => {
    let own: ValkeyHarness;
    beforeAll(async () => {
      own = await startValkey();
    }, 180_000);
    afterAll(async () => {
      await own?.stop().catch(() => undefined);
    }, 60_000);

    it('checks the cache when a Valkey URL is configured, and goes 503 when Valkey stops', async () => {
      const { app, registry } = await start(moduleWith(pg.env(), own.url));
      expect(registry.has('cache')).toBe(true);
      await expect.poll(async () => (await get(app, '/readyz')).statusCode).toBe(200);

      await own.stop();
      await expect
        .poll(async () => (await get(app, '/readyz')).statusCode, { timeout: 10_000 })
        .toBe(503);
      expect((await get(app, '/readyz')).json().checks).toMatchObject({
        cache: 'down',
        database: 'up',
      });
    }, 30_000);
  });

  it('does not check a cache that is not configured (optional mode, no URL)', async () => {
    const { app } = await start(moduleWith(pg.env(), undefined));
    const res = await get(app, '/readyz');
    expect(res.statusCode).toBe(200);
    expect(res.json().checks).toEqual({ database: 'up' });
  });
});
