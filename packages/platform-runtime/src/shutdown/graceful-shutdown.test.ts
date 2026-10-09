import {
  Inject,
  Injectable,
  Logger,
  Module,
  type BeforeApplicationShutdown,
  type OnModuleDestroy,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { CacheModule, CacheService } from '@quynhonsemiconductor/platform-cache';
import { DATABASE_POOL_TOKEN, DatabaseModule } from '@quynhonsemiconductor/platform-db/nest';
import {
  dockerTestsEnabled,
  startPostgres,
  startValkey,
  type PostgresHarness,
  type ValkeyHarness,
} from '@quynhonsemiconductor/testing';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { enableHealth } from '../health';
import { createTestApp } from '../testing/app';
import { enableGracefulShutdown, type GracefulShutdown } from './index';

// The real flush needs a started SDK. What matters here is WHEN it is called.
const { flushOtel } = vi.hoisted(() => ({ flushOtel: vi.fn() }));
vi.mock('@quynhonsemiconductor/observability/otel', () => ({ shutdownOtel: flushOtel }));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Records WHEN the application's close hooks ran, to prove they run after the drain. */
const events: { name: string; at: number }[] = [];
const mark = (name: string) => events.push({ name, at: Date.now() });
const when = (name: string) => events.find((e) => e.name === name)?.at;

@Injectable()
class Closer implements OnModuleDestroy {
  onModuleDestroy() {
    mark('close-hook');
  }
}
@Module({ providers: [Closer] })
class WithCloseHook {}

let live: { app: NestFastifyApplication; handle?: GracefulShutdown }[] = [];
afterEach(async () => {
  for (const { app, handle } of live) {
    handle?.dispose();
    await app.close().catch(() => undefined);
  }
  live = [];
  events.length = 0;
});

interface Started {
  app: NestFastifyApplication;
  url: string;
  exit: ReturnType<typeof vi.fn>;
  handle: GracefulShutdown;
}

async function start(
  module: Parameters<typeof createTestApp>[0],
  env: NodeJS.ProcessEnv,
  routes?: (app: NestFastifyApplication) => void,
): Promise<Started> {
  const app = await createTestApp(module, routes);
  enableHealth(app);
  const exit = vi.fn(() => mark('exit'));
  const handle = enableGracefulShutdown(app, { env, exit, signals: [] });
  await app.listen(0, '127.0.0.1');
  live.push({ app, handle });
  return { app, url: (await app.getUrl()).replace('[::1]', '127.0.0.1'), exit, handle };
}

/** A route that holds the request open for `ms` and then answers. */
const slowRoute = (ms: number) => (app: NestFastifyApplication) => {
  app
    .getHttpAdapter()
    .getInstance()
    .get('/slow', async () => {
      mark('slow-started');
      await sleep(ms);
      mark('slow-finished');
      return { done: true };
    });
};

describe('enableGracefulShutdown', () => {
  it('lets an in-flight request finish, turns /readyz 503 while draining, and exits 0 inside the deadline', async () => {
    const { url, exit, handle } = await start(
      WithCloseHook,
      { SHUTDOWN_ENDPOINT_DELAY_MS: '400', SHUTDOWN_TIMEOUT_MS: '5000' },
      slowRoute(700),
    );
    expect((await fetch(`${url}/readyz`)).status).toBe(200);

    const inFlight = fetch(`${url}/slow`);
    await vi.waitFor(() => expect(when('slow-started')).toBeDefined());

    const startedAt = Date.now();
    const done = handle.shutdown('test');

    // During the endpoint-removal delay: not ready, still alive, still serving.
    await vi.waitFor(async () => expect((await fetch(`${url}/readyz`)).status).toBe(503));
    const readyz = await (await fetch(`${url}/readyz`)).json();
    expect(readyz).toEqual({ status: 'error', shuttingDown: true, checks: {} });
    expect(
      (await fetch(`${url}/livez`)).status,
      'liveness must stay 200 during the endpoint-removal delay',
    ).toBe(200);
    expect(exit).not.toHaveBeenCalled();

    // The request that was already running completes normally.
    const response = await inFlight;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ done: true });

    await done;
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(Date.now() - startedAt, 'shutdown overran its deadline').toBeLessThan(5000);

    // And the server is really gone.
    await expect(fetch(`${url}/livez`)).rejects.toThrow();
  });

  it('closes the application only AFTER the drain, because Nest itself would do it the other way round', async () => {
    const { url, handle } = await start(
      WithCloseHook,
      { SHUTDOWN_ENDPOINT_DELAY_MS: '0' },
      slowRoute(500),
    );
    const inFlight = fetch(`${url}/slow`);
    await vi.waitFor(() => expect(when('slow-started')).toBeDefined());

    await handle.shutdown('test');
    await inFlight;

    expect(when('close-hook')).toBeDefined();
    expect(
      when('close-hook')! >= when('slow-finished')!,
      'the close hooks (database pool, cache) ran while a request was still in flight',
    ).toBe(true);
  });

  it("premise: Nest's own app.close() runs the destroy hooks BEFORE it drains HTTP", async () => {
    // If Nest ever reorders this, the ordering code above becomes unnecessary: the test that
    // fails here says so.
    const app = await createTestApp(WithCloseHook, slowRoute(500));
    live.push({ app });
    await app.listen(0, '127.0.0.1');
    const url = (await app.getUrl()).replace('[::1]', '127.0.0.1');
    const inFlight = fetch(`${url}/slow`);
    await vi.waitFor(() => expect(when('slow-started')).toBeDefined());

    // Idle keep-alive sockets would hold a bare close() open for 72 s; sweep them as drain() does.
    const sweep = setInterval(() => app.getHttpServer().closeIdleConnections(), 50);
    try {
      await app.close();
    } finally {
      clearInterval(sweep);
    }
    await inFlight.catch(() => undefined);

    expect(when('close-hook')! < when('slow-finished')!).toBe(true);
  });

  it('exits 1 at the deadline instead of waiting for the kubelet SIGKILL when a request never finishes', async () => {
    const { url, exit, handle } = await start(
      WithCloseHook,
      { SHUTDOWN_ENDPOINT_DELAY_MS: '0', SHUTDOWN_TIMEOUT_MS: '600' },
      (app) => {
        app
          .getHttpAdapter()
          .getInstance()
          .get('/hang', async () => {
            mark('hang-started');
            await sleep(30_000);
            return {};
          });
      },
    );
    const controller = new AbortController();
    const hung = fetch(`${url}/hang`, { signal: controller.signal }).catch(() => undefined);
    await vi.waitFor(() => expect(when('hang-started')).toBeDefined());

    const startedAt = Date.now();
    void handle.shutdown('test');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1), { timeout: 3000 });

    expect(Date.now() - startedAt).toBeLessThan(2000);
    controller.abort();
    await hung;
  });

  it('still exits 1 when a close hook throws; Nest then skips the hooks after it, so hooks must not throw', async () => {
    @Injectable()
    class Exploding implements OnModuleDestroy {
      onModuleDestroy() {
        throw new Error('destroy hook failed');
      }
    }
    @Injectable()
    class Later {
      onApplicationShutdown() {
        mark('later-hook');
      }
    }
    @Module({ providers: [Exploding, Later] })
    class Bad {}

    const { exit, handle } = await start(Bad, { SHUTDOWN_ENDPOINT_DELAY_MS: '0' });
    await handle.shutdown('test');

    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    // Documented behaviour, pinned so a Nest change is noticed: a throwing hook ends the close
    // sequence, which is why the pool and cache would stay open behind a throwing destroy hook.
    expect(when('later-hook'), 'Nest ran a hook after one threw; update the docs').toBeUndefined();
  });

  it("keeps the deadline timer ref'd: an unref'd one lets a hang with no open handles exit 0", async () => {
    const timers: NodeJS.Timeout[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: () => void,
      ms?: number,
      ...rest: unknown[]
    ) => {
      const timer = (realSetTimeout as (...a: unknown[]) => NodeJS.Timeout)(fn, ms, ...rest);
      if (ms === 7777) timers.push(timer);
      return timer;
    }) as typeof setTimeout);
    try {
      const { handle } = await start(WithCloseHook, {
        SHUTDOWN_ENDPOINT_DELAY_MS: '0',
        SHUTDOWN_TIMEOUT_MS: '7777',
      });
      await handle.shutdown('test');
    } finally {
      spy.mockRestore();
    }
    expect(timers).toHaveLength(1);
    expect(timers[0]!.hasRef()).toBe(true);
  });

  describe('Nest shutdown hooks', () => {
    it('refuses to start when app.enableShutdownHooks() is already on', async () => {
      const app = await createTestApp(WithCloseHook);
      live.push({ app });
      app.enableShutdownHooks();
      expect(() => enableGracefulShutdown(app, { env: {}, signals: [] })).toThrow(
        /cannot be used together with app\.enableShutdownHooks\(\)/,
      );
    });

    it('also refuses on a worker context', async () => {
      const context = await NestFactory.createApplicationContext(WithCloseHook, { logger: false });
      context.enableShutdownHooks();
      try {
        expect(() => enableGracefulShutdown(context, { env: {}, signals: [] })).toThrow(
          /enableShutdownHooks/,
        );
      } finally {
        await context.close();
      }
    });

    it('logs an error at shutdown if the hooks were enabled afterwards, when startup could not see them', async () => {
      const errors = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      try {
        const { app, handle } = await start(WithCloseHook, { SHUTDOWN_ENDPOINT_DELAY_MS: '0' });
        app.enableShutdownHooks();
        await handle.shutdown('test');
        expect(errors).toHaveBeenCalledWith(
          expect.stringMatching(/enableShutdownHooks\(\) is also active/),
        );
      } finally {
        errors.mockRestore();
      }
    });
  });

  it('is idempotent: a second signal while draining does not start a second sequence', async () => {
    const { exit, handle } = await start(WithCloseHook, { SHUTDOWN_ENDPOINT_DELAY_MS: '50' });
    const first = handle.shutdown('SIGTERM');
    const second = handle.shutdown('SIGINT');
    expect(second).toBe(first);
    await first;
    expect(exit).toHaveBeenCalledOnce();
    expect(events.filter((e) => e.name === 'close-hook')).toHaveLength(1);
    expect(handle.isShuttingDown).toBe(true);
  });

  it('shuts down on a real SIGTERM, through the installed signal handler', async () => {
    const app = await createTestApp(WithCloseHook);
    enableHealth(app);
    const exit = vi.fn(() => mark('exit'));
    const handle = enableGracefulShutdown(app, { env: { SHUTDOWN_ENDPOINT_DELAY_MS: '0' }, exit });
    live.push({ app, handle });
    await app.listen(0, '127.0.0.1');

    process.emit('SIGTERM');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(handle.isShuttingDown).toBe(true);
    expect(when('close-hook')).toBeDefined();
  });

  it('removes its signal handlers on dispose()', async () => {
    const before = process.listenerCount('SIGTERM');
    const app = await createTestApp(WithCloseHook);
    live.push({ app });
    const handle = enableGracefulShutdown(app, { env: {}, exit: () => undefined });
    expect(process.listenerCount('SIGTERM')).toBe(before + 1);
    handle.dispose();
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });

  it('works for a worker with no HTTP server: closes the context and exits 0', async () => {
    const context = await NestFactory.createApplicationContext(WithCloseHook, { logger: false });
    const exit = vi.fn();
    const handle = enableGracefulShutdown(context, {
      env: { SHUTDOWN_ENDPOINT_DELAY_MS: '0' },
      exit,
      signals: [],
    });

    await handle.shutdown('test');
    expect(when('close-hook')).toBeDefined();
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  describe('configuration comes from the environment, and bad values are refused', () => {
    const app = {} as never;

    it('defaults to an immediate shutdown outside Kubernetes, so Ctrl-C on a laptop is not slow', () => {
      expect(enableGracefulShutdown(app, { env: {}, signals: [] }).endpointDelayMs).toBe(0);
    });

    it('defaults to a 5 s endpoint-removal delay inside a Kubernetes pod (KUBERNETES_SERVICE_HOST)', () => {
      const handle = enableGracefulShutdown(app, {
        env: { KUBERNETES_SERVICE_HOST: '10.43.0.1' },
        signals: [],
      });
      expect(handle.endpointDelayMs).toBe(5000);
      expect(handle.timeoutMs, 'the deadline must sit inside the chart default of 30 s').toBe(
        25_000,
      );
    });

    it('lets the pod override both', () => {
      const handle = enableGracefulShutdown(app, {
        env: { SHUTDOWN_ENDPOINT_DELAY_MS: '1000', SHUTDOWN_TIMEOUT_MS: '55000' },
        signals: [],
      });
      expect([handle.endpointDelayMs, handle.timeoutMs]).toEqual([1000, 55_000]);
    });

    it.each(['abc', '-1', '1.5', '700000'])('refuses SHUTDOWN_TIMEOUT_MS=%s', (value) => {
      expect(() =>
        enableGracefulShutdown(app, { env: { SHUTDOWN_TIMEOUT_MS: value }, signals: [] }),
      ).toThrow(/SHUTDOWN_TIMEOUT_MS/);
    });

    it('refuses a delay that leaves no time to drain', () => {
      expect(() =>
        enableGracefulShutdown(app, {
          env: { SHUTDOWN_ENDPOINT_DELAY_MS: '30000', SHUTDOWN_TIMEOUT_MS: '25000' },
          signals: [],
        }),
      ).toThrow(/must be smaller/);
    });
  });
});

const dockerOn = await dockerTestsEnabled();

describe.skipIf(!dockerOn)('with a real database pool (platform-db)', () => {
  let pg: PostgresHarness;
  beforeAll(async () => {
    pg = await startPostgres({ tls: true });
  }, 180_000);
  afterAll(async () => {
    await pg?.stop();
  }, 60_000);

  it('an in-flight query on the pool completes, because the pool is closed after the drain', async () => {
    @Module({ imports: [DatabaseModule.forRootAsync({ schema: {}, env: pg.env() })] })
    class WithDb {}

    const { app, url, exit, handle } = await start(
      WithDb,
      { SHUTDOWN_ENDPOINT_DELAY_MS: '0', SHUTDOWN_TIMEOUT_MS: '10000' },
      (a) => {
        a.getHttpAdapter()
          .getInstance()
          .get('/query', async () => {
            mark('query-started');
            // Reaches the pool through the app: the route is registered before init.
            const pool = a.get<Pool>(DATABASE_POOL_TOKEN, { strict: false });
            const { rows } = await pool.query<{ ok: number }>('SELECT pg_sleep(0.8), 1 AS ok');
            mark('query-finished');
            return { ok: rows[0]!.ok };
          });
      },
    );
    const pool = app.get<Pool>(DATABASE_POOL_TOKEN, { strict: false });

    const inFlight = fetch(`${url}/query`);
    await vi.waitFor(() => expect(when('query-started')).toBeDefined());
    await sleep(100);
    await handle.shutdown('test');

    const response = await inFlight;
    expect(response.status, 'the pool was closed under a running query').toBe(200);
    expect(await response.json()).toEqual({ ok: 1 });
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    // And the pool IS closed once the sequence is over.
    await expect(pool.query('SELECT 1')).rejects.toThrow(/pool/i);
  });
});

describe.skipIf(!dockerOn)('the whole sequence, in order, with real components', () => {
  let pg: PostgresHarness;
  let valkey: ValkeyHarness;
  beforeAll(async () => {
    [pg, valkey] = await Promise.all([startPostgres({ tls: true }), startValkey()]);
  }, 180_000);
  afterAll(async () => {
    await Promise.allSettled([pg?.stop(), valkey?.stop()]);
  }, 60_000);

  it('readyz 503 < HTTP drained < jobs stopped < pool and cache closed < telemetry flushed < exit', async () => {
    /**
     * A job runner: stops work in beforeApplicationShutdown, and needs the pool and the cache to
     * do so. If either were already closed (the bug this test exists for: the cache used to quit
     * in onModuleDestroy, which Nest runs first), these calls would throw and fail the run.
     */
    @Injectable()
    class JobRunner implements BeforeApplicationShutdown {
      constructor(
        @Inject(CacheService) private readonly cache: CacheService,
        @Inject(DATABASE_POOL_TOKEN) private readonly pool: Pool,
      ) {}
      async beforeApplicationShutdown() {
        await this.cache.set('job:heartbeat', 'stopping', 30);
        await this.pool.query('SELECT 1');
        mark('jobs-stopped');
      }
    }
    @Module({
      imports: [
        DatabaseModule.forRootAsync({ schema: {}, env: pg.env() }),
        CacheModule.forRoot({ url: valkey.url, mode: 'required' }),
      ],
      providers: [JobRunner],
    })
    class App {}

    flushOtel.mockImplementation(() => {
      mark('telemetry-flushed');
      return Promise.resolve();
    });
    vi.stubEnv('OTEL_ENABLED', 'true');
    try {
      const { app, url, exit, handle } = await start(
        App,
        { SHUTDOWN_ENDPOINT_DELAY_MS: '300', SHUTDOWN_TIMEOUT_MS: '10000' },
        slowRoute(100),
      );
      const pool = app.get<Pool>(DATABASE_POOL_TOKEN, { strict: false });
      const cache = app.get(CacheService, { strict: false });
      const endPool = pool.end.bind(pool);
      pool.end = (() => {
        mark('pool-closed');
        return endPool();
      }) as typeof pool.end;
      const quitCache = cache.onApplicationShutdown.bind(cache);
      cache.onApplicationShutdown = async () => {
        mark('cache-closed');
        await quitCache();
      };
      app.getHttpServer().once('close', () => mark('http-drained'));

      // Observe readiness from outside, as the kubelet would.
      const poll = setInterval(() => {
        if (when('readyz-503') !== undefined) return;
        void fetch(`${url}/readyz`).then((res) => {
          if (res.status === 503 && when('readyz-503') === undefined) mark('readyz-503');
        });
      }, 20);

      await handle.shutdown('test');
      clearInterval(poll);

      expect(exit).toHaveBeenCalledExactlyOnceWith(0);
      const order = events.map((e) => e.name);
      const at = (name: string) => {
        const i = order.indexOf(name);
        expect(i, `${name} never happened; saw ${order.join(' < ')}`).toBeGreaterThanOrEqual(0);
        return i;
      };
      const lastResource = Math.max(at('pool-closed'), at('cache-closed'));
      const firstResource = Math.min(at('pool-closed'), at('cache-closed'));

      expect(at('readyz-503'), order.join(' < ')).toBeLessThan(at('http-drained'));
      expect(at('http-drained'), order.join(' < ')).toBeLessThan(at('jobs-stopped'));
      expect(at('jobs-stopped'), order.join(' < ')).toBeLessThan(firstResource);
      expect(lastResource, order.join(' < ')).toBeLessThan(at('telemetry-flushed'));
      expect(at('telemetry-flushed'), order.join(' < ')).toBeLessThan(at('exit'));
    } finally {
      vi.unstubAllEnvs();
      flushOtel.mockReset();
    }
  });
});
