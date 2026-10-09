import type { INestApplication } from '@nestjs/common';
import { CacheService } from '@quynhonsemiconductor/platform-cache';
import type { FastifyInstance } from 'fastify';
import { HealthRegistry, type HealthCheck } from './health-registry';

/**
 * The paths are a contract with the `qnsc-service` chart and
 * `gitops/platform/policy/admission.yaml`, which DENIES any Deployment whose liveness path is
 * not exactly `/livez`. Change them and a pod is either rejected or never becomes Ready.
 */
export const LIVENESS_PATH = '/livez';
export const READINESS_PATH = '/readyz';
/**
 * Kept until the last ECS/EKS deployment is retired, then removed in a major: the ALB target
 * group and the Dockerfile HEALTHCHECK use `/v1/healthz`, and rova's values point the chart's
 * readiness probe at `/v1/readyz`.
 */
export const LEGACY_LIVENESS_PATH = '/v1/healthz';
export const LEGACY_READINESS_PATH = '/v1/readyz';

/** Registered by `@quynhonsemiconductor/platform-db/nest`. A registry symbol, see below. */
const DATABASE_POOL_TOKEN = Symbol.for('@quynhonsemiconductor/platform-db:pool');

export interface EnableHealthOptions {
  /** Product checks, by name. Built-in `database` and `cache` are added automatically. */
  checks?: Record<string, HealthCheck>;
}

const registries = new WeakMap<object, HealthRegistry>();

/** The registry `enableHealth` created for this app, if any. */
export function healthRegistryOf(app: object): HealthRegistry | undefined {
  return registries.get(app);
}

/**
 * Serve `/livez` and `/readyz` (plus the legacy `/v1/healthz` and `/v1/readyz`).
 *
 * Call it once per HTTP application, BEFORE `app.listen()`:
 *
 * ```ts
 * const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());
 * enableHealth(app);
 * enableGracefulShutdown(app);
 * await app.listen(port, '0.0.0.0');
 * ```
 *
 * WHY RAW FASTIFY ROUTES AND NOT A NEST CONTROLLER. A controller inherits the product's global
 * prefix (`/v1/livez` is a rejected manifest, not a lesser option), its global guards (which
 * would answer 401 to the kubelet unless the product's own `@Public()` decorator, a name this
 * package cannot know, were applied), its rate limiter, and its OpenAPI document (a new path
 * there breaks every committed-client diff check). Routes registered on the Fastify instance
 * sit outside all of that, which is exactly what a contract with the kubelet should do.
 * It also means the product deletes its own health controller rather than configuring this one.
 *
 * - `/livez` answers 200 while the process runs. It touches NO dependency (the cascading-failure
 *   trap: liveness that checks the database restarts every replica at once when it slows down)
 *   and it stays 200 through the endpoint-removal delay after shutdown begins. (Once the server
 *   stops listening to drain, nothing answers; the pod is Terminating and is not probed.)
 * - `/readyz` runs the registered checks and answers 503 when any is down, and always 503
 *   once shutdown has begun. Built in: `database` when `platform-db` provides a pool, `cache`
 *   when a Valkey URL is configured. Add product checks through `options.checks`.
 * - The body carries per-check up/down only. `/readyz` is unauthenticated; host names, role
 *   names and error text go to the log, not the response.
 */
export function enableHealth(
  app: INestApplication,
  options: EnableHealthOptions = {},
): HealthRegistry {
  if (registries.has(app)) {
    throw new Error('enableHealth() was already called for this application.');
  }
  const registry = new HealthRegistry();
  registries.set(app, registry);

  registerBuiltInChecks(app, registry);
  for (const [name, check] of Object.entries(options.checks ?? {})) {
    registry.register(name, check);
  }

  const fastify = app.getHttpAdapter().getInstance() as FastifyInstance;

  const live = () => ({ status: 'ok' });
  for (const path of [LIVENESS_PATH, LEGACY_LIVENESS_PATH]) {
    fastify.get(path, (_req, reply) => {
      void reply.header('cache-control', 'no-store').send(live());
    });
  }

  for (const path of [READINESS_PATH, LEGACY_READINESS_PATH]) {
    fastify.get(path, async (_req, reply) => {
      const report = await registry.report();
      await reply
        .header('cache-control', 'no-store')
        .code(report.status === 'ok' ? 200 : 503)
        .send(report);
    });
  }

  return registry;
}

/**
 * Dependencies the process already has are checked without the product asking: forgetting to
 * wire the database into `/readyz` is how a pod ends up Ready with no database.
 *
 * Both are looked up with `strict: false` and tolerate absence, because each package is an
 * OPTIONAL peer here. The pool is found by a `Symbol.for(...)` token rather than by importing
 * `platform-db`, so this works when two copies of that package are installed, and when none is.
 */
function registerBuiltInChecks(app: INestApplication, registry: HealthRegistry): void {
  const pool = tryGet<object>(app, DATABASE_POOL_TOKEN);
  if (pool) {
    registry.register('database', async () => {
      // Imported on use: this package must load without platform-db installed.
      const { pingDatabase } = await import('@quynhonsemiconductor/platform-db');
      await pingDatabase(pool as Parameters<typeof pingDatabase>[0]);
    });
  }

  const cache = tryGet<CacheService>(app, CacheService);
  if (cache) {
    // Decided on each probe, not now: the client is created in `onModuleInit`, which has not run
    // when this is called before `listen()`. `redis` is null in `optional` mode with no URL, and
    // then there is nothing to be ready for. A configured cache that is not connected IS down.
    registry.register('cache', async () => {
      if (!cache.redis) return 'skip';
      if (!cache.isAvailable) throw new Error('cache connection is not ready');
      await cache.instance.ping();
    });
  }
}

function tryGet<T>(app: INestApplication, token: unknown): T | undefined {
  try {
    return app.get<T>(token as never, { strict: false });
  } catch {
    return undefined;
  }
}
