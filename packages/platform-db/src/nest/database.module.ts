import {
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  type DynamicModule,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { DbPoolMetrics } from '@quynhonsemiconductor/observability';
import type { Pool } from 'pg';
import type { DatabaseEnv } from '../config';
import { classifyDatabaseError } from '../errors';
import { registerPoolMetrics } from '../metrics';
import { pingDatabase } from '../ping';
import { createPool, createReadPool } from '../pool';
import { DATABASE_POOL_TOKEN, DATABASE_READ_POOL_TOKEN, DATABASE_TOKEN } from '../tokens';
import { createDatabase } from '../drizzle';

export interface DatabaseModuleOptions<TSchema extends Record<string, unknown>> {
  /** The product's Drizzle schema. The only thing that is the product's to provide. */
  schema: TSchema;
  /** Test seam; defaults to `process.env`. Configuration comes from the environment only. */
  env?: DatabaseEnv;
}

/**
 * Owns the pools' lifecycle.
 *
 * - On init it pings once and LOGS the classified cause of a failure, but does not throw:
 *   `/readyz` is what gates traffic, and a database that is briefly unreachable at boot
 *   (a failover, a DNS blip) should leave the pod not-ready, not crash-looping. A
 *   configuration error is different — it is thrown while the pool is built, so a missing
 *   secret or a bad CA fails the boot with its name.
 * - It ends the pools in `onApplicationShutdown`, NOT `onModuleDestroy`. Nest's `close()` runs
 *   the destroy hooks first, then closes the HTTP server (waiting for in-flight requests), and
 *   the shutdown hooks last. Ending the pool in a destroy hook would pull it out from under
 *   requests that are still running queries; in a shutdown hook the HTTP server has already
 *   drained. `pool.end()` also waits for checked-out clients to be returned.
 */
@Injectable()
class DatabaseLifecycle implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('Database');

  constructor(
    @Inject(DATABASE_POOL_TOKEN) private readonly pool: Pool,
    @Inject(DATABASE_READ_POOL_TOKEN) private readonly readPool: Pool | null,
    private readonly metrics: DbPoolMetrics,
  ) {}

  async onModuleInit(): Promise<void> {
    registerPoolMetrics(this.pool, this.metrics);
    try {
      await pingDatabase(this.pool);
      this.logger.log('Database reachable');
    } catch (err) {
      const e = classifyDatabaseError(err);
      this.logger.error(`Database not reachable at boot [${e.code}]: ${e.message}`);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([this.pool.end(), this.readPool?.end()]);
  }
}

/**
 * NestJS adapter. Provides, globally:
 *
 * - `DATABASE_TOKEN`      the Drizzle instance (`@InjectDatabase()`), a `DbExecutor`
 * - `DATABASE_POOL_TOKEN` the primary `pg.Pool` (readiness, advisory locks)
 * - `DATABASE_READ_POOL_TOKEN` the replica pool, or `null` when `DATABASE_READ_HOST` is unset
 *
 * ```ts
 * DatabaseModule.forRootAsync({ schema })
 * ```
 *
 * The pool is built when the module is instantiated, from `DATABASE_*` and `DB_POOL_*`
 * only; there are no options to tune it, by design.
 */
@Global()
@Module({})
export class DatabaseModule {
  static forRootAsync<TSchema extends Record<string, unknown>>(
    options: DatabaseModuleOptions<TSchema>,
  ): DynamicModule {
    const env = options.env ?? process.env;
    const logger = new Logger('Database');
    return {
      module: DatabaseModule,
      global: true,
      providers: [
        DbPoolMetrics,
        { provide: DATABASE_POOL_TOKEN, useFactory: () => createPool(env, { logger }) },
        {
          provide: DATABASE_READ_POOL_TOKEN,
          useFactory: () => createReadPool(env, { logger }) ?? null,
        },
        {
          provide: DATABASE_TOKEN,
          inject: [DATABASE_POOL_TOKEN, DATABASE_READ_POOL_TOKEN],
          useFactory: (pool: Pool, readPool: Pool | null) =>
            createDatabase(pool, { schema: options.schema, readPool: readPool ?? undefined }),
        },
        DatabaseLifecycle,
      ],
      exports: [DATABASE_TOKEN, DATABASE_POOL_TOKEN, DATABASE_READ_POOL_TOKEN],
    };
  }
}
