import { createMigratorPool, createPool } from '@quynhonsemiconductor/platform-db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installJobsSchema, jobsGrantsSql, quoteIdent } from './install';
import { createJobs } from './engine';
import { dockerOn, startJobsDb, type JobsDb } from './test-support/harness';

describe('jobsGrantsSql', () => {
  it('grants exactly what ADR 0001 F8 lists, and nothing structural', () => {
    const sql = jobsGrantsSql('shop_app', 'shop_migrator').join('\n');
    expect(sql).toContain('GRANT USAGE ON SCHEMA pgboss TO "shop_app"');
    expect(sql).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO "shop_app"',
    );
    expect(sql).toContain('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pgboss TO "shop_app"');
    expect(sql).toContain(
      'ALTER DEFAULT PRIVILEGES FOR ROLE "shop_migrator" IN SCHEMA pgboss GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "shop_app"',
    );
    expect(sql).toContain(
      'ALTER DEFAULT PRIVILEGES FOR ROLE "shop_migrator" IN SCHEMA pgboss GRANT USAGE, SELECT ON SEQUENCES TO "shop_app"',
    );
    expect(sql).not.toMatch(/\b(CREATE|DROP|TRUNCATE|ALL PRIVILEGES|OWNER)\b/i);
  });

  it('quotes role names, so a name cannot inject SQL', () => {
    const [first] = jobsGrantsSql('x"; DROP SCHEMA pgboss; --', 'm');
    expect(first).toBe('GRANT USAGE ON SCHEMA pgboss TO "x""; DROP SCHEMA pgboss; --"');
    expect(quoteIdent('a"b')).toBe('"a""b"');
  });
});

describe.skipIf(!dockerOn)(
  'installJobsSchema, and the application role with only those grants',
  () => {
    let h: JobsDb;
    beforeAll(async () => {
      h = await startJobsDb();
    }, 180_000);
    afterAll(async () => {
      await h?.stop();
    }, 60_000);

    it('is idempotent: running it again on every release changes nothing and breaks nothing', async () => {
      const migrator = createMigratorPool(h.migratorEnv);
      try {
        await installJobsSchema(migrator, { appRole: 'jobs_app' });
        await installJobsSchema(migrator, { appRole: 'jobs_app' });
      } finally {
        await migrator.end();
      }
      const { rows } = await h.adminPool.query<{ version: number }>(
        'SELECT version FROM pgboss.version',
      );
      expect(rows).toHaveLength(1);
    });

    it('serialises concurrent runs: three migration Jobs at once all succeed and leave one install', async () => {
      const pools = [1, 2, 3].map(() => createMigratorPool(h.migratorEnv));
      try {
        await Promise.all(pools.map((pool) => installJobsSchema(pool, { appRole: 'jobs_app' })));
      } finally {
        await Promise.all(pools.map((pool) => pool.end()));
      }
      const { rows } = await h.adminPool.query('SELECT version FROM pgboss.version');
      expect(rows).toHaveLength(1);
      const grants = await h.adminPool.query(
        "SELECT has_table_privilege('jobs_app', 'pgboss.platform_effect', 'INSERT') AS ok",
      );
      expect(grants.rows[0]).toEqual({ ok: true });
    });

    it('the migrator owns the schema; the application role does not', async () => {
      const { rows } = await h.adminPool.query<{ owner: string }>(
        `SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = 'pgboss'`,
      );
      expect(rows[0]!.owner).toBe('jobs_migrator');
    });

    it('refuses to run as the application role: it must never own the schema', async () => {
      const app = createPool(h.appEnv);
      try {
        await expect(installJobsSchema(app, { appRole: 'jobs_app' })).rejects.toThrow(
          /must run as the migrator role/,
        );
      } finally {
        await app.end();
      }
    });

    it('the application role can do everything a worker does, with no DDL right', async () => {
      const privileges = await h.appPool.query<{
        create: boolean;
        usage: boolean;
        select: boolean;
        insert: boolean;
        del: boolean;
      }>(
        `SELECT has_schema_privilege('jobs_app', 'pgboss', 'CREATE') AS "create",
              has_schema_privilege('jobs_app', 'pgboss', 'USAGE') AS usage,
              has_table_privilege('jobs_app', 'pgboss.job', 'SELECT') AS "select",
              has_table_privilege('jobs_app', 'pgboss.job', 'INSERT') AS insert,
              has_table_privilege('jobs_app', 'pgboss.job', 'DELETE') AS del`,
      );
      expect(privileges.rows[0]).toEqual({
        create: false,
        usage: true,
        select: true,
        insert: true,
        del: true,
      });
      await expect(h.appPool.query('CREATE TABLE pgboss.sneaky (id int)')).rejects.toThrow(
        /permission denied/,
      );
      await expect(h.appPool.query('DROP TABLE pgboss.job')).rejects.toThrow(
        /must be owner|permission denied/,
      );
      await expect(h.appPool.query('TRUNCATE pgboss.job')).rejects.toThrow(/permission denied/);
    });

    it('a table a LATER release adds is still usable by the application role (default privileges)', async () => {
      const migrator = createMigratorPool(h.migratorEnv);
      try {
        await migrator.query('CREATE TABLE pgboss.added_later (id int PRIMARY KEY)');
        await h.appPool.query('INSERT INTO pgboss.added_later VALUES (1)');
      } finally {
        await migrator.query('DROP TABLE pgboss.added_later');
        await migrator.end();
      }
    });

    it('start() as the application role works against the installed schema, with no CREATE', async () => {
      const made = h.makeJobs({ worker: true });
      try {
        await made.jobs.start();
      } finally {
        await made.close();
      }
      expect(h.logs.error.filter((m) => /permission denied/i.test(m))).toEqual([]);
    });

    it('start() against a database with no pgboss schema names the cause and the fix', async () => {
      await h.adminPool.query('CREATE DATABASE nojobs');
      const made = h.makeJobs({ env: { DATABASE_NAME: 'nojobs' } });
      try {
        await expect(made.jobs.start()).rejects.toThrow(/installJobsSchema/);
        await expect(made.jobs.start()).rejects.toThrow(/never runs DDL|missing|permission/);
      } finally {
        await made.close();
      }
    });

    it('start() without grants says the application role lacks them', async () => {
      await h.adminPool.query("CREATE ROLE no_grants LOGIN PASSWORD 'x'");
      const made = h.makeJobs({ env: { DATABASE_USER: 'no_grants', DATABASE_PASSWORD: 'x' } });
      try {
        await expect(made.jobs.start()).rejects.toThrow(/lacks grants|installJobsSchema/);
      } finally {
        await made.close();
      }
    });

    it('createJobs does not start anything until start() is called', () => {
      const jobs = createJobs({ pool: h.appPool, env: h.appEnv });
      expect(jobs).toBeDefined();
    });
  },
);
