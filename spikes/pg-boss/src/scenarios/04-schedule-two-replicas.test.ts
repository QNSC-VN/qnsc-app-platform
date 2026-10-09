import { dockerTestsEnabled } from '@quynhonsemiconductor/testing';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBoss, ensureQueues, type SpikeBoss } from '../support/boss.ts';
import { JOB_LOG_DDL, logRows, spawnWorker, type WorkerHandle } from '../support/child.ts';
import { startCluster, type Cluster } from '../support/cluster.ts';
import { recordResult } from '../support/results.ts';
import { waitFor } from '../support/wait.ts';

/**
 * Scenario 4 (PORTFOLIO-TECH-REVIEW §2A.6):
 *
 *   Daily schedule with two worker replicas.
 *   PASS: runs exactly once per tick.
 *
 * A daily cron cannot be waited for, so the tick is shortened to one minute (cron's finest
 * resolution) and observed over ten of them. Two worker PROCESSES are running before the first
 * tick; a third joins mid-run; the one that was running first is SIGKILLed later. Through all of
 * it every tick must produce one job and one execution, and none may be skipped. The timezone
 * arithmetic of a real daily schedule (`0 2 * * *` in Asia/Ho_Chi_Minh) is checked separately,
 * without waiting a day, against pg-boss's own schedule preview.
 */
const enabled = await dockerTestsEnabled();
const QUEUE = 'report.daily';

describe.skipIf(!enabled)('scenario 4 — schedule with several worker replicas', () => {
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
    await ensureQueues(boss, [QUEUE]);
  });
  afterAll(async () => {
    for (const w of workers) w.signal('SIGKILL');
    await Promise.allSettled(workers.map((w) => w.exited));
    await boss?.stop({ graceful: true, timeout: 5_000 });
    await cluster?.stop();
  });

  const replica = async (id: string) => {
    const w = await spawnWorker(cluster, {
      id,
      handlers: [{ queue: QUEUE, handler: { kind: 'noop' } }],
    });
    workers.push(w);
    return w;
  };

  const ticks = async () => {
    const { rows } = await pool.query<{ slot: Date; jobs: string; ids: string[] }>(
      // pg-boss creates the job for a tick when a cron pass finds the tick has passed (every 30 s,
      // one instance per pass), so created_on is a little AFTER the tick and start_after = created_on.
      // The tick a job belongs to is therefore the minute it was created in.
      `SELECT date_trunc('minute', created_on) AS slot, count(*) AS jobs, array_agg(id::text) AS ids
         FROM pgboss.job WHERE name = $1 GROUP BY 1 ORDER BY 1`,
      [QUEUE],
    );
    return rows;
  };

  it('a daily schedule in Asia/Ho_Chi_Minh is computed in that zone (preview, no waiting)', async () => {
    const [next] = boss.previewSchedule('0 2 * * *', {
      tz: 'Asia/Ho_Chi_Minh',
      from: new Date('2026-10-09T00:00:00Z'),
      count: 1,
    });
    // 02:00 in UTC+7 is 19:00 UTC of the previous day; the next one after 2026-10-09 00:00Z is
    // 02:00 on 2026-10-09 local = 2026-10-08 19:00Z is already past, so 2026-10-09 19:00Z.
    expect(next!.toISOString()).toBe('2026-10-09T19:00:00.000Z');
  });

  it(
    '10 consecutive ticks, 2→3 replicas, one SIGKILLed: exactly one job and one run per tick',
    async () => {
      await replica('replica-A');
      await replica('replica-B');
      await boss.schedule(QUEUE, '* * * * *', { kind: 'tick' }, { tz: 'Asia/Ho_Chi_Minh' });
      const [schedule] = await boss.getSchedules(QUEUE);
      expect(schedule!.timezone).toBe('Asia/Ho_Chi_Minh');

      // Tick 3: a third replica joins. Tick 6: the oldest one dies without warning.
      await waitFor(async () => (await ticks()).length >= 3 || undefined, 'three ticks', {
        timeoutMs: 6 * 60_000,
        intervalMs: 1_000,
      });
      await replica('replica-C');
      await waitFor(async () => (await ticks()).length >= 6 || undefined, 'six ticks', {
        timeoutMs: 6 * 60_000,
        intervalMs: 1_000,
      });
      workers[0]!.signal('SIGKILL');
      await workers[0]!.exited;
      await waitFor(async () => (await ticks()).length >= 10 || undefined, 'ten ticks', {
        timeoutMs: 8 * 60_000,
        intervalMs: 1_000,
      });
      // Let the last tick be handled.
      await waitFor(
        async () => (await logRows(pool, "event = 'finish'")).length >= 10 || undefined,
        'the last tick to be handled',
        { timeoutMs: 30_000, intervalMs: 500 },
      );

      const all = await ticks();
      const slots = all.map((t) => t.slot.getTime());
      // One job per slot — never two replicas each creating their own.
      expect(all.map((t) => Number(t.jobs))).toEqual(all.map(() => 1));
      // No tick skipped, including across the SIGKILL: slots are consecutive minutes.
      const gaps = slots.slice(1).map((s, i) => (s - slots[i]!) / 60_000);
      expect(gaps, 'a tick was skipped').toEqual(gaps.map(() => 1));

      // One execution per job.
      const starts = await logRows(pool, "event = 'start'");
      const perJob = new Map<string, number>();
      for (const s of starts) perJob.set(s.job_id!, (perJob.get(s.job_id!) ?? 0) + 1);
      expect([...perJob.values()].every((n) => n === 1)).toBe(true);
      expect(perJob.size).toBe(all.length);

      // Which replica ran which tick — shows the work really was shared, not pinned.
      const byWorker: Record<string, number> = {};
      for (const s of starts) byWorker[s.worker] = (byWorker[s.worker] ?? 0) + 1;
      recordResult('scenario-4', {
        ticks: all.length,
        jobsPerTick: all.map((t) => Number(t.jobs)),
        gapsMinutes: gaps,
        executionsPerJob: [...perJob.values()],
        executionsByReplica: byWorker,
        replicaKilledAfterTick: 6,
        replicaJoinedAfterTick: 3,
        timezone: schedule!.timezone,
        dailyPreviewUtc: '2026-10-09T19:00:00.000Z',
      });
    },
    25 * 60_000,
  );
});
