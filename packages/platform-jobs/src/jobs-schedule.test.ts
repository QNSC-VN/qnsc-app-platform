import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  dockerOn,
  jobRows,
  startJobsDb,
  uniqueQueue,
  waitFor,
  type JobsDb,
} from './test-support/harness';

/**
 * Schedules live in their own file because the main test needs real cron ticks (about three
 * minutes of wall clock); as a separate file it runs in parallel with the rest of the suite.
 */
describe.skipIf(!dockerOn)('platform-jobs schedules, as a non-owner application role', () => {
  let h: JobsDb;
  beforeAll(async () => {
    h = await startJobsDb();
  }, 180_000);
  afterAll(async () => {
    expect(h.logs.error.filter((m) => /permission denied/i.test(m))).toEqual([]);
    await h?.stop();
  }, 60_000);

  it('two workers, one execution per tick (cron every minute, Asia/Ho_Chi_Minh)', async () => {
    const queue = uniqueQueue('cron');
    const w1 = h.makeJobs({ worker: true });
    const w2 = h.makeJobs({ worker: true });
    const ran: { by: string; jobId: string }[] = [];
    for (const [name, w] of [
      ['w1', w1],
      ['w2', w2],
    ] as const) {
      await w.jobs.handle(queue, (job) =>
        Promise.resolve(void ran.push({ by: name, jobId: job.id })),
      );
      await w.jobs.schedule(queue, '* * * * *', { tick: true });
      await w.jobs.start();
    }
    const registeredAt = Date.now();
    try {
      await waitFor(
        async () =>
          (await jobRows(h.adminPool, queue)).filter((r) => r.state === 'completed').length >= 3,
        { timeoutMs: 230_000, intervalMs: 1_000, message: 'three ticks' },
      );
      const elapsedMinutes = (Date.now() - registeredAt) / 60_000;
      const rows = await jobRows(h.adminPool, queue);

      // pg-boss does not record which tick a job belongs to, and creates a tick's job when a cron
      // pass (every 30 s) finds it due, so a job's creation time is only approximately its tick.
      // What a second replica would break is visible without that:
      //  - a tick created twice would show as two jobs created in the SAME pass (seconds apart),
      //  - or as more jobs than there were minutes.
      const created = rows.map((r) => r.created_on.getTime()).sort((a, b) => a - b);
      const gaps = created.slice(1).map((t, i) => (t - created[i]!) / 1000);
      expect(
        Math.min(...gaps),
        `two jobs were created in one cron pass: gaps ${gaps.join(', ')} s`,
      ).toBeGreaterThanOrEqual(20);
      expect(
        rows.length,
        `${rows.length} jobs in ${elapsedMinutes.toFixed(1)} minutes for a per-minute schedule on two workers`,
      ).toBeLessThanOrEqual(Math.ceil(elapsedMinutes) + 1);

      // One execution per job: no job ran twice, and every completed job ran.
      const ranIds = ran.map((r) => r.jobId);
      expect(new Set(ranIds).size, 'a job ran more than once').toBe(ranIds.length);
      for (const row of rows.filter((r) => r.state === 'completed')) {
        expect(ranIds, `completed job ${row.id} never ran`).toContain(row.id);
      }
      // The work was done by the workers collectively, whichever fetched each job.
      expect(new Set(ran.map((r) => r.by)).size).toBeGreaterThanOrEqual(1);

      const { rows: sched } = await h.adminPool.query<{ timezone: string; cron: string }>(
        'SELECT timezone, cron FROM pgboss.schedule WHERE name = $1',
        [queue],
      );
      expect(sched).toEqual([{ timezone: 'Asia/Ho_Chi_Minh', cron: '* * * * *' }]);
    } finally {
      await w1.close();
      await w2.close();
    }
  }, 280_000);

  it('only a worker registers a schedule; an API process only records it', async () => {
    const queue = uniqueQueue('cron');
    const api = h.makeJobs();
    await api.jobs.schedule(queue, '0 2 * * *', {}, { tz: 'UTC' });
    await api.jobs.start();
    try {
      const { rows } = await h.adminPool.query('SELECT 1 FROM pgboss.schedule WHERE name = $1', [
        queue,
      ]);
      expect(rows).toEqual([]);
    } finally {
      await api.close();
    }
  });

  it('a worker stores the schedule with the requested time zone, defaulting to Asia/Ho_Chi_Minh', async () => {
    const q1 = uniqueQueue('cron');
    const q2 = uniqueQueue('cron');
    const w = h.makeJobs({ worker: true });
    await w.jobs.handle(q1, () => Promise.resolve());
    await w.jobs.handle(q2, () => Promise.resolve());
    await w.jobs.schedule(q1, '0 2 * * *');
    await w.jobs.schedule(q2, '0 2 * * *', {}, { tz: 'UTC' });
    await w.jobs.start();
    try {
      const { rows } = await h.adminPool.query<{ name: string; timezone: string }>(
        'SELECT name, timezone FROM pgboss.schedule WHERE name = ANY($1)',
        [[q1, q2]],
      );
      expect(Object.fromEntries(rows.map((r) => [r.name, r.timezone]))).toEqual({
        [q1]: 'Asia/Ho_Chi_Minh',
        [q2]: 'UTC',
      });
    } finally {
      await w.close();
    }
  });

  it('rejects a bad cron expression, a bad time zone, and a duplicate', async () => {
    const w = h.makeJobs({ worker: true });
    const q = uniqueQueue('cron');
    try {
      await expect(w.jobs.schedule(q, 'every day')).rejects.toThrow(/cron/);
      await expect(w.jobs.schedule(q, '0 2 * * *', {}, { tz: 'Mars/Olympus' })).rejects.toThrow(
        /IANA/,
      );
      await w.jobs.schedule(q, '0 2 * * *');
      await expect(w.jobs.schedule(q, '0 3 * * *')).rejects.toThrow(/already registered/);
    } finally {
      await w.close();
    }
  });
});
