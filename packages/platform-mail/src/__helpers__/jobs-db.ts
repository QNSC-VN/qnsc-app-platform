import { randomBytes } from 'node:crypto';
import { createMigratorPool, createPool } from '@quynhonsemiconductor/platform-db';
import { createDatabase, type Database } from '@quynhonsemiconductor/platform-db/drizzle';
import {
  createJobs,
  createJobsPool,
  installJobsSchema,
  type Jobs,
} from '@quynhonsemiconductor/platform-jobs';
import {
  dockerTestsEnabled,
  quoteIdent,
  startPostgres,
  type PostgresHarness,
} from '@quynhonsemiconductor/testing';
import type { Pool } from 'pg';

export const dockerOn = await dockerTestsEnabled();

const quiet = { warn: () => undefined, error: () => undefined };

export interface MailJobsDb {
  pg: PostgresHarness;
  /** The environment of the APPLICATION role: not the owner of the pgboss schema. */
  appEnv: Record<string, string>;
  /** The product's Drizzle database, as the application role. */
  db: Database;
  /** A pool as the superuser, for inspecting and rewinding pgboss tables. */
  adminPool: Pool;
  /** A real `platform-jobs` on its own small pool. `worker: true` is `ROLE=worker`. */
  makeJobs(options?: { worker?: boolean }): {
    jobs: Jobs;
    env: NodeJS.ProcessEnv;
    close(): Promise<void>;
  };
  /** Forget every mail job and its dead letters between tests. */
  reset(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * PostgreSQL 18 over verified TLS with the roles the platform has — a MIGRATOR that owns the
 * `pgboss` schema and an APPLICATION role that does not — and the schema installed exactly as the
 * migration Job installs it (`installJobsSchema`). So these tests run `platform-jobs` for real, with
 * least privilege: a missing grant fails the test instead of a superuser papering over it.
 */
export async function startMailJobsDb(): Promise<MailJobsDb> {
  const pg = await startPostgres({ tls: true });
  const adminPool = pg.createPool({ max: 3 });

  const migratorPassword = randomBytes(12).toString('hex');
  const appPassword = randomBytes(12).toString('hex');
  await adminPool.query(`CREATE ROLE mail_migrator LOGIN PASSWORD '${migratorPassword}'`);
  await adminPool.query(`CREATE ROLE mail_app LOGIN PASSWORD '${appPassword}'`);
  await adminPool.query(`GRANT CREATE ON DATABASE ${quoteIdent(pg.database)} TO mail_migrator`);

  const migratorEnv = {
    ...pg.env(),
    DATABASE_USER: 'mail_migrator',
    DATABASE_PASSWORD: migratorPassword,
  };
  const appEnv = { ...pg.env(), DATABASE_USER: 'mail_app', DATABASE_PASSWORD: appPassword };

  const migratorPool = createMigratorPool(migratorEnv, { logger: quiet });
  try {
    await installJobsSchema(migratorPool, { appRole: 'mail_app' });
  } finally {
    await migratorPool.end();
  }

  const appPool = createPool(appEnv, { logger: quiet });
  const db = createDatabase(appPool, { schema: {} });
  const open = new Set<{ close(): Promise<void> }>();

  return {
    pg,
    appEnv,
    db,
    adminPool,
    makeJobs(options = {}) {
      const env: NodeJS.ProcessEnv = { ...appEnv, ...(options.worker ? { ROLE: 'worker' } : {}) };
      const pool = createJobsPool(env, quiet);
      const jobs = createJobs({ pool, env, logger: quiet });
      const made = {
        jobs,
        env,
        async close() {
          open.delete(made);
          await jobs.stop(500).catch(() => undefined);
          await pool.end().catch(() => undefined);
        },
      };
      open.add(made);
      return made;
    },
    async reset() {
      await adminPool.query(`DELETE FROM pgboss.job WHERE name IN ('mail.send', 'mail.send.dlq')`);
    },
    async stop() {
      await Promise.allSettled([...open].map((m) => m.close()));
      await Promise.allSettled([appPool.end(), adminPool.end()]);
      await pg.stop();
    },
  };
}

export interface JobRow {
  id: string;
  name: string;
  state: string;
  retry_count: number;
  retry_limit: number;
  priority: number;
  data: Record<string, unknown> | null;
  output: { message?: string } | null;
  start_after: Date;
}

export async function jobRows(pool: Pool, queue: string): Promise<JobRow[]> {
  const { rows } = await pool.query<JobRow>(
    `SELECT id, name, state, retry_count, retry_limit, priority, data, output, start_after
       FROM pgboss.job WHERE name = $1 ORDER BY created_on, id`,
    [queue],
  );
  return rows;
}
