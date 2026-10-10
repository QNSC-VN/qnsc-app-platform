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
    try {
      await waitFor(
        async () =>
          (await jobRows(h.adminPool, queue)).filter((r) => r.state === 'completed').length >= 3,
        { timeoutMs: 230_000, intervalMs: 1_000, message: 'three ticks' },
      );

      // A TICK has an identity, and it is not the minute a job happened to be created in (pg-boss
      // creates it when a 30 s cron pass finds it due). pg-boss files each occurrence as a job on
      // its internal send-it queue, whose payload carries the `slot` it belongs to; the send-it
      // handler then creates exactly one job for it on our queue.
      const { rows: occurrences } = await h.adminPool.query<{ slot: string; state: string }>(
        `SELECT data->>'slot' AS slot, state FROM pgboss.job
          WHERE name = '__pgboss__send-it' AND data->>'name' = $1 ORDER BY data->>'slot'`,
        [queue],
      );
      const slots = occurrences.map((o) => o.slot);
      const minutes = slots.map((slot) => Date.parse(`${slot.replace(' ', 'T')}Z`) / 60_000);
      expect(new Set(slots).size, `a tick was filed twice: ${slots.join(', ')}`).toBe(slots.length);
      expect(
        minutes.every((m, i) => i === 0 || m - minutes[i - 1]! === 1),
        `ticks were skipped: ${slots.join(', ')}`,
      ).toBe(true);

      // ONE job per tick: however many replicas registered the schedule, and in whichever pass.
      // (Counting jobs by creation minute missed a tick re-sent by a LATER pass.)
      const rows = await jobRows(h.adminPool, queue);
      const completedOccurrences = occurrences.filter((o) => o.state === 'completed').length;
      expect(
        rows.length,
        `${rows.length} jobs for ${slots.length} ticks: a tick produced more than one job`,
      ).toBeLessThanOrEqual(slots.length);
      expect(rows.length, 'a completed tick produced no job').toBeGreaterThanOrEqual(
        completedOccurrences,
      );

      // One execution per job: no job ran twice, and every completed job ran.
      const ranIds = ran.map((r) => r.jobId);
      expect(new Set(ranIds).size, 'a job ran more than once').toBe(ranIds.length);
      for (const row of rows.filter((r) => r.state === 'completed')) {
        expect(ranIds, `completed job ${row.id} never ran`).toContain(row.id);
      }

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
