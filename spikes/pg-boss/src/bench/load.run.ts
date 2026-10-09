import { dockerTestsEnabled } from '@quynhonsemiconductor/testing';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBoss, ensureQueues, type SpikeBoss } from '../support/boss.ts';
import { spawnWorker, type WorkerHandle } from '../support/child.ts';
import { startCluster, type Cluster } from '../support/cluster.ts';
import {
  containerIdByPort,
  cpuSample,
  limitCpus,
  processCpuSeconds,
} from '../support/docker-stats.ts';
import { createAppDb, orders, send, withTransaction, type AppDb } from '../support/drizzle.ts';
import { recordResult } from '../support/results.ts';
import { percentile, sleep } from '../support/wait.ts';

/**
 * Scenario 5 (PORTFOLIO-TECH-REVIEW §2A.6):
 *
 *   Load: 100 jobs/second for 10 minutes.
 *   PASS: no backlog growth; database CPU comfortable.
 *
 * Open-loop producer (a fixed schedule, not "as fast as the last one finished"), 30 % of the
 * sends inside a Drizzle transaction with a business insert, the rest direct. Two worker
 * processes consume. The database is a container capped at 2 CPUs and 2 GiB — the order of
 * magnitude of one CloudNativePG instance — and its CPU is sampled from `docker stats`.
 *
 * "Comfortable" is fixed here before the run, not after: p95 of the 5-second CPU samples at or
 * under 100 % of ONE core (50 % of the 2-core cap), and a final backlog of zero.
 *
 * Run: pnpm --filter @quynhonsemiconductor/spike-pg-boss bench:load   (about 12 minutes)
 */
const enabled = await dockerTestsEnabled();

const RATE = 100;
const DURATION_S = Number(process.env['LOAD_SECONDS'] ?? 600);
const DB_CPUS = 2;
const TX_SHARE = 0.3;
const SAMPLE_MS = 5_000;

describe.skipIf(!enabled)('scenario 5 — load', () => {
  let cluster: Cluster;
  let pool: Pool;
  let db: AppDb;
  let boss: SpikeBoss;
  let containerId: string;
  const workers: WorkerHandle[] = [];

  beforeAll(async () => {
    cluster = await startCluster();
    containerId = await containerIdByPort(cluster.pg.port);
    await limitCpus(containerId, DB_CPUS);
    pool = cluster.pool(10);
    db = await createAppDb(pool);
    boss = createBoss(pool, { schedule: false });
    await boss.start();
  });
  afterAll(async () => {
    for (const w of workers) w.signal('SIGKILL');
    await Promise.allSettled(workers.map((w) => w.exited));
    await boss?.stop({ graceful: true, timeout: 5_000 });
    await cluster?.stop();
  });

  const backlog = async (queue: string) =>
    Number(
      (
        await pool.query<{ n: string }>(
          "SELECT count(*) AS n FROM pgboss.job WHERE name = $1 AND state IN ('created','retry')",
          [queue],
        )
      ).rows[0]!.n,
    );
  const completed = async (queue: string) =>
    Number(
      (
        await pool.query<{ n: string }>(
          "SELECT count(*) AS n FROM pgboss.job WHERE name = $1 AND state = 'completed'",
          [queue],
        )
      ).rows[0]!.n,
    );

  /** Send at a fixed rate for `seconds`; resolves with how many were sent and how late the schedule ran. */
  async function produce(queue: string, seconds: number, onTick?: () => Promise<void>) {
    let sent = 0;
    let orderId = 1_000_000 + Math.floor(Math.random() * 1e6);
    let maxLagMs = 0;
    const inflight = new Set<Promise<unknown>>();
    const t0 = Date.now();
    const slotMs = 1000 / RATE;
    for (let i = 0; i < seconds * RATE; i++) {
      const due = t0 + i * slotMs;
      const wait = due - Date.now();
      if (wait > 0) await sleep(wait);
      else maxLagMs = Math.max(maxLagMs, -wait);
      const p = (
        Math.random() < TX_SHARE
          ? withTransaction(db, async (tx) => {
              await tx.insert(orders).values({ id: orderId++, customer: 'load' });
              return send(boss, queue, { i }, { tx });
            })
          : boss.send(queue, { i })
      )
        .then(() => void sent++)
        .finally(() => inflight.delete(p));
      inflight.add(p);
      if (inflight.size > 500) await Promise.race(inflight); // never an unbounded pile if the DB stalls
      if (onTick && i % RATE === 0) await onTick();
    }
    await Promise.all(inflight);
    return { sent, maxLagMs, elapsedMs: Date.now() - t0 };
  }

  it('control: the naive defaults (1 worker, batchSize 1, 1 s polling) cannot keep up — the trap WP-7 must close', async () => {
    const queue = 'load.naive';
    await ensureQueues(boss, [queue]);
    const w = await spawnWorker(cluster, {
      id: 'naive',
      schedule: false,
      handlers: [{ queue, handler: { kind: 'busy', ms: 10 }, work: { pollingIntervalSeconds: 1 } }],
    });
    workers.push(w);
    const r = await produce(queue, 30);
    await sleep(2_000);
    const waiting = await backlog(queue);
    const done = await completed(queue);
    w.signal('SIGKILL');
    await w.exited;
    recordResult('scenario-5', {
      naiveDefaults: {
        sent: r.sent,
        completedIn32s: done,
        backlogAfter32s: waiting,
        completedPerSecond: Math.round((done / 32) * 10) / 10,
      },
    });
    expect(waiting, 'the naive configuration unexpectedly kept up').toBeGreaterThan(r.sent / 2);
  });

  it(`${RATE} jobs/s for ${DURATION_S} s: no backlog growth, database CPU comfortable`, async () => {
    const queue = 'load.main';
    await ensureQueues(boss, [queue]);
    const workConfig = {
      pollingIntervalSeconds: 1,
      batchSize: 25,
      localConcurrency: 2,
      burstWhenBatchFull: true,
    };
    for (const id of ['load-A', 'load-B']) {
      workers.push(
        await spawnWorker(cluster, {
          id,
          schedule: false,
          handlers: [{ queue, handler: { kind: 'busy', ms: 10 }, work: workConfig }],
        }),
      );
    }

    const samples: {
      t: number;
      backlog: number;
      dbCpu: number;
      dbMem: number;
      workerCpu: number[];
    }[] = [];
    const t0 = Date.now();
    let sampling = true;
    const loadWorkers = workers.filter((w) => w.id.startsWith('load-'));
    let lastCpu = await Promise.all(loadWorkers.map((w) => processCpuSeconds(w.proc.pid!)));
    let lastAt = Date.now();
    const sampler = (async () => {
      while (sampling) {
        const [b, c, cpuNow] = await Promise.all([
          backlog(queue),
          cpuSample(containerId),
          Promise.all(loadWorkers.map((w) => processCpuSeconds(w.proc.pid!))),
        ]);
        const now = Date.now();
        // CPU seconds used since the last reading, per wall second: percent of one core.
        const workerCpu = cpuNow.map(
          (cpu, i) => ((cpu - lastCpu[i]!) / ((now - lastAt) / 1000)) * 100,
        );
        lastCpu = cpuNow;
        lastAt = now;
        samples.push({
          t: Math.round((now - t0) / 1000),
          backlog: b,
          dbCpu: c.cpuPercent,
          dbMem: c.memBytes,
          workerCpu,
        });
        await sleep(SAMPLE_MS);
      }
    })();

    const r = await produce(queue, DURATION_S);
    // Drain: how long until the backlog is empty once the producer stops.
    const drainStart = Date.now();
    while ((await backlog(queue)) > 0 && Date.now() - drainStart < 120_000) await sleep(250);
    const drainMs = Date.now() - drainStart;
    sampling = false;
    await sampler;

    const db$ = async (sql: string) => (await pool.query(sql)).rows;
    const [lat] = (
      await pool.query<{ p50: number; p95: number; p99: number; max: number; n: string }>(
        `SELECT percentile_cont(0.50) WITHIN GROUP (ORDER BY w) AS p50,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY w) AS p95,
              percentile_cont(0.99) WITHIN GROUP (ORDER BY w) AS p99,
              max(w) AS max, count(*) AS n
         FROM (SELECT extract(epoch FROM started_on - created_on) * 1000 AS w
                 FROM pgboss.job WHERE name = $1 AND state = 'completed') s`,
        [queue],
      )
    ).rows;
    const [size] =
      await db$(`SELECT pg_size_pretty((SELECT sum(pg_total_relation_size(c.oid)) FROM pg_class c
                                                              JOIN pg_namespace n ON n.oid = c.relnamespace
                                                             WHERE n.nspname = 'pgboss' AND c.relkind = 'r')) AS pgboss_tables_and_indexes,
                                     pg_size_pretty(pg_database_size(current_database())) AS database`);
    const [vac] = await db$(`SELECT n_live_tup, n_dead_tup, autovacuum_count, autoanalyze_count
                               FROM pg_stat_user_tables WHERE schemaname='pgboss' AND relname LIKE 'job%' ORDER BY n_live_tup DESC LIMIT 1`);
    const done = await completed(queue);

    const cpu = samples.map((s) => s.dbCpu);
    const backlogs = samples.map((s) => s.backlog);
    // Backlog trend: mean of the last third against mean of the middle third.
    const third = Math.floor(samples.length / 3);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const midMean = mean(backlogs.slice(third, 2 * third));
    const lastMean = mean(backlogs.slice(2 * third));

    const summary = {
      config: {
        rate: RATE,
        seconds: DURATION_S,
        txShare: TX_SHARE,
        dbCpus: DB_CPUS,
        workers: 2,
        work: workConfig,
        handlerMs: 10,
      },
      sent: r.sent,
      completed: done,
      producerElapsedMs: r.elapsedMs,
      producerMaxScheduleLagMs: Math.round(r.maxLagMs),
      achievedRate: Math.round((r.sent / (r.elapsedMs / 1000)) * 10) / 10,
      drainMsAfterProducerStopped: drainMs,
      backlog: {
        max: Math.max(...backlogs),
        midThirdMean: Math.round(midMean),
        lastThirdMean: Math.round(lastMean),
        final: await backlog(queue),
      },
      dbCpuPercentOfOneCore: {
        mean: Math.round(mean(cpu)),
        p50: percentile(cpu, 50),
        p95: percentile(cpu, 95),
        max: Math.max(...cpu),
        capPercent: DB_CPUS * 100,
      },
      dbMemoryMiB: Math.round(Math.max(...samples.map((s) => s.dbMem)) / 1024 ** 2),
      workerCpuPercentOfOneCore: {
        mean: Math.round(mean(samples.flatMap((s) => s.workerCpu))),
        p95: Math.round(
          percentile(
            samples.flatMap((s) => s.workerCpu),
            95,
          ),
        ),
        note: 'per worker process, from ps cumulative CPU time deltas',
      },
      pickupMs: {
        p50: Math.round(lat!.p50),
        p95: Math.round(lat!.p95),
        p99: Math.round(lat!.p99),
        max: Math.round(lat!.max),
      },
      size,
      vacuum: vac,
      samples: samples.filter((_, i) => i % 6 === 0),
    };
    recordResult('scenario-5', { main: summary });

    expect(r.sent).toBe(RATE * DURATION_S);
    expect(done, 'jobs lost or stuck').toBe(r.sent);
    expect(summary.backlog.final).toBe(0);
    expect(lastMean, 'backlog is growing').toBeLessThanOrEqual(Math.max(midMean * 1.5, 150));
    expect(percentile(cpu, 95), 'database CPU not comfortable').toBeLessThanOrEqual(100);
  });
});
