import { createPool } from '@quynhonsemiconductor/platform-db';
import { dockerTestsEnabled } from '@quynhonsemiconductor/testing';
import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBoss, ensureQueues, type SpikeBoss } from '../support/boss.ts';
import { startCluster, type Cluster } from '../support/cluster.ts';
import { recordResult } from '../support/results.ts';
import { sleep, waitFor } from '../support/wait.ts';

/**
 * Not one of the seven scenarios, but APP-PLATFORM-PLAN §6.7 promises "schema `pgboss` created by
 * the migrator role; explicit grants for the app role", because rova and opshub run
 * least-privilege roles. This finds out what that costs: which privileges the app role really
 * needs for the whole pg-boss workload (send, work, retry, dead-letter, schedule, maintenance,
 * queue stats) and which operations break without which.
 */
const enabled = await dockerTestsEnabled();
const quiet = { warn: () => undefined, error: () => undefined };

describe.skipIf(!enabled)(
  'least privilege — migrator owns the pgboss schema, the app role only gets grants',
  () => {
    let cluster: Cluster;
    let admin: Pool;
    let migratorPool: Pool;
    const found: Record<string, unknown> = {};
    const pw = { migrator: randomBytes(18).toString('hex'), app: randomBytes(18).toString('hex') };

    /** Run supervise/monitor passes for ~13 s as the given pool and return the distinct errors pg-boss emitted. */
    const supervisePasses = async (pool: Pool): Promise<string[]> => {
      const errors: string[] = [];
      const boss = createBoss(pool, {
        migrate: false,
        createSchema: false,
        schedule: false,
        superviseIntervalSeconds: 5,
        monitorIntervalSeconds: 5,
        persistQueueStats: true,
        onError: (e) => errors.push(e.message),
      });
      await boss.start();
      await sleep(13_000);
      await boss.stop({ graceful: true, timeout: 3_000 });
      await pool.end();
      return [...new Set(errors)];
    };

    const poolFor = (user: 'migrator' | 'app'): Pool =>
      createPool(
        {
          ...cluster.env,
          DATABASE_USER: `pgb_${user}`,
          DATABASE_PASSWORD: pw[user],
          DB_POOL_MAX: '6',
        },
        { logger: quiet },
      );

    beforeAll(async () => {
      cluster = await startCluster();
      admin = cluster.pool(4);
      await admin.query(`CREATE ROLE pgb_migrator LOGIN PASSWORD '${pw.migrator}'`);
      await admin.query(`CREATE ROLE pgb_app LOGIN PASSWORD '${pw.app}'`);
      await admin.query(`GRANT CREATE ON DATABASE ${cluster.pg.database} TO pgb_migrator`);
      migratorPool = poolFor('migrator');
    });
    afterAll(async () => {
      recordResult('least-privilege', found);
      await migratorPool?.end();
      await cluster?.stop();
    });

    it("the migrator installs the schema from pg-boss's exported SQL plan, as plain SQL", async () => {
      // The shape the platform's migration Job can take: no pg-boss runtime at all, just the
      // construction plan pg-boss exports, run in the migration step like any other migration.
      const { getConstructionPlans } = await import('pg-boss');
      const sql = getConstructionPlans('pgboss');
      expect(sql).toContain('CREATE SCHEMA');
      await migratorPool.query(sql);
      const owner = await admin.query(
        "SELECT nspowner::regrole::text AS owner FROM pg_namespace WHERE nspname = 'pgboss'",
      );
      expect(owner.rows[0].owner).toBe('pgb_migrator');
      found['installPlanBytes'] = sql.length;
    });

    it('the app role, with NO grants, cannot even start (named failure, not a hang)', async () => {
      const pool = poolFor('app');
      const boss = createBoss(pool, {
        migrate: false,
        schedule: false,
        supervise: false,
        registerInstance: false,
      });
      await expect(boss.start()).rejects.toThrow(/permission denied|does not exist/i);
      found['noGrants'] = 'start() rejects';
      await pool.end();
    });

    it('with USAGE + table DML + sequence grants only, the whole workload runs: send, work, retry, dead-letter, schedule, maintenance', async () => {
      // The grant set under test — and nothing else: no CREATE on the schema, not the owner.
      for (const statement of [
        'GRANT USAGE ON SCHEMA pgboss TO pgb_app',
        'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO pgb_app',
        'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pgboss TO pgb_app',
        // Tables the migrator creates later (a new pg-boss release, a partitioned queue) inherit it.
        'ALTER DEFAULT PRIVILEGES FOR ROLE pgb_migrator IN SCHEMA pgboss GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pgb_app',
        'ALTER DEFAULT PRIVILEGES FOR ROLE pgb_migrator IN SCHEMA pgboss GRANT USAGE, SELECT ON SEQUENCES TO pgb_app',
      ]) {
        await migratorPool.query(statement);
      }

      const pool = poolFor('app');
      const events: string[] = [];
      const boss: SpikeBoss = createBoss(pool, {
        migrate: false,
        createSchema: false,
        superviseIntervalSeconds: 5,
        monitorIntervalSeconds: 5,
        maintenanceIntervalSeconds: 5,
        persistQueueStats: false,
        onError: (e) => events.push(`error: ${e.message}`),
      });
      boss.on('warning', (w) => events.push(`warning: ${w.message}`));
      await boss.start();

      await ensureQueues(boss, [
        { name: 'lp.dlq' },
        { name: 'lp.fail', retryLimit: 1, retryDelay: 1, deadLetter: 'lp.dlq' },
        { name: 'lp.ok' },
        { name: 'lp.sched' },
      ]);
      const done: string[] = [];
      await boss.work(
        'lp.ok',
        { pollingIntervalSeconds: 0.5 },
        async (jobs) => void done.push(...jobs.map((j) => j.id)),
      );
      await boss.work('lp.fail', { pollingIntervalSeconds: 0.5 }, async () => {
        throw new Error('boom');
      });
      await boss.work('lp.sched', { pollingIntervalSeconds: 0.5 }, async () => undefined);
      await boss.schedule('lp.sched', '* * * * *', { n: 1 });
      await boss.send('lp.ok', { n: 1 });
      await boss.send('lp.fail', { n: 1 });
      await boss.send('lp.ok', { n: 2 }, { startAfter: 1 });

      await waitFor(() => done.length === 2 || undefined, 'both ok jobs', {
        timeoutMs: 30_000,
        intervalMs: 250,
      });
      await waitFor(
        async () =>
          (await pool.query("SELECT 1 FROM pgboss.job WHERE name = 'lp.dlq'")).rowCount === 1 ||
          undefined,
        'the failing job to reach the dead-letter queue',
        { timeoutMs: 30_000, intervalMs: 250 },
      );
      // Let supervise + monitor + maintenance run at least twice.
      await sleep(14_000);
      expect(await boss.getQueues(['lp.ok'])).toHaveLength(1);
      expect(await boss.getSchedules('lp.sched')).toHaveLength(1);
      await boss.cancel('lp.ok', (await boss.send('lp.ok', { n: 3 }, { startAfter: 3600 }))!);
      await boss.redrive('lp.dlq');
      await boss.stop({ graceful: true, timeout: 5_000 });
      await pool.end();

      found['grantsOnly'] = { eventsDuringWorkload: events };
      expect(events, 'the workload logged errors/warnings under the minimal grants').toEqual([]);
    });

    it('what the minimal grants do NOT allow — and what each missing right breaks', async () => {
      const pool = poolFor('app');
      const events: string[] = [];
      const attempts: Record<string, string> = {};

      // (a) A partitioned queue needs CREATE TABLE in the schema.
      const boss = createBoss(pool, {
        migrate: false,
        createSchema: false,
        schedule: false,
        supervise: false,
        registerInstance: false,
      });
      await boss.start();
      attempts['createQueue partition:true'] = await boss
        .createQueue('lp.partitioned', { partition: true })
        .then(
          () => 'ok',
          (e: Error) => e.message,
        );
      attempts['createQueue (shared table)'] = await boss.createQueue('lp.shared').then(
        () => 'ok',
        (e: Error) => e.message,
      );
      await boss.stop({ graceful: true, timeout: 3_000 });

      // (b) persistQueueStats creates a daily partition of queue_stats from the app's own session.
      const stats = createBoss(pool, {
        migrate: false,
        createSchema: false,
        schedule: false,
        superviseIntervalSeconds: 5,
        monitorIntervalSeconds: 5,
        persistQueueStats: true,
        onError: (e) => events.push(e.message),
      });
      stats.on('warning', (w) => events.push(`warning: ${w.message}`));
      await stats.start().then(
        () => (attempts['start with persistQueueStats'] = 'ok'),
        (e: Error) => (attempts['start with persistQueueStats'] = e.message),
      );
      await sleep(12_000);
      await stats.stop({ graceful: true, timeout: 3_000 }).catch(() => undefined);

      // (c) The app role cannot DDL or read around its grants.
      for (const [name, sql] of [
        ['DROP TABLE pgboss.job', 'DROP TABLE pgboss.job'],
        ['CREATE TABLE pgboss.x', 'CREATE TABLE pgboss.x (a int)'],
        ['ALTER TABLE pgboss.queue', 'ALTER TABLE pgboss.queue ADD COLUMN x int'],
        ['TRUNCATE pgboss.job', 'TRUNCATE pgboss.job'],
      ] as const) {
        attempts[name] = await pool.query(sql).then(
          () => 'ALLOWED',
          (e: Error) => e.message,
        );
      }
      await pool.end();

      found['withoutRights'] = { attempts, eventsWithPersistQueueStats: [...new Set(events)] };
      for (const name of [
        'DROP TABLE pgboss.job',
        'CREATE TABLE pgboss.x',
        'ALTER TABLE pgboss.queue',
        'TRUNCATE pgboss.job',
      ]) {
        expect(attempts[name], name).toMatch(/permission denied|must be owner/);
      }
    });

    it('persistQueueStats is a time bomb for a non-owner: it works for two days, then every supervise pass fails — and CREATE on the schema is not enough', async () => {
      // The install plan creates the queue_stats partitions for today and tomorrow, so the previous
      // test saw nothing. From then on pg-boss's supervise pass creates the next day's partition
      // (CREATE TABLE … PARTITION OF) and drops old ones (DROP TABLE) from whichever instance runs it.
      // Simulate the day after: remove tomorrow's partition, as if two days had passed.
      const { rows } = await admin.query<{ relname: string }>(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'pgboss' AND c.relname ~ '^queue_stats_[0-9]{8}$' ORDER BY 1 DESC LIMIT 1`,
      );
      const tomorrow = rows[0]!.relname;
      await migratorPool.query(`DROP TABLE pgboss.${tomorrow}`);

      const withoutCreate = await supervisePasses(poolFor('app'));
      await migratorPool.query('GRANT CREATE ON SCHEMA pgboss TO pgb_app');
      const withCreate = await supervisePasses(poolFor('app'));
      await migratorPool.query('REVOKE CREATE ON SCHEMA pgboss FROM pgb_app');
      const stillMissing = await admin.query('SELECT 1 FROM pg_class WHERE relname = $1', [
        tomorrow,
      ]);

      found['persistQueueStatsNonOwner'] = {
        droppedPartition: tomorrow,
        errorsWithoutCreate: withoutCreate,
        errorsWithCreateOnSchema: withCreate,
        partitionCreated: stillMissing.rowCount === 1,
      };
      expect(withoutCreate.join(' ')).toMatch(/permission denied for schema pgboss/);
      expect(withCreate.join(' ')).toMatch(/must be owner of table queue_stats/);
      expect(stillMissing.rowCount).toBe(0);
    });

    it('a NOLOGIN schema-owner role that both the migrator and the app belong to makes it work, without giving the app anything outside pgboss — but the new partitions belong to the app', async () => {
      // A second database, installed the way the platform's migration step would: as the owner role.
      await admin.query('CREATE DATABASE pgb_owned');
      await admin.query('CREATE ROLE pgb_owner NOLOGIN');
      await admin.query('GRANT pgb_owner TO pgb_migrator');
      await admin.query('GRANT pgb_owner TO pgb_app');
      await admin.query('GRANT CONNECT ON DATABASE pgb_owned TO pgb_app');
      await admin.query('GRANT CREATE ON DATABASE pgb_owned TO pgb_owner');
      // PostgreSQL 15+ no longer lets everyone create in `public`; the migrator owns the product's tables.
      const superuser = createPool(
        { ...cluster.env, DATABASE_NAME: 'pgb_owned', DB_POOL_MAX: '1' },
        { logger: quiet },
      );
      await superuser.query('GRANT CREATE ON SCHEMA public TO pgb_migrator');
      await superuser.end();

      const env = (user: 'migrator' | 'app') => ({
        ...cluster.env,
        DATABASE_NAME: 'pgb_owned',
        DATABASE_USER: `pgb_${user}`,
        DATABASE_PASSWORD: pw[user],
        DB_POOL_MAX: '4',
      });
      const migrator = createPool(env('migrator'), { logger: quiet });
      const client = await migrator.connect();
      try {
        // A product table the migrator owns, which the app is meant to use only through grants.
        await client.query('CREATE TABLE public.orders (id int PRIMARY KEY)');
        await client.query('GRANT SELECT, INSERT ON public.orders TO pgb_app');
        await client.query('SET ROLE pgb_owner');
        const { getConstructionPlans } = await import('pg-boss');
        await client.query(getConstructionPlans('pgboss'));
        await client.query('RESET ROLE');
      } finally {
        client.release();
      }
      await migrator.end();

      const appPool = createPool(env('app'), { logger: quiet });
      const errors: string[] = [];
      const boss = createBoss(appPool, {
        migrate: false,
        createSchema: false,
        schedule: false,
        superviseIntervalSeconds: 5,
        monitorIntervalSeconds: 5,
        persistQueueStats: true,
        onError: (e) => errors.push(e.message),
      });
      await boss.start();
      // A day with no partition ready, as before.
      const ownedDb = createPool({ ...env('migrator') }, { logger: quiet });
      const { rows: last } = await ownedDb.query<{ relname: string }>(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'pgboss' AND c.relname ~ '^queue_stats_[0-9]{8}$' ORDER BY 1 DESC LIMIT 1`,
      );
      await ownedDb.query(`SET ROLE pgb_owner; DROP TABLE pgboss.${last[0]!.relname}`);
      await sleep(13_000);
      const recreated = await ownedDb.query(
        'SELECT c.relowner::regrole::text AS owner FROM pg_class c WHERE c.relname = $1',
        [last[0]!.relname],
      );
      await boss.stop({ graceful: true, timeout: 3_000 });

      // What the app can and cannot do outside the pgboss schema.
      const outside: Record<string, string> = {};
      for (const [name, sql] of [
        ['SELECT public.orders', 'SELECT * FROM public.orders'],
        ['INSERT public.orders', 'INSERT INTO public.orders VALUES (1)'],
        ['DELETE public.orders', 'DELETE FROM public.orders'],
        ['DROP TABLE public.orders', 'DROP TABLE public.orders'],
        ['CREATE TABLE public.x', 'CREATE TABLE public.x (a int)'],
      ] as const) {
        outside[name] = await appPool.query(sql).then(
          () => 'allowed',
          (e: Error) => e.message,
        );
      }
      await appPool.end();
      await ownedDb.end();

      found['ownerRole'] = {
        errorsWhilePartitionMissing: [...new Set(errors)],
        partitionOwnerAfter: recreated.rows[0]?.owner,
        appOutsidePgboss: outside,
      };
      expect(errors).toEqual([]);
      // Not `pgb_owner`: a partition is owned by the role that CREATEs it. The migrator (a member of
      // pgb_owner, not of pgb_app) could not alter it in a later pg-boss migration. That is why this
      // is not the recommended route — see the ADR.
      expect(recreated.rows[0]?.owner).toBe('pgb_app');
      expect(outside['SELECT public.orders']).toBe('allowed');
      expect(outside['INSERT public.orders']).toBe('allowed');
      expect(outside['DELETE public.orders']).toMatch(/permission denied/);
      expect(outside['DROP TABLE public.orders']).toMatch(/must be owner/);
      expect(outside['CREATE TABLE public.x']).toMatch(/permission denied/);
    });

    it('the app role is refused if the schema is older than the code (migrate:false does not silently run DDL)', async () => {
      // Simulate a deploy of newer pg-boss code against a schema the migrator has not upgraded yet.
      await migratorPool.query('UPDATE pgboss.version SET version = version - 1');
      const pool = poolFor('app');
      const boss = createBoss(pool, {
        migrate: false,
        createSchema: false,
        schedule: false,
        supervise: false,
        registerInstance: false,
      });
      const outcome = await boss.start().then(
        () => 'started',
        (e: Error) => e.message,
      );
      await pool.end();
      await migratorPool.query('UPDATE pgboss.version SET version = version + 1');
      found['olderSchemaWithMigrateFalse'] = outcome;
      expect(outcome).not.toBe('started');
    });

    void PgBoss;
  },
);
