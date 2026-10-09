import 'reflect-metadata';
import { Inject, Injectable, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DATABASE_POOL_TOKEN, DatabaseModule } from '@quynhonsemiconductor/platform-db/nest';
import { sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JobContext, Jobs } from '../types';
import {
  dockerOn,
  jobRows,
  sleep,
  startJobsDb,
  uniqueQueue,
  waitFor,
  type JobsDb,
} from '../test-support/harness';
import { InjectJobs, JOBS_POOL_TOKEN, JobHandler, JobsModule } from './index';

describe.skipIf(!dockerOn)('JobsModule (NestJS), as a non-owner application role', () => {
  let h: JobsDb;
  beforeAll(async () => {
    h = await startJobsDb();
  }, 180_000);
  afterAll(async () => {
    await h?.stop();
  }, 60_000);

  const events: string[] = [];
  const mark = (name: string) => events.push(name);

  /** A product service with a handler and a way to enqueue, the way a product writes it. */
  function makeApp(queue: string, behaviour: { sleepMs?: number } = {}) {
    const seen: JobContext<{ n: number }>[] = [];

    @Injectable()
    class Mailer {
      constructor(@InjectJobs() readonly jobs: Jobs) {}

      @JobHandler(queue, { concurrency: 2 })
      async send(job: JobContext<{ n: number }>): Promise<void> {
        seen.push(job);
        if (behaviour.sleepMs) await sleep(behaviour.sleepMs);
        mark('job-finished');
      }

      enqueue(n: number) {
        return this.jobs.send(queue, { n });
      }
    }
    return { Mailer, seen };
  }

  function appModule(Mailer: new (...args: never[]) => object, env: Record<string, string>) {
    @Module({
      imports: [DatabaseModule.forRootAsync({ schema: {}, env }), JobsModule.forRoot({ env })],
      providers: [Mailer],
    })
    class AppModule {}
    return AppModule;
  }

  it('discovers @JobHandler methods and runs them in a worker', async () => {
    const queue = uniqueQueue('nest');
    const { Mailer, seen } = makeApp(queue);
    const app = await NestFactory.createApplicationContext(
      appModule(Mailer, { ...h.appEnv, ROLE: 'worker' }),
      {
        logger: false,
        abortOnError: false,
      },
    );
    try {
      const mailer = app.get(Mailer);
      await mailer.enqueue(7);
      await waitFor(() => seen.length === 1, { message: 'the handler' });
      expect(seen[0]).toMatchObject({ data: { n: 7 }, attempt: 1 });
    } finally {
      await app.close();
    }
  });

  it('in an API process the queue is defined and send works, but the handler never runs', async () => {
    const queue = uniqueQueue('nest');
    const { Mailer, seen } = makeApp(queue);
    const app = await NestFactory.createApplicationContext(appModule(Mailer, h.appEnv), {
      logger: false,
      abortOnError: false,
    });
    try {
      expect(await app.get(Mailer).enqueue(1)).not.toBeNull();
      await sleep(2_500);
      expect(seen).toEqual([]);
      expect(await jobRows(h.appPool, queue)).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('a product enqueues in its own transaction through the injected Jobs', async () => {
    const queue = uniqueQueue('nest');
    const { Mailer } = makeApp(queue);
    const app = await NestFactory.createApplicationContext(appModule(Mailer, h.appEnv), {
      logger: false,
      abortOnError: false,
    });
    try {
      const { withTransaction } = await import('@quynhonsemiconductor/platform-db/drizzle');
      const mailer = app.get(Mailer);
      await withTransaction(h.db, async (tx) => {
        await tx.execute(sql`INSERT INTO orders (id, customer) VALUES (900, 'nest')`);
        await mailer.jobs.send(queue, { n: 900 }, { tx });
        throw new Error('rollback');
      }).catch(() => undefined);
      expect(await jobRows(h.appPool, queue)).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('fails the boot, naming the fix, when the pgboss schema is missing', async () => {
    await h.adminPool.query('CREATE DATABASE nest_nojobs');
    const queue = uniqueQueue('nest');
    const { Mailer } = makeApp(queue);
    await expect(
      NestFactory.createApplicationContext(
        appModule(Mailer, { ...h.appEnv, DATABASE_NAME: 'nest_nojobs', ROLE: 'worker' }),
        { logger: false, abortOnError: false },
      ),
    ).rejects.toThrow(/installJobsSchema/);
  });

  it('on close: the running job finishes, THEN the jobs pool and the application pool are closed', async () => {
    events.length = 0;
    const queue = uniqueQueue('nest');
    const { Mailer, seen } = makeApp(queue, { sleepMs: 900 });
    const env = {
      ...h.appEnv,
      ROLE: 'worker',
      SHUTDOWN_TIMEOUT_MS: '20000',
      SHUTDOWN_ENDPOINT_DELAY_MS: '0',
    };
    const app = await NestFactory.createApplicationContext(appModule(Mailer, env), {
      logger: false,
      abortOnError: false,
    });

    const jobsPool = app.get<Pool>(JOBS_POOL_TOKEN, { strict: false });
    const appPool = app.get<Pool>(DATABASE_POOL_TOKEN, { strict: false });
    for (const [name, pool] of [
      ['jobs-pool-closed', jobsPool],
      ['app-pool-closed', appPool],
    ] as const) {
      const end = pool.end.bind(pool);
      pool.end = (() => {
        mark(name);
        return end();
      }) as typeof pool.end;
    }

    await app.get(Mailer).enqueue(1);
    await waitFor(() => seen.length === 1, { message: 'the job to start' });
    await app.close();

    // Work stops (beforeApplicationShutdown) before the pools it uses are released
    // (onApplicationShutdown): the job completes, and only then do the pools close.
    expect(events.indexOf('job-finished'), events.join(' < ')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('job-finished')).toBeLessThan(events.indexOf('jobs-pool-closed'));
    expect(events.indexOf('job-finished')).toBeLessThan(events.indexOf('app-pool-closed'));
    expect((await jobRows(h.adminPool, queue))[0]!.state).toBe('completed');
  }, 60_000);

  it('schedules registered in a worker are written once the module has started', async () => {
    const queue = uniqueQueue('nest');
    const { Mailer } = makeApp(queue);
    const app = await NestFactory.createApplicationContext(
      appModule(Mailer, { ...h.appEnv, ROLE: 'worker' }),
      {
        logger: false,
        abortOnError: false,
      },
    );
    try {
      await app.get(Mailer).jobs.schedule(queue, '0 3 * * *');
      const { rows } = await h.adminPool.query<{ timezone: string }>(
        'SELECT timezone FROM pgboss.schedule WHERE name = $1',
        [queue],
      );
      expect(rows).toEqual([{ timezone: 'Asia/Ho_Chi_Minh' }]);
    } finally {
      await app.close();
    }
  });

  it('Inject parameter decorators resolve the same Jobs everywhere', async () => {
    @Injectable()
    class A {
      constructor(
        @Inject(Symbol.for('@quynhonsemiconductor/platform-jobs:jobs')) readonly jobs: Jobs,
      ) {}
    }
    @Injectable()
    class B {
      constructor(@InjectJobs() readonly jobs: Jobs) {}
    }
    @Module({ imports: [JobsModule.forRoot({ env: h.appEnv })], providers: [A, B] })
    class M {}
    const app = await NestFactory.createApplicationContext(M, {
      logger: false,
      abortOnError: false,
    });
    try {
      expect(app.get(A).jobs).toBe(app.get(B).jobs);
    } finally {
      await app.close();
    }
  });
});
