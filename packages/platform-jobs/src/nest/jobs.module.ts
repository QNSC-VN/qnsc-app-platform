import {
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  Optional,
  type BeforeApplicationShutdown,
  type DynamicModule,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { DiscoveryModule, DiscoveryService, HttpAdapterHost, MetadataScanner } from '@nestjs/core';
import type { Pool } from 'pg';
import { stopBudgetMs } from '../budget';
import { createJobs } from '../engine';
import { createJobsPool } from '../pool';
import type { JobContext, Jobs } from '../types';
import { JOB_HANDLER_METADATA, type JobHandlerMetadata } from './job-handler.decorator';

export const JOBS_TOKEN = Symbol.for('@quynhonsemiconductor/platform-jobs:jobs');
export const JOBS_POOL_TOKEN = Symbol.for('@quynhonsemiconductor/platform-jobs:pool');

export interface JobsModuleOptions {
  /** Test seam; defaults to `process.env`. Configuration comes from the environment only. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Finds `@JobHandler` methods, starts pg-boss, and stops it in the right place in Nest's close
 * order:
 *
 * - `onApplicationBootstrap`: register every handler, then `start()`. A missing or outdated
 *   `pgboss` schema fails the boot here, with the cause named.
 * - `beforeApplicationShutdown`: `stop()`: stop fetching and let active jobs finish within the
 *   budget. This is the hook for "stop work", which Nest runs BEFORE `onApplicationShutdown`.
 * - `onApplicationShutdown`: end the jobs pool, after the jobs have stopped using it.
 *
 * That is the order `platform-runtime`'s `enableGracefulShutdown` documents: work stops before the
 * resources it uses are released.
 */
@Injectable()
class JobsLifecycle
  implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown
{
  private readonly logger = new Logger('Jobs');

  constructor(
    @Inject(JOBS_TOKEN) private readonly jobs: Jobs,
    @Inject(JOBS_POOL_TOKEN) private readonly pool: Pool,
    @Inject('JOBS_ENV') private readonly env: NodeJS.ProcessEnv,
    // Named explicitly, like every other token here: a bare parameter type is erased by tooling
    // that does not emit decorator metadata, and the injection would fail silently with undefined.
    @Inject(DiscoveryService) private readonly discovery: DiscoveryService,
    @Inject(MetadataScanner) private readonly scanner: MetadataScanner,
    @Optional() @Inject(HttpAdapterHost) private readonly httpHost?: HttpAdapterHost,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    for (const wrapper of this.discovery.getProviders()) {
      const instance = wrapper.instance as Record<string, unknown> | null | undefined;
      if (!instance || typeof instance !== 'object') continue;
      const prototype = Object.getPrototypeOf(instance) as object | null;
      if (!prototype) continue;

      for (const method of this.scanner.getAllMethodNames(prototype)) {
        const fn = instance[method];
        if (typeof fn !== 'function') continue;
        const metadata = Reflect.getMetadata(JOB_HANDLER_METADATA, fn) as
          JobHandlerMetadata | undefined;
        if (!metadata) continue;
        await this.jobs.handle(
          metadata.queue,
          (job: JobContext) => (fn as (job: JobContext) => Promise<void>).call(instance, job),
          metadata.options,
        );
      }
    }
    await this.jobs.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    // A worker (an application context) has no HTTP server, so it never waited out the
    // endpoint-removal delay and its whole shutdown deadline is available.
    const budget = stopBudgetMs(this.env, Boolean(this.httpHost?.httpAdapter));
    try {
      await this.jobs.stop(budget);
    } catch (error) {
      // A hook that throws ends Nest's close sequence and leaves the pools open.
      this.logger.error(
        `Stopping jobs failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * NestJS adapter. Provides, globally, `JOBS_TOKEN` (`@InjectJobs()`), and owns a DEDICATED pool
 * (max 5) built from the same `DATABASE_*` variables as the application pool.
 *
 * ```ts
 * @Module({ imports: [DatabaseModule.forRootAsync({ schema }), JobsModule.forRoot()] })
 * ```
 */
@Global()
@Module({})
export class JobsModule {
  static forRoot(options: JobsModuleOptions = {}): DynamicModule {
    const env = options.env ?? process.env;
    const logger = new Logger('Jobs');
    return {
      module: JobsModule,
      global: true,
      imports: [DiscoveryModule],
      providers: [
        { provide: 'JOBS_ENV', useValue: env },
        { provide: JOBS_POOL_TOKEN, useFactory: () => createJobsPool(env, logger) },
        {
          provide: JOBS_TOKEN,
          inject: [JOBS_POOL_TOKEN],
          useFactory: (pool: Pool) => createJobs({ pool, env, logger }),
        },
        JobsLifecycle,
      ],
      exports: [JOBS_TOKEN],
    };
  }
}
