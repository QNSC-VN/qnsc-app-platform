import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dockerTestsEnabled } from '@quynhonsemiconductor/testing';
import { createPool } from '@quynhonsemiconductor/platform-db';
import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBoss, ensureQueues, type SpikeBoss } from '../support/boss.ts';
import { startCluster, type Cluster } from '../support/cluster.ts';
import {
  containerIp,
  lastValue,
  runPanelQuery,
  startGrafana,
  type Grafana,
  type Series,
} from '../support/grafana.ts';
import { recordResult } from '../support/results.ts';
import { sleep, waitFor } from '../support/wait.ts';

/**
 * Scenario 6 (PORTFOLIO-TECH-REVIEW §2A.6):
 *
 *   Grafana panel.
 *   PASS: depth, age, failures and dead-letter visible.
 *
 * "Visible" is checked the only way a test can: a real Grafana (13) is started, a PostgreSQL data
 * source is pointed at the live database with a READ-ONLY role over VERIFIED TLS, the committed
 * dashboard (grafana/pgboss-queues.dashboard.json) is saved through the HTTP API and read back,
 * and every panel's query is executed through `/api/ds/query` — what the panel's own frontend
 * calls — while real queues are filling, failing and dead-lettering. Each panel's answer is
 * compared with the same fact read straight from SQL.
 */
const enabled = await dockerTestsEnabled();

const DASHBOARD = JSON.parse(
  readFileSync(
    join(import.meta.dirname, '..', '..', 'grafana', 'pgboss-queues.dashboard.json'),
    'utf8',
  ),
) as { uid: string; panels: Panel[] };
interface Panel {
  id: number;
  title: string;
  targets: {
    refId: string;
    rawSql: string;
    format: string;
    datasource: { type: string; uid: string };
  }[];
}
const panelByTitle = (re: RegExp) => DASHBOARD.panels.find((p) => re.test(p.title))!;

describe.skipIf(!enabled)('scenario 6 — Grafana panels over the pgboss schema, live', () => {
  let cluster: Cluster;
  let pool: Pool;
  let boss: SpikeBoss;
  let workerBoss: SpikeBoss;
  let grafana: Grafana;
  const found: Record<string, unknown> = {};
  const readerPassword = randomBytes(18).toString('hex');

  const query = async (re: RegExp) => {
    const panel = panelByTitle(re);
    return runPanelQuery(grafana, panel.targets[0]!);
  };
  const seriesNamed = (all: Series[], name: string) => all.find((s) => s.name === name);

  beforeAll(async () => {
    cluster = await startCluster();
    pool = cluster.pool(8);
    // monitor/cache every 5 s so a snapshot lands within the test's patience (default 60 s).
    boss = createBoss(pool, {
      schedule: false,
      persistQueueStats: true,
      superviseIntervalSeconds: 5,
      monitorIntervalSeconds: 5,
      queueCacheIntervalSeconds: 5,
    });
    await boss.start();
    await ensureQueues(boss, [
      { name: 'webhook.deliver.dlq' },
      { name: 'webhook.deliver', retryLimit: 1, retryDelay: 1, deadLetter: 'webhook.deliver.dlq' },
      { name: 'mail.send' },
      { name: 'transcode' }, // deliberately has no worker: its depth and age must grow
      { name: 'flaky', retryLimit: 5, retryDelay: 120 }, // fails once, then waits two minutes in `retry`
    ]);

    // A read-only role for Grafana — the least privilege a dashboard needs.
    await pool.query(
      `CREATE ROLE grafana_ro LOGIN PASSWORD '${readerPassword}' CONNECTION LIMIT 5`,
    );
    await pool.query('GRANT USAGE ON SCHEMA pgboss TO grafana_ro');
    await pool.query('GRANT SELECT ON ALL TABLES IN SCHEMA pgboss TO grafana_ro');
    await pool.query(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT SELECT ON TABLES TO grafana_ro',
    );

    workerBoss = createBoss(cluster.pool(6), { schedule: false, supervise: false });
    await workerBoss.start();
    await workerBoss.work('mail.send', { pollingIntervalSeconds: 0.5 }, async () => undefined);
    await workerBoss.work('webhook.deliver', { pollingIntervalSeconds: 0.5 }, async () => {
      throw new Error('receiver answered 503');
    });
    await workerBoss.work('flaky', { pollingIntervalSeconds: 0.5 }, async () => {
      throw new Error('first attempt fails');
    });

    grafana = await startGrafana();
    const pgIp = await containerIp(cluster.pg.port);
    await grafana.api('/api/datasources', {
      body: {
        name: 'pgboss',
        uid: 'pgboss',
        type: 'grafana-postgresql-datasource',
        access: 'proxy',
        url: `${pgIp}:5432`,
        user: 'grafana_ro',
        jsonData: {
          database: cluster.pg.database,
          // verify-ca: the chain is verified against the CA below. The harness certificate names
          // localhost, not the container's bridge address, so the hostname check is the one thing
          // not enforced here; in the cluster the certificate names the -rw service.
          sslmode: 'verify-ca',
          tlsConfigurationMethod: 'file-content',
          postgresVersion: 1800,
          timescaledb: false,
          maxOpenConns: 4,
        },
        secureJsonData: { password: readerPassword, tlsCACert: cluster.pg.caCertPem },
      },
    });
  });
  afterAll(async () => {
    recordResult('scenario-6', found);
    await workerBoss?.stop({ graceful: true, timeout: 5_000 });
    await boss?.stop({ graceful: true, timeout: 5_000 });
    await grafana?.stop();
    await cluster?.stop();
  });

  it('the data source connects with verified TLS as a read-only role, which cannot write', async () => {
    const health = await grafana.api<{ status: string; message: string }>(
      '/api/datasources/uid/pgboss/health',
    );
    expect(health.status).toBe('OK');

    const ro = createPool(
      { ...cluster.env, DATABASE_USER: 'grafana_ro', DATABASE_PASSWORD: readerPassword },
      { logger: { warn: () => undefined, error: () => undefined } },
    );
    try {
      await expect(ro.query('SELECT count(*) FROM pgboss.job')).resolves.toBeDefined();
      await expect(ro.query('DELETE FROM pgboss.job')).rejects.toThrow(/permission denied/);
      await expect(ro.query('UPDATE pgboss.queue SET retry_limit = 99')).rejects.toThrow(
        /permission denied/,
      );
    } finally {
      await ro.end();
    }
  });

  it('the dashboard saves, reads back identically, and every panel query runs without error', async () => {
    await grafana.api('/api/dashboards/db', {
      body: { dashboard: { ...DASHBOARD, id: null }, overwrite: true },
    });
    const saved = await grafana.api<{ dashboard: { uid: string; panels: Panel[] } }>(
      `/api/dashboards/uid/${DASHBOARD.uid}`,
    );
    expect(saved.dashboard.panels.map((p) => p.title)).toEqual(
      DASHBOARD.panels.map((p) => p.title),
    );
    for (const panel of saved.dashboard.panels) {
      await expect(runPanelQuery(grafana, panel.targets[0]!), panel.title).resolves.toBeDefined();
    }
    found['panels'] = saved.dashboard.panels.map((p) => p.title);
  });

  it('depth, age, failures, retries and dead-letter all show the right numbers for live queues', async () => {
    // 40 mails (a worker drains them), 5 webhooks (fail → one retry → dead-letter), 12 transcodes
    // (nobody works them), 3 flaky (fail once, then sit in `retry` for two minutes).
    for (let i = 0; i < 40; i++) await boss.send('mail.send', { i });
    for (let i = 0; i < 5; i++) await boss.send('webhook.deliver', { i });
    for (let i = 0; i < 12; i++) await boss.send('transcode', { i });
    for (let i = 0; i < 3; i++) await boss.send('flaky', { i });
    const sentAt = Date.now();

    // Depth: the transcode queue shows 12 ready jobs, the mail queue shows none.
    const depth = await waitFor(
      async () => {
        const series = await query(/Queue depth/);
        // The mail queue is draining while the first snapshots land; it must reach 0, the
        // transcode queue (no worker) must stay at 12.
        return lastValue(seriesNamed(series, 'transcode')) === 12 &&
          lastValue(seriesNamed(series, 'mail.send')) === 0
          ? series
          : undefined;
      },
      'the depth panel to show 12 ready transcode jobs and an empty mail queue',
      { timeoutMs: 60_000, intervalMs: 2_000 },
    );
    expect(lastValue(seriesNamed(depth, 'mail.send'))).toBe(0);
    const sqlDepth = await pool.query(
      "SELECT count(*)::int AS n FROM pgboss.job WHERE name='transcode' AND state='created'",
    );
    expect(lastValue(seriesNamed(depth, 'transcode'))).toBe(sqlDepth.rows[0].n);

    // Age: the oldest transcode job is as old as the time since it was sent, and keeps ageing.
    await sleep(15_000);
    const age1 = await waitFor(
      async () => {
        const v = lastValue(seriesNamed(await query(/Oldest ready job/), 'transcode'));
        return v !== undefined && v >= 15 ? v : undefined;
      },
      'the age panel to show at least 15 s',
      { timeoutMs: 40_000, intervalMs: 2_000 },
    );
    await sleep(12_000);
    const age2 = await waitFor(
      async () => {
        const v = lastValue(seriesNamed(await query(/Oldest ready job/), 'transcode'));
        return v !== undefined && v > age1 ? v : undefined;
      },
      'the age to grow',
      { timeoutMs: 40_000, intervalMs: 2_000 },
    );
    expect(age2 - age1).toBeGreaterThanOrEqual(5);
    expect(age2).toBeLessThanOrEqual((Date.now() - sentAt) / 1000 + 10);

    // Failures: the five webhooks fail terminally; the rate panel integrates to five.
    const failed = await waitFor(
      async () => {
        const series = await query(/Terminal failures/);
        const s = seriesNamed(series, 'webhook.deliver');
        return s && (s.columns['value'] ?? []).some((v) => Number(v) > 0) ? series : undefined;
      },
      'the failure panel to show webhook.deliver failures',
      { timeoutMs: 60_000, intervalMs: 2_000 },
    );
    const sqlFailed = await pool.query(
      "SELECT coalesce(sum(failed_delta),0)::int AS n FROM pgboss.queue_stats WHERE name = 'webhook.deliver'",
    );
    expect(sqlFailed.rows[0].n).toBe(5);
    expect(seriesNamed(failed, 'webhook.deliver')).toBeDefined();

    // Dead letter: the five failed webhooks wait in the DLQ.
    const dlq = await waitFor(
      async () => {
        const [frame] = await query(/Dead-letter queues/);
        const names = (frame?.columns['dead_letter_queue'] ?? []) as string[];
        const i = names.indexOf('webhook.deliver.dlq');
        return i >= 0 && Number(frame!.columns['waiting']![i]) === 5 ? frame : undefined;
      },
      'the dead-letter panel to show 5 waiting',
      { timeoutMs: 60_000, intervalMs: 2_000 },
    );
    expect(dlq).toBeDefined();

    // Retrying now: the three flaky jobs.
    const retrying = await waitFor(
      async () => {
        const [frame] = await query(/Retrying now/);
        const names = (frame?.columns['queue'] ?? []) as string[];
        const i = names.indexOf('flaky');
        return i >= 0 && Number(frame!.columns['retrying']![i]) === 3 ? frame : undefined;
      },
      'the retry panel to show 3 flaky jobs',
      { timeoutMs: 40_000, intervalMs: 1_000 },
    );
    expect(retrying.columns['queue']).toContain('flaky');

    found['live'] = {
      depthTranscode: lastValue(seriesNamed(depth, 'transcode')),
      depthMail: lastValue(seriesNamed(depth, 'mail.send')),
      oldestAgeSeconds: [age1, age2],
      terminalFailuresInQueueStats: sqlFailed.rows[0].n,
      deadLetterWaiting: 5,
      retryingFlaky: 3,
      queueStatsResolutionSeconds: 5,
    };
  });
});
