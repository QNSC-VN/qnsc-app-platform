import { dockerTestsEnabled } from '@quynhonsemiconductor/testing';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBoss, ensureQueues, type SpikeBoss } from '../support/boss.ts';
import { JOB_LOG_DDL, logRows, spawnWorker, type WorkerHandle } from '../support/child.ts';
import type { WorkerConfig } from '../support/worker-process.ts';
import { startCluster, type Cluster } from '../support/cluster.ts';
import { recordResult } from '../support/results.ts';
import { sleep, waitFor } from '../support/wait.ts';

/**
 * Scenario 7 (PORTFOLIO-TECH-REVIEW §2A.6):
 *
 *   Graceful shutdown during a pod drain.
 *   PASS: in-flight short jobs finish; long jobs resume on another worker.
 *
 * The worker is a real process and the drain is a real SIGTERM, handled the way WP-3's shared
 * shutdown hook will: stop fetching, `boss.stop({ graceful: true, timeout })`, close the pool,
 * exit. The timeout is the budget a pod has left after endpoint removal — 15 s here.
 */
const enabled = await dockerTestsEnabled();

const GRACE_MS = 15_000;
const SHORT_MS = 6_000;
const LONG_MS = 45_000;

describe.skipIf(!enabled)('scenario 7 — SIGTERM during a drain', () => {
  let cluster: Cluster;
  let pool: Pool;
  let boss: SpikeBoss;
  const workers: WorkerHandle[] = [];

  beforeAll(async () => {
    cluster = await startCluster();
    pool = cluster.pool(6);
    await pool.query(JOB_LOG_DDL);
    boss = createBoss(pool, { schedule: false });
    await boss.start();
    await ensureQueues(boss, [
      { name: 'drain.short', expireInSeconds: 60, retryLimit: 2, retryDelay: 0 },
      { name: 'drain.long', expireInSeconds: 900, retryLimit: 2, retryDelay: 0 },
      // The shutdown retry budget probe: a long job on a queue that allows no retries.
      { name: 'drain.dead' },
      { name: 'drain.noretry', expireInSeconds: 900, retryLimit: 0, deadLetter: 'drain.dead' },
    ]);
  });
  afterAll(async () => {
    for (const w of workers) w.signal('SIGKILL');
    await Promise.allSettled(workers.map((w) => w.exited));
    await boss?.stop({ graceful: true, timeout: 5_000 });
    await cluster?.stop();
  });

  const spawn = async (id: string, only?: string[]) => {
    const w = await spawnWorker(cluster, {
      id,
      stopTimeoutMs: GRACE_MS,
      handlers: (
        [
          {
            queue: 'drain.short',
            handler: { kind: 'sleep', durationMs: SHORT_MS },
            work: { localConcurrency: 4 },
          },
          { queue: 'drain.long', handler: { kind: 'sleep', durationMs: LONG_MS } },
          { queue: 'drain.noretry', handler: { kind: 'sleep', durationMs: LONG_MS } },
        ] satisfies WorkerConfig['handlers']
      ).filter((h) => (only ? only.includes(h.queue) : h.queue !== 'drain.noretry')),
    });
    workers.push(w);
    return w;
  };

  it('short jobs finish on the draining worker; the long job is handed to another worker', async () => {
    const a = await spawn('drain-A');
    const shortIds = [
      (await boss.send('drain.short', { n: 1 }))!,
      (await boss.send('drain.short', { n: 2 }))!,
      (await boss.send('drain.short', { n: 3 }))!,
    ];
    const longId = (await boss.send('drain.long', { asset: 'video-1' }))!;
    await waitFor(
      async () =>
        (await logRows(pool, "event = 'start' AND worker = 'drain-A'")).length >= 4 || undefined,
      'worker A to hold all four jobs',
    );
    const b = await spawn('drain-B');

    // The drain: SIGTERM, then a job arrives after it, which A must NOT take.
    await sleep(2_000);
    const termAt = Date.now();
    a.signal('SIGTERM');
    await sleep(500);
    const lateId = (await boss.send('drain.short', { n: 'late' }))!;

    const exit = await a.exited;
    const exitedAfterMs = Date.now() - termAt;
    expect(exit).toEqual({ code: 0, signal: null }); // clean exit, not a kill
    expect(exitedAfterMs, 'A overran its grace budget').toBeLessThan(GRACE_MS + 5_000);

    // B finishes the late short job and the handed-over long job.
    const done = (id: string) => async () =>
      (await pool.query("SELECT 1 FROM pgboss.job WHERE id = $1 AND state = 'completed'", [id]))
        .rowCount === 1 || undefined;
    await waitFor(done(longId), 'the long job to complete on B', {
      timeoutMs: 120_000,
      intervalMs: 500,
    });
    await waitFor(done(lateId), 'the late job to complete', { timeoutMs: 30_000, intervalMs: 500 });

    // (1) every short job that A held ran to the end on A.
    for (const id of shortIds) {
      const rows = await logRows(pool, 'job_id = $1', [id]);
      expect(
        rows.map((r) => `${r.event}:${r.worker}`),
        `short job ${id}`,
      ).toEqual(['start:drain-A', 'finish:drain-A']);
    }
    // (2) the long job was aborted on A when the grace budget ran out, then resumed on B.
    const longRows = await logRows(pool, 'job_id = $1', [longId]);
    expect(longRows.map((r) => `${r.event}:${r.worker}:${r.retry_count}`)).toEqual([
      'start:drain-A:0',
      'aborted:drain-A:0',
      'start:drain-B:1',
      'finish:drain-B:1',
    ]);
    // (3) the job that arrived after SIGTERM went to B, not A.
    const lateRows = await logRows(pool, 'job_id = $1', [lateId]);
    expect(lateRows[0]!.worker).toBe('drain-B');

    // What the drain cost the long job: one retry used, and the error pg-boss recorded.
    const { rows: long } = await pool.query<{
      retry_count: number;
      retry_limit: number;
      output: unknown;
    }>('SELECT retry_count, retry_limit, output FROM pgboss.job WHERE id = $1', [longId]);
    const stop = await logRows(pool, "event IN ('stop-begin','stop-end') AND worker = 'drain-A'");
    const abortedAt = longRows.find((r) => r.event === 'aborted')!.at.getTime();
    const resumedAt = longRows
      .find((r) => r.event === 'start' && r.worker === 'drain-B')!
      .at.getTime();
    recordResult('scenario-7', {
      graceBudgetMs: GRACE_MS,
      shortJobMs: SHORT_MS,
      longJobMs: LONG_MS,
      workerExitAfterSigtermMs: exitedAfterMs,
      workerExit: exit,
      shortJobsFinishedOnDrainingWorker: shortIds.length,
      longJobAbortedAfterSigtermMs: abortedAt - termAt,
      longJobResumedOnOtherWorkerAfterSigtermMs: resumedAt - termAt,
      longJobRetryCountAfterResume: long[0]!.retry_count,
      longJobRetryLimit: long[0]!.retry_limit,
      stopMessage: stop.map((s) => `${s.event} ${s.message}`),
      lateJobRanOn: lateRows[0]!.worker,
    });
    expect(b.proc.exitCode).toBeNull();
  });

  it('shutdown retry budget: a drain spends one retry — on a queue with retryLimit 0 the interrupted job FAILS and is dead-lettered', async () => {
    const a = await spawn('budget-A', ['drain.noretry']);
    const id = (await boss.send('drain.noretry', { asset: 'video-2' }))!;
    await waitFor(
      async () =>
        (await logRows(pool, "event = 'start' AND job_id = $1", [id])).length === 1 || undefined,
      'the job to start',
    );
    await spawn('budget-B', ['drain.noretry']); // a healthy peer exists, and still must not get the job
    a.signal('SIGTERM');
    expect(await a.exited).toEqual({ code: 0, signal: null });

    const { rows } = await pool.query<{ state: string; retry_count: number; output: unknown }>(
      'SELECT state, retry_count, output FROM pgboss.job WHERE id = $1',
      [id],
    );
    const { rows: dead } = await pool.query(
      "SELECT data FROM pgboss.job WHERE name = 'drain.dead'",
    );
    await sleep(3_000);
    const starts = await logRows(pool, "event = 'start' AND job_id = $1", [id]);
    recordResult('scenario-7', {
      retryLimit0Drain: {
        jobState: rows[0]!.state,
        deadLettered: dead.length,
        runsAfterDrain: starts.length - 1,
        output: rows[0]!.output,
      },
    });
    expect(rows[0]!.state).toBe('failed');
    expect(dead).toHaveLength(1);
    expect(starts, 'the job ran again although retryLimit is 0').toHaveLength(1);
  });
});
