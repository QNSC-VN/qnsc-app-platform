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
 * Scenario 2 at full length, in real time:
 *
 *   30-minute fake transcode; worker killed mid-run.
 *   PASS: job re-leased after expiry and completed once.
 *
 * Three jobs run side by side against one Postgres, each with its own pair of worker processes:
 *
 *   control    — nobody is killed: the job must run once and must not be stolen by the idle peer
 *                for its whole 30 minutes (the lease is 45 minutes).
 *   expiry     — worker A is SIGKILLed 10 minutes in; recovery relies on `expireInSeconds` alone.
 *                Literal reading of the scenario: the job comes back when the 45-minute lease ends.
 *   heartbeat  — same kill, but the queue sets `heartbeatSeconds: 30`: recovery should take about
 *                a minute, not the rest of the lease.
 *
 * Run: pnpm --filter @quynhonsemiconductor/spike-pg-boss exec vitest run --config vitest.bench.config.ts src/bench/transcode.run.ts
 * Takes about 80 minutes (the expiry job: 45 min lease + 30 min re-run).
 */
const enabled = await dockerTestsEnabled();

const JOB_MS = 30 * 60_000;
const EXPIRE_S = 45 * 60;
const KILL_AFTER_MS = 10 * 60_000;

describe.skipIf(!enabled)('scenario 2 — full length, real time', () => {
  let cluster: Cluster;
  let pool: Pool;
  let boss: SpikeBoss;
  const workers: WorkerHandle[] = [];

  beforeAll(async () => {
    cluster = await startCluster();
    pool = cluster.pool(8);
    await pool.query(JOB_LOG_DDL);
    boss = createBoss(pool, { schedule: false });
    await boss.start();
    await ensureQueues(boss, [
      { name: 'transcode.control', expireInSeconds: EXPIRE_S, retryLimit: 2, retryDelay: 0 },
      { name: 'transcode.expiry', expireInSeconds: EXPIRE_S, retryLimit: 2, retryDelay: 0 },
      {
        name: 'transcode.heartbeat',
        expireInSeconds: EXPIRE_S,
        heartbeatSeconds: 30,
        retryLimit: 2,
        retryDelay: 0,
      },
    ]);
  });
  afterAll(async () => {
    // Evidence first: nothing below may stand between a finished run and its numbers.
    for (const w of workers) w.signal('SIGKILL');
    await Promise.allSettled(workers.map((w) => w.exited));
    await boss?.stop({ graceful: true, timeout: 5_000 }).catch(() => undefined);
    await cluster?.stop();
  }, 600_000);

  async function pair(variant: string) {
    const queue = `transcode.${variant}`;
    const spawn = async (suffix: string) => {
      const w = await spawnWorker(cluster, {
        id: `${variant}-${suffix}`,
        handlers: [{ queue, handler: { kind: 'transcode', durationMs: JOB_MS } }],
      });
      workers.push(w);
      return w;
    };
    const a = await spawn('A');
    const id = (await boss.send(queue, { asset: `full-${variant}` }))!;
    const timeline = trackJob(pool, id, 1000);
    await waitFor(
      async () => (await logRows(pool, "event = 'start' AND job_id = $1", [id]))[0],
      `${variant}: worker A to start`,
    );
    await spawn('B');
    return { queue, id, a, timeline };
  }

  const completed = (id: string) => async () =>
    (await pool.query("SELECT 1 FROM pgboss.job WHERE id=$1 AND state='completed'", [id]))
      .rowCount === 1 || undefined;

  it('control + expiry + heartbeat, in parallel', async () => {
    const [control, expiry, heartbeat] = await Promise.all([
      pair('control'),
      pair('expiry'),
      pair('heartbeat'),
    ]);

    await sleep(KILL_AFTER_MS);
    const killedAt = Date.now();
    expiry.a.signal('SIGKILL');
    heartbeat.a.signal('SIGKILL');
    await Promise.all([expiry.a.exited, heartbeat.a.exited]);

    const opts = { timeoutMs: 3 * 3600_000, intervalMs: 5_000 };
    await Promise.all([
      waitFor(completed(control.id), 'control to complete', opts),
      waitFor(completed(expiry.id), 'expiry to complete', opts),
      waitFor(completed(heartbeat.id), 'heartbeat to complete', opts),
    ]);
    await Promise.all([control.timeline.stop(), expiry.timeline.stop(), heartbeat.timeline.stop()]);

    const summary: Record<string, unknown> = { jobMs: JOB_MS, expireInSeconds: EXPIRE_S };
    for (const [name, run, killed] of [
      ['control', control, false],
      ['expiry', expiry, true],
      ['heartbeat', heartbeat, true],
    ] as const) {
      const starts = await logRows(pool, "event = 'start' AND job_id = $1", [run.id]);
      const finishes = await logRows(pool, "event = 'finish' AND job_id = $1", [run.id]);
      const { rows: done } = await pool.query(
        'SELECT worker FROM transcode_done WHERE job_key = $1',
        [`full-${name}`],
      );
      summary[name] = {
        starts: starts.map((s) => ({ worker: s.worker, retryCount: s.retry_count, at: s.at })),
        finishes: finishes.map((f) => ({ worker: f.worker, at: f.at })),
        sideEffects: done.length,
        sequence: run.timeline.sequence().filter((s) => s !== 'created#0'),
        ...(killed
          ? {
              killToReLeaseMs: starts[1]!.at.getTime() - killedAt,
              startToReLeaseMs: starts[1]!.at.getTime() - starts[0]!.at.getTime(),
            }
          : {}),
      };
      // The scenario's pass condition, per job.
      expect(finishes, `${name}: completed more or less than once`).toHaveLength(1);
      expect(done, `${name}: side effect not exactly once`).toHaveLength(1);
      expect(starts).toHaveLength(killed ? 2 : 1);
      if (name === 'expiry') {
        expect(starts[1]!.at.getTime() - starts[0]!.at.getTime()).toBeGreaterThanOrEqual(
          EXPIRE_S * 1000,
        );
      }
    }
    recordResult('scenario-2-full', summary);
  });
});
