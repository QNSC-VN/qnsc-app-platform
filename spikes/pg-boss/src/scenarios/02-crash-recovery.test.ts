import { dockerTestsEnabled } from '@quynhonsemiconductor/testing';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBoss, ensureQueues, type SpikeBoss } from '../support/boss.ts';
import { JOB_LOG_DDL, logRows, spawnWorker, type WorkerHandle } from '../support/child.ts';
import { startCluster, type Cluster } from '../support/cluster.ts';
import { recordResult } from '../support/results.ts';
import { trackJob } from '../support/timeline.ts';
import { sleep, waitFor } from '../support/wait.ts';

/**
 * Scenario 2 (PORTFOLIO-TECH-REVIEW §2A.6), time-compressed so it fits a test run:
 *
 *   30-minute fake transcode; worker killed mid-run.
 *   PASS: job re-leased after expiry and completed once.
 *
 * Here the "30 minutes" is 40 s and `expireInSeconds` 60 s; the real-length run (30 min,
 * expire 45 min) is `bench/transcode.run.ts`, and its numbers are in the ADR next to these.
 * The worker is a real OS process and the kill is SIGKILL: no handler runs, no connection is
 * closed cleanly, which is the whole point.
 */
const enabled = await dockerTestsEnabled();

const DURATION_MS = 40_000;
const EXPIRE_S = 60;
const KILL_AFTER_MS = 15_000;

describe.skipIf(!enabled)('scenario 2 — worker SIGKILLed mid-job (time-compressed)', () => {
  let cluster: Cluster;
  let pool: Pool;
  let boss: SpikeBoss;
  const workers: WorkerHandle[] = [];
  const results: Record<string, unknown> = {};

  beforeAll(async () => {
    cluster = await startCluster();
    pool = cluster.pool(8);
    await pool.query(JOB_LOG_DDL);
    // The parent is the "API": it creates the schema and queues, sends jobs, runs no handlers.
    boss = createBoss(pool, { schedule: false });
    await boss.start();
    await ensureQueues(boss, [
      { name: 'transcode.expiry', expireInSeconds: EXPIRE_S, retryLimit: 2, retryDelay: 0 },
      {
        name: 'transcode.heartbeat',
        expireInSeconds: 3600,
        heartbeatSeconds: 10,
        retryLimit: 2,
        retryDelay: 0,
      },
      { name: 'transcode.healthy', expireInSeconds: EXPIRE_S, retryLimit: 2, retryDelay: 0 },
    ]);
  });
  afterAll(async () => {
    recordResult('scenario-2-compressed', results);
    for (const w of workers) w.signal('SIGKILL');
    await Promise.allSettled(workers.map((w) => w.exited));
    await boss?.stop({ graceful: true, timeout: 5_000 });
    await cluster?.stop();
  });

  const worker = async (id: string, queue: string, durationMs = DURATION_MS) => {
    const w = await spawnWorker(cluster, {
      id,
      handlers: [{ queue, handler: { kind: 'transcode', durationMs } }],
    });
    workers.push(w);
    return w;
  };

  it('control: with two healthy workers the job runs exactly once and is not stolen', async () => {
    const queue = 'transcode.healthy';
    await worker('h1', queue, 25_000);
    await worker('h2', queue, 25_000);
    const id = (await boss.send(queue, { asset: 'healthy-1' }))!;
    await waitFor(
      async () =>
        (await pool.query("SELECT 1 FROM pgboss.job WHERE id=$1 AND state='completed'", [id]))
          .rowCount === 1 || undefined,
      'the job to complete',
      { timeoutMs: 120_000, intervalMs: 500 },
    );
    const starts = await logRows(pool, "event = 'start' AND job_id = $1", [id]);
    expect(starts).toHaveLength(1);
    results['healthyStarts'] = starts.length;
  });

  it.each([
    { variant: 'expiry', queue: 'transcode.expiry', asset: 'expiry-1' },
    { variant: 'heartbeat', queue: 'transcode.heartbeat', asset: 'heartbeat-1' },
  ])(
    '$variant: killed mid-run, the job is re-leased and completes once',
    async ({ variant, queue, asset }) => {
      const a = await worker(`${variant}-A`, queue);
      const id = (await boss.send(queue, { asset }))!;
      const timeline = trackJob(pool, id);

      const firstStart = await waitFor(
        async () => (await logRows(pool, "event = 'start' AND job_id = $1", [id]))[0],
        'worker A to start the job',
      );
      expect(firstStart.worker).toBe(`${variant}-A`);
      // B joins only now, so it cannot have been the one to take the job first.
      const b = await worker(`${variant}-B`, queue);
      await sleep(Math.max(0, KILL_AFTER_MS - (Date.now() - firstStart.at.getTime())));

      const killedAt = Date.now();
      a.signal('SIGKILL');
      const exit = await a.exited;
      expect(exit.signal).toBe('SIGKILL');

      await waitFor(
        async () =>
          (await pool.query("SELECT 1 FROM pgboss.job WHERE id=$1 AND state='completed'", [id]))
            .rowCount === 1 || undefined,
        'the re-leased job to complete',
        { timeoutMs: 240_000, intervalMs: 500 },
      );
      await timeline.stop();

      const starts = await logRows(pool, "event = 'start' AND job_id = $1", [id]);
      const finishes = await logRows(pool, "event = 'finish' AND job_id = $1", [id]);
      expect(starts.map((s) => `${s.worker}#${s.retry_count}`)).toEqual([
        `${variant}-A#0`,
        `${variant}-B#1`,
      ]);
      // Exactly one completion: the killed attempt never reached `finish`.
      expect(finishes.map((f) => f.worker)).toEqual([`${variant}-B`]);
      const { rows: done } = await pool.query(
        'SELECT worker FROM transcode_done WHERE job_key = $1',
        [asset],
      );
      expect(done, 'the side effect happened more than once').toEqual([{ worker: `${variant}-B` }]);
      // The state machine went active → retry → active → completed (the `retry` state may be too
      // brief for the poller to see; what matters is retry_count went 0 → 1).
      const sequence = timeline.sequence().filter((step) => step !== 'created#0');
      expect(sequence.at(0)).toBe('active#0');
      expect(sequence.at(-1)).toBe('completed#1');
      expect(sequence).toContain('active#1');
      expect(b.proc.exitCode).toBeNull(); // B is still alive

      const reLeaseMs = starts[1]!.at.getTime() - killedAt;
      results[variant] = {
        jobMs: DURATION_MS,
        expireInSeconds: variant === 'expiry' ? EXPIRE_S : 3600,
        heartbeatSeconds: variant === 'heartbeat' ? 10 : null,
        killedAfterStartMs: killedAt - starts[0]!.at.getTime(),
        killToReLeaseMs: reLeaseMs,
        startToReLeaseMs: starts[1]!.at.getTime() - starts[0]!.at.getTime(),
        sequence,
        completions: finishes.length,
        sideEffects: done.length,
      };
      if (variant === 'expiry') {
        // Re-leased only once the lease (counted from the START of the attempt) ran out, never
        // before: stealing a live job would be a double run.
        expect(starts[1]!.at.getTime() - starts[0]!.at.getTime()).toBeGreaterThanOrEqual(
          EXPIRE_S * 1000,
        );
      }
    },
  );

  it('pg-boss emitted no errors in the parent', () => {
    expect(boss.errors).toEqual([]);
  });
});
