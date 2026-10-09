import { dockerTestsEnabled } from '@quynhonsemiconductor/testing';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBoss, ensureQueues, type SpikeBoss } from '../support/boss.ts';
import { JOB_LOG_DDL, logRows, spawnWorker, type WorkerHandle } from '../support/child.ts';
import { startCluster, type Cluster } from '../support/cluster.ts';
import { recordResult } from '../support/results.ts';
import { sleep, summarise, waitFor } from '../support/wait.ts';

/**
 * WP-6 addition: "per-queue polling interval of ≤ 1 s measured end-to-end".
 *
 * APP-PLATFORM-PLAN §4.3 promises a user who is waiting (an OTP, a password reset) that the job
 * is "picked up within ~1 s (per-queue polling interval)", and WP-7 accepts "p95 pickup ≤ 1.5 s
 * with a 1 s polling interval". This measures it.
 *
 * Pickup = from the producer calling `send` to the handler's first line running. Each sample is
 * taken on an IDLE queue, at a random phase of the worker's poll cycle (a random pause before
 * every send), because a job that arrives while the worker is busy measures the backlog, not
 * the polling interval.
 */
const enabled = await dockerTestsEnabled();

describe.skipIf(!enabled)('pickup latency — end to end, per-queue polling interval', () => {
  let cluster: Cluster;
  let producerPool: Pool;
  let boss: SpikeBoss;
  const children: WorkerHandle[] = [];
  const results: Record<string, unknown> = {};

  beforeAll(async () => {
    cluster = await startCluster();
    producerPool = cluster.pool(4);
    await producerPool.query(JOB_LOG_DDL);
    boss = createBoss(producerPool, { schedule: false });
    await boss.start();
  });
  afterAll(async () => {
    recordResult('pickup-latency', results);
    for (const c of children) c.signal('SIGKILL');
    await Promise.allSettled(children.map((c) => c.exited));
    await boss?.stop({ graceful: true, timeout: 5_000 });
    await cluster?.stop();
  });

  /** In-process worker on its own platform-db pool: the shortest possible path. */
  async function inProcess(queue: string, pollingIntervalSeconds: number, samples: number) {
    await ensureQueues(boss, [queue]);
    const workerBoss = createBoss(cluster.pool(4), { schedule: false, supervise: false });
    await workerBoss.start();
    const startedAt = new Map<string, number>();
    await workerBoss.work(queue, { pollingIntervalSeconds }, async (jobs) => {
      const now = Date.now();
      for (const job of jobs) startedAt.set(job.id, now);
      return undefined;
    });

    const latencies: number[] = [];
    const sendMs: number[] = [];
    for (let i = 0; i < samples; i++) {
      await sleep(Math.random() * pollingIntervalSeconds * 1000 + 50); // random phase
      const t0 = Date.now();
      const id = (await boss.send(queue, { i }))!;
      sendMs.push(Date.now() - t0);
      const t1 = await waitFor(() => startedAt.get(id), `sample ${i} to be picked up`, {
        timeoutMs: 20_000,
        intervalMs: 20,
      });
      latencies.push(t1 - t0);
    }
    await workerBoss.stop({ graceful: true, timeout: 5_000 });
    return { latency: summarise(latencies), send: summarise(sendMs) };
  }

  it("in-process worker, pollingIntervalSeconds = 1 (the platform default): p95 within WP-7's 1.5 s", async () => {
    const r = await inProcess('latency.poll1', 1, 150);
    results['inProcess_poll1s'] = r;
    expect(r.latency.p95).toBeLessThanOrEqual(1500);
  });

  it('in-process worker, pollingIntervalSeconds = 0.5 (pg-boss minimum): p95 well under 1 s', async () => {
    const r = await inProcess('latency.poll05', 0.5, 150);
    results['inProcess_poll05s'] = r;
    expect(r.latency.p95).toBeLessThanOrEqual(1000);
  });

  it('worker in a SEPARATE PROCESS (as deployed), pollingIntervalSeconds = 1', async () => {
    const queue = 'latency.child';
    await ensureQueues(boss, [queue]);
    const child = await spawnWorker(cluster, {
      id: 'latency-child',
      schedule: false,
      boss: { supervise: false },
      handlers: [{ queue, handler: { kind: 'noop' }, work: { pollingIntervalSeconds: 1 } }],
    });
    children.push(child);

    const latencies: number[] = [];
    for (let i = 0; i < 100; i++) {
      await sleep(Math.random() * 1000 + 50);
      const id = (await boss.send(queue, { i }))!;
      // The child's `start` row is the first line of the handler; its DB timestamp is the
      // handler clock. Docker Desktop's VM clock can sit a few ms off the host's, so the sample
      // uses the *job's* own created_on → the log row, both stamped by the database.
      const row = await waitFor(
        async () => (await logRows(producerPool, "event = 'start' AND job_id = $1", [id]))[0],
        `sample ${i}`,
        { timeoutMs: 20_000, intervalMs: 20 },
      );
      const { rows } = await producerPool.query<{ ms: number }>(
        `SELECT extract(epoch FROM ($2::timestamptz - created_on)) * 1000 AS ms FROM pgboss.job WHERE id = $1`,
        [id, row.at],
      );
      latencies.push(Number(rows[0]!.ms));
    }
    const r = {
      latency: summarise(latencies),
      note: 'created_on → handler first line, both stamped by the database',
    };
    results['childProcess_poll1s'] = r;
    expect(r.latency.p95).toBeLessThanOrEqual(1500);
  });

  it('idle cost: transactions per second the database sees from N polling queues', async () => {
    // Six queues (what a product like opshub would register), one worker each, 1 s polling.
    const queues = Array.from({ length: 6 }, (_, i) => `idle.q${i}`);
    await ensureQueues(boss, queues);
    const idleBoss = createBoss(cluster.pool(6), { schedule: false });
    await idleBoss.start();
    for (const q of queues)
      await idleBoss.work(q, { pollingIntervalSeconds: 1 }, async () => undefined);
    await sleep(3_000);
    const commits = async () =>
      Number(
        (
          await producerPool.query<{ n: string }>(
            'SELECT xact_commit + xact_rollback AS n FROM pg_stat_database WHERE datname = current_database()',
          )
        ).rows[0]!.n,
      );
    const a = await commits();
    await sleep(30_000);
    const b = await commits();
    await idleBoss.stop({ graceful: true, timeout: 5_000 });
    const tps = (b - a) / 30;
    results['idle_6queues_poll1s'] = { transactionsPerSecond: Math.round(tps * 10) / 10 };
    // Six pollers ≈ six queries a second, plus the measuring queries themselves and
    // maintenance. Anything near an order of magnitude more would be a finding.
    expect(tps).toBeLessThan(30);
  });
});
