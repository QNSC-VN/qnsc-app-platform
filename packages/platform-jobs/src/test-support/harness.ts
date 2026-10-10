import { randomBytes, randomUUID } from 'node:crypto';
import { createMigratorPool, createPool } from '@quynhonsemiconductor/platform-db';
import { createDatabase, type Database } from '@quynhonsemiconductor/platform-db/drizzle';
import {
  dockerTestsEnabled,
  quoteIdent,
  startPostgres,
  type PostgresHarness,
} from '@quynhonsemiconductor/testing';
import type { Pool } from 'pg';
import { createJobs, type JobsLogger } from '../engine';
import { createJobsPool } from '../pool';
import { installJobsSchema } from '../install';
import type { Jobs } from '../types';

export const dockerOn = await dockerTestsEnabled();

const quiet: JobsLogger = { warn: () => undefined, error: () => undefined };

export interface JobsDb {
  pg: PostgresHarness;
  /** The environment of the APPLICATION role: not the owner of the pgboss schema. */
  appEnv: Record<string, string>;
  migratorEnv: Record<string, string>;
  /** A pool as the application role, for the test's own SQL (and a product's tables). */
  appPool: Pool;
  /** The product's Drizzle database, as the application role. */
  db: Database;
  /** A pool as the harness's superuser, for inspecting pgboss tables. */
  adminPool: Pool;
  /** Logs of every Jobs made by `makeJobs`, to assert that nothing complained. */
  logs: { warn: string[]; error: string[] };
  makeJobs(options?: MakeJobsOptions): MadeJobs;
  stop(): Promise<void>;
}

export interface MakeJobsOptions {
  worker?: boolean;
  /** Seconds between supervise passes. The package fixes 15; a test that waits for a recovery shortens it. */
  superviseIntervalSeconds?: number;
  /** pg-boss gates job expiry and heartbeat failure on this (60 s). A test that waits for a recovery shortens it. */
  monitorIntervalSeconds?: number;
  /** Deletion of finished jobs (the package fixes 900 s). */
  maintenanceIntervalSeconds?: number;
  /** How often a worker looks for jobs that waited past retention.pending (the package fixes 60 s). */
  pendingSweepSeconds?: number;
  env?: Record<string, string>;
}

export interface MadeJobs {
  jobs: Jobs;
  pool: Pool;
  env: NodeJS.ProcessEnv;
  /** Stop (gracefully, short) and end the pool. */
  close(stopTimeoutMs?: number): Promise<void>;
}

/** A queue name unique to a test, so tests never see each other's jobs and need no cleanup. */
export const uniqueQueue = (prefix = 'q') => `${prefix}.${randomUUID().slice(0, 8)}`;

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Poll until `check` returns a truthy value; throw its last answer's absence on timeout. */
export async function waitFor<T>(
  check: () => Promise<T | false | undefined | null> | T | false | undefined | null,
  { timeoutMs = 20_000, intervalMs = 50, message = 'condition' } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline)
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${message}`);
    await sleep(intervalMs);
  }
}

/**
 * PostgreSQL 18 over verified TLS, with the roles the platform has: a MIGRATOR that owns the
 * pgboss schema and an APPLICATION role that does not. The schema is installed by
 * `installJobsSchema`, exactly as the migration Job does it, so every test runs with least
 * privilege: a missing grant fails the test instead of being papered over by a superuser.
 */
export async function startJobsDb(): Promise<JobsDb> {
  const pg = await startPostgres({ tls: true });
  const adminPool = pg.createPool({ max: 3 });

  const migratorPassword = randomBytes(12).toString('hex');
  const appPassword = randomBytes(12).toString('hex');
  await adminPool.query(`CREATE ROLE jobs_migrator LOGIN PASSWORD '${migratorPassword}'`);
  await adminPool.query(`CREATE ROLE jobs_app LOGIN PASSWORD '${appPassword}'`);
  await adminPool.query(`GRANT CREATE ON DATABASE ${quoteIdent(pg.database)} TO jobs_migrator`);

  const migratorEnv = {
    ...pg.env(),
    DATABASE_USER: 'jobs_migrator',
    DATABASE_PASSWORD: migratorPassword,
  };
  const appEnv = { ...pg.env(), DATABASE_USER: 'jobs_app', DATABASE_PASSWORD: appPassword };

  const migratorPool = createMigratorPool(migratorEnv, { logger: quiet });
  try {
    await installJobsSchema(migratorPool, { appRole: 'jobs_app' });
  } finally {
    await migratorPool.end();
  }

  // A stand-in product table, owned by the superuser and granted to the application role.
  await adminPool.query(
    `CREATE TABLE orders (id integer PRIMARY KEY, customer text NOT NULL);
     CREATE TABLE effects_done (key text PRIMARY KEY, worker text, at timestamptz DEFAULT now());
     GRANT ALL ON ALL TABLES IN SCHEMA public TO jobs_app`,
  );

  const appPool = createPool(appEnv, { logger: quiet });
  const db = createDatabase(appPool, { schema: {} });
  const logs = { warn: [] as string[], error: [] as string[] };
  const open = new Set<MadeJobs>();

  return {
    pg,
    appEnv,
    migratorEnv,
    appPool,
    db,
    adminPool,
    logs,
    makeJobs(options = {}) {
      const env: NodeJS.ProcessEnv = {
        ...appEnv,
        ...(options.worker ? { ROLE: 'worker' } : {}),
        ...options.env,
      };
      const pool = createJobsPool(env, quiet);
      const jobs = createJobs({
        pool,
        env,
        logger: {
          warn: (m) => logs.warn.push(m),
          error: (m) => logs.error.push(m),
        },
        internal: {
          ...(options.superviseIntervalSeconds !== undefined
            ? { superviseIntervalSeconds: options.superviseIntervalSeconds }
            : {}),
          ...(options.monitorIntervalSeconds !== undefined
            ? { monitorIntervalSeconds: options.monitorIntervalSeconds }
            : {}),
          ...(options.maintenanceIntervalSeconds !== undefined
            ? { maintenanceIntervalSeconds: options.maintenanceIntervalSeconds }
            : {}),
          ...(options.pendingSweepSeconds !== undefined
            ? { pendingSweepSeconds: options.pendingSweepSeconds }
            : {}),
        },
      });
      const made: MadeJobs = {
        jobs,
        pool,
        env,
        async close(stopTimeoutMs = 2_000) {
          open.delete(made);
          await jobs.stop(stopTimeoutMs).catch(() => undefined);
          await pool.end().catch(() => undefined);
        },
      };
      open.add(made);
      return made;
    },
    async stop() {
      await Promise.allSettled([...open].map((m) => m.close(500)));
      await Promise.allSettled([appPool.end(), adminPool.end()]);
      await pg.stop();
    },
  };
}

/** Rows of a queue's jobs, as the superuser sees them (the application role sees the same). */
export interface JobRow {
  id: string;
  name: string;
  state: string;
  retry_count: number;
  retry_limit: number;
  data: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  start_after: Date;
  created_on: Date;
  started_on: Date | null;
  completed_on: Date | null;
}

export async function jobRows(pool: Pool, queue: string): Promise<JobRow[]> {
  const { rows } = await pool.query<JobRow>(
    `SELECT id, name, state, retry_count, retry_limit, data, output, start_after, created_on,
            started_on, completed_on
       FROM pgboss.job WHERE name = $1 ORDER BY created_on, id`,
    [queue],
  );
  return rows;
}
