import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DELETION_LOCK_KEY_SQL, PendingMetrics, SWEEP_SQL, sweepPending } from './pending';
import {
  dockerOn,
  jobRows,
  sleep,
  startJobsDb,
  uniqueQueue,
  waitFor,
  type JobsDb,
} from './test-support/harness';

const DAY = 86_400;

/**
 * `retention.pending`: how long a job nobody processed may wait before it is deleted. Every claim in
 * the README about what pg-boss does with it is pinned here against a real PostgreSQL 18, as the
 * non-owner application role.
 */
describe.skipIf(!dockerOn)('retention.pending, as a non-owner application role', () => {
  let h: JobsDb;
  beforeAll(async () => {
    h = await startJobsDb();
  }, 180_000);
  afterAll(async () => {
    expect(h.logs.error.filter((m) => /permission denied/i.test(m))).toEqual([]);
    await h?.stop();
  }, 60_000);

  const queueRow = async (name: string) =>
    (
      await h.adminPool.query<{ retention_seconds: number }>(
        'SELECT retention_seconds FROM pgboss.queue WHERE name = $1',
        [name],
      )
    ).rows[0];
  const deadline = async (id: string) =>
    (
      await h.adminPool.query<{ ttl: number }>(
        'SELECT extract(epoch FROM keep_until - start_after)::int AS ttl FROM pgboss.job WHERE id = $1',
        [id],
      )
    ).rows[0]?.ttl;
  const exists = async (queue: string) => (await jobRows(h.adminPool, queue)).length > 0;

  describe('the configuration reaches pg-boss', () => {
    it("is written to the queue, defaults to pg-boss's 14 days, and converges when the code changes", async () => {
      const queue = uniqueQueue('pending');
      const plain = uniqueQueue('pending');
      const a = h.makeJobs();
      await a.jobs.defineQueue(queue, { retention: { pending: DAY } });
      await a.jobs.defineQueue(plain);
      await a.jobs.start();
      await a.close();
      expect(await queueRow(queue)).toEqual({ retention_seconds: DAY });
      expect(await queueRow(plain), 'the default must stay what it was').toEqual({
        retention_seconds: 14 * DAY,
      });

      const b = h.makeJobs();
      await b.jobs.defineQueue(queue, { retention: { pending: 2 * DAY } });
      await b.jobs.start();
      await b.close();
      expect(await queueRow(queue)).toEqual({ retention_seconds: 2 * DAY });
    });

    it('a job gets its deadline when it is INSERTED: start_after + pending, so a deferred job is not deleted before it is due', async () => {
      const queue = uniqueQueue('pending');
      const { jobs, close } = h.makeJobs();
      await jobs.defineQueue(queue, { retention: { pending: DAY } });
      await jobs.start();
      try {
        const now = (await jobs.send(queue, {}))!;
        const deferred = (await jobs.send(queue, {}, { startAfter: 7 * DAY }))!;
        expect(await deadline(now)).toBe(DAY);
        expect(await deadline(deferred), 'the window must start when the job becomes due').toBe(
          DAY,
        );
        const { rows } = await h.adminPool.query<{ days: number }>(
          'SELECT extract(epoch FROM keep_until - now())::int / 86400 AS days FROM pgboss.job WHERE id = $1',
          [deferred],
        );
        expect(rows[0]!.days).toBe(8);
      } finally {
        await close();
      }
    });

    it('changing the value affects jobs inserted LATER; jobs already waiting keep the deadline they were inserted with', async () => {
      const queue = uniqueQueue('pending');
      const v1 = h.makeJobs();
      await v1.jobs.defineQueue(queue, { retention: { pending: 10 * DAY } });
      await v1.jobs.start();
      const before = (await v1.jobs.send(queue, {}))!;
      await v1.close();

      const v2 = h.makeJobs();
      await v2.jobs.defineQueue(queue, { retention: { pending: DAY } });
      await v2.jobs.start();
      const after = (await v2.jobs.send(queue, {}))!;
      await v2.close();

      expect(await deadline(before), 'an already-waiting job was rewritten').toBe(10 * DAY);
      expect(await deadline(after)).toBe(DAY);
    });
  });

  describe('sweepPending deletes exactly what pg-boss would, and counts it', () => {
    /** A job in `state` with its deadline in the past (or the future). */
    async function seed(queue: string, state: string, expired: boolean): Promise<string> {
      const { jobs, close } = h.makeJobs();
      try {
        await jobs.defineQueue(queue, { retention: { pending: DAY } });
        await jobs.start();
        const id = (await jobs.send(queue, {}))!;
        await h.adminPool.query(
          `UPDATE pgboss.job SET state = $2, keep_until = now() ${expired ? "- interval '1 minute'" : "+ interval '1 hour'"} WHERE id = $1`,
          [id, state],
        );
        return id;
      } finally {
        await close();
      }
    }

    it.each([
      ['created', true, true],
      ['retry', true, true],
      ['active', true, false],
      ['completed', true, false],
      ['failed', true, false],
      ['created', false, false],
      ['retry', false, false],
    ])('a %s job whose deadline passed=%s is deleted: %s', async (state, expired, deleted) => {
      const queue = uniqueQueue('sweep');
      await seed(queue, state, expired);
      const result = await sweepPending(h.appPool, [queue]);
      expect(result.get(queue) ?? 0).toBe(deleted ? 1 : 0);
      expect(await exists(queue)).toBe(!deleted);
    });

    it('leaves a blocked job to pg-boss (a flow dependency, which platform-jobs does not expose)', async () => {
      const queue = uniqueQueue('sweep');
      const id = await seed(queue, 'created', true);
      await h.adminPool.query('UPDATE pgboss.job SET blocked = true WHERE id = $1', [id]);
      expect((await sweepPending(h.appPool, [queue])).size).toBe(0);
      expect(await exists(queue)).toBe(true);
    });

    it("takes pg-boss's own 'deletion' advisory lock: the same key, and it waits while another holds it", async () => {
      // 1. The key is the one pg-boss derives for its deletion (read from its own code, not retyped).
      const plans = (await import('pg-boss/dist/plans.js')) as unknown as {
        advisoryLockKey: (schema: string, key: string) => string;
      };
      const { rows } = await h.adminPool.query<{ same: boolean }>(
        `SELECT (${plans.advisoryLockKey('pgboss', 'jobdeletion')}) = (${DELETION_LOCK_KEY_SQL}) AS same`,
      );
      expect(rows[0]?.same, 'not the key pg-boss locks its deletion with').toBe(true);

      // 2. A holder of that lock (pg-boss's maintenance, in production) makes the sweep wait.
      const queue = uniqueQueue('sweep');
      await seed(queue, 'created', true);
      const holder = await h.adminPool.connect();
      let swept = false;
      try {
        await holder.query('BEGIN');
        await holder.query(`SELECT pg_advisory_xact_lock(${DELETION_LOCK_KEY_SQL})`);
        const sweeping = sweepPending(h.appPool, [queue]).then((result) => {
          swept = true;
          return result;
        });
        await sleep(1_500);
        expect(swept, 'the sweep did not wait for the lock').toBe(false);
        expect(await exists(queue)).toBe(true);
        await holder.query('COMMIT');
        expect((await sweeping).get(queue)).toBe(1);
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        holder.release();
      }
    });

    it("can use pg-boss's partial index of waiting jobs (NOT blocked), instead of reading the table", async () => {
      const queue = uniqueQueue('sweep');
      await seed(queue, 'created', true);
      const explain = async (sql: string) => {
        const client = await h.adminPool.connect();
        try {
          await client.query('BEGIN');
          await client.query('SET LOCAL enable_seqscan = off');
          const { rows } = await client.query<Record<string, string>>(`EXPLAIN ${sql}`, [[queue]]);
          return rows.map((r) => Object.values(r)[0]).join('\n');
        } finally {
          await client.query('ROLLBACK');
          client.release();
        }
      };
      expect(await explain(SWEEP_SQL)).toMatch(/job_common_i11/);
      // The control: without the predicate the partial index cannot be used.
      expect(await explain(SWEEP_SQL.replace(' AND NOT blocked', ''))).not.toMatch(
        /job_common_i11/,
      );
    });

    it('only the queues it is given', async () => {
      const mine = uniqueQueue('sweep');
      const other = uniqueQueue('sweep');
      await seed(mine, 'created', true);
      await seed(other, 'created', true);
      expect([...(await sweepPending(h.appPool, [mine]))]).toEqual([[mine, 1]]);
      expect(await exists(other), "another queue's job was deleted").toBe(true);
    });

    it('is a no-op for no queues', async () => {
      expect((await sweepPending(h.appPool, [])).size).toBe(0);
    });
  });

  describe('a worker reports what it drops', () => {
    it('logs a COUNT per queue (never a payload) and increments queue.pending_dropped; queues that did not ask are left to pg-boss', async () => {
      const record = vi.spyOn(PendingMetrics.prototype, 'record');
      const watched = uniqueQueue('report');
      const unwatched = uniqueQueue('report');
      const worker = h.makeJobs({ worker: true, pendingSweepSeconds: 1 });
      await worker.jobs.handle(watched, () => Promise.resolve(), { retention: { pending: DAY } });
      await worker.jobs.handle(unwatched, () => Promise.resolve());
      await worker.jobs.start();
      try {
        // Not due for an hour, so no worker fetches them; their deadlines are then in the past.
        const a = await worker.jobs.send(watched, { token: 'SECRET-LINK-1' }, { startAfter: 3600 });
        const b = await worker.jobs.send(watched, { token: 'SECRET-LINK-2' }, { startAfter: 3600 });
        const c = await worker.jobs.send(
          unwatched,
          { token: 'SECRET-LINK-3' },
          { startAfter: 3600 },
        );
        await h.adminPool.query(
          "UPDATE pgboss.job SET keep_until = now() - interval '1 second' WHERE id = ANY($1)",
          [[a, b, c]],
        );

        await waitFor(async () => !(await exists(watched)), {
          message: 'the watched queue to be swept',
        });
        await waitFor(() => record.mock.calls.some(([q]) => q === watched), {
          message: 'the metric',
        });

        expect(record.mock.calls.filter(([q]) => q === watched)).toEqual([[watched, 2]]);
        const lines = h.logs.warn.filter((m) => m.includes(watched));
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(
          /2 jobs on ".*" waited past retention.pending \(86400 s\) without being processed and were deleted/,
        );
        expect(h.logs.warn.join('\n')).not.toMatch(/SECRET-LINK/);

        await sleep(2_500);
        expect(await exists(unwatched), 'a queue that never asked had its jobs swept').toBe(true);
        expect(record.mock.calls.some(([q]) => q === unwatched)).toBe(false);
      } finally {
        record.mockRestore();
        await worker.close();
      }
    }, 60_000);

    it("sweeps ONCE AT START: an outage's backlog is reported before pg-boss's own first pass can delete it silently", async () => {
      const queue = uniqueQueue('report');
      const config = { retention: { pending: DAY } } as const;
      // The backlog: three jobs that expired while no worker ran.
      const before = h.makeJobs();
      await before.jobs.defineQueue(queue, config);
      await before.jobs.start();
      const ids: string[] = [];
      for (const n of [1, 2, 3]) {
        ids.push(
          (await before.jobs.send(queue, { n, token: 'BACKLOG-SECRET' }, { startAfter: 3600 }))!,
        );
      }
      await h.adminPool.query(
        "UPDATE pgboss.job SET keep_until = now() - interval '1 second' WHERE id = ANY($1)",
        [ids],
      );
      await before.close();

      // The interval is an hour, so only the sweep at start can report. pg-boss's own supervise
      // pass (every 15 s by default) and its deletion come later.
      const worker = h.makeJobs({ worker: true, pendingSweepSeconds: 3600 });
      await worker.jobs.defineQueue(queue, config);
      await worker.jobs.start();
      try {
        await waitFor(() => h.logs.warn.some((m) => m.includes(queue)), {
          timeoutMs: 8_000,
          message: 'the backlog to be reported at start',
        });
        expect(h.logs.warn.filter((m) => m.includes(queue))).toEqual([
          expect.stringMatching(
            /3 jobs on ".*" waited past retention.pending \(86400 s\).*were deleted/,
          ),
        ]);
        expect(h.logs.warn.join('\n')).not.toContain('BACKLOG-SECRET');
        expect(await exists(queue)).toBe(false);
      } finally {
        await worker.close(500);
      }
    }, 60_000);

    it('an API process does not sweep (one worker is enough)', async () => {
      const queue = uniqueQueue('report');
      const api = h.makeJobs({ pendingSweepSeconds: 1 });
      await api.jobs.defineQueue(queue, { retention: { pending: DAY } });
      await api.jobs.start();
      try {
        const id = (await api.jobs.send(queue, {}, { startAfter: 3600 }))!;
        await h.adminPool.query(
          "UPDATE pgboss.job SET keep_until = now() - interval '1 second' WHERE id = $1",
          [id],
        );
        await sleep(2_500);
        expect(await exists(queue)).toBe(true);
      } finally {
        await api.close();
      }
    });
  });

  describe('what pg-boss does with the window, end to end', () => {
    it('deletes a job nobody fetched after the real window; a job waiting to RETRY is deleted at its own deadline; a job being PROCESSED is left alone', async () => {
      // The unfetched queue uses a REAL 80 s window: the shortest the validation allows without
      // retries, (0 + 1) x (5 + 75) = 80 s (75 s is how late pg-boss notices an expired attempt).
      const unfetchedConfig = {
        retention: { pending: 80 },
        retryLimit: 0,
        acceptDeadLetterOnDrain: true, // retryLimit 0 needs it; nothing is fetched here anyway
        expireInSeconds: 5,
      } as const;
      // The queues with retries need at least (1 + 1) x (10 + 75) + 30 = 200 s; their deadlines are
      // then moved with SQL, below, to show what pg-boss does at a deadline.
      const retryConfig = {
        retention: { pending: 300 },
        retryLimit: 1,
        expireInSeconds: 10,
        retryDelaySeconds: 5,
        retryDelayMaxSeconds: 30,
      } as const;
      const unfetched = uniqueQueue('window');
      const retrying = uniqueQueue('window');
      const processing = uniqueQueue('window');

      const worker = h.makeJobs({ worker: true, pendingSweepSeconds: 2 });
      // Defined in the worker WITHOUT a handler: nothing will ever fetch its jobs, and the worker
      // watches it (it asked for retention.pending).
      await worker.jobs.defineQueue(unfetched, unfetchedConfig);
      const attempts: number[] = [];
      await worker.jobs.handle(
        retrying,
        (job) => {
          attempts.push(job.attempt);
          return Promise.reject(new Error('transient'));
        },
        { ...retryConfig, retryDelaySeconds: 30 },
      );
      let finished = false;
      await worker.jobs.handle(
        processing,
        async () => {
          await sleep(25_000);
          finished = true;
        },
        {
          retention: { pending: 300 },
          retryLimit: 1,
          expireInSeconds: 60,
          retryDelaySeconds: 5,
          retryDelayMaxSeconds: 30,
        },
      );
      await worker.jobs.start();
      const startedAt = Date.now();
      try {
        await worker.jobs.send(unfetched, { secret: 'BEARER-LINK' });
        const retryId = (await worker.jobs.send(retrying, { n: 1 }))!;
        const processId = (await worker.jobs.send(processing, { n: 1 }))!;
        await waitFor(async () => (await jobRows(h.adminPool, retrying))[0]?.state === 'retry', {
          message: 'the first attempt to fail and wait for its retry',
        });
        await waitFor(async () => (await jobRows(h.adminPool, processing))[0]?.state === 'active', {
          message: 'the long job to be fetched',
        });

        // pg-boss semantics, pinned directly: the two deadlines are moved to ten seconds from now,
        // which the validation would not allow as a configuration (it refuses a window shorter than the
        // retries, precisely because of what these two jobs show). One is still WAITING TO RETRY (its
        // retry is 30 s away), one is ACTIVE.
        await h.adminPool.query(
          "UPDATE pgboss.job SET keep_until = now() + interval '10 seconds' WHERE id = ANY($1)",
          [[retryId, processId]],
        );

        await waitFor(async () => !(await exists(retrying)), {
          timeoutMs: 30_000,
          message: 'the job waiting to retry to be deleted at its deadline',
        });
        // Past the deadline and still there: the job being processed.
        expect(
          (await jobRows(h.adminPool, processing))[0]?.state,
          'a job being processed was deleted',
        ).toBe('active');
        expect(attempts, 'a retry extended the deadline, or ran').toEqual([1]);
        expect(
          await jobRows(h.adminPool, `${retrying}.dlq`),
          'a dropped job leaves no dead letter',
        ).toEqual([]);

        await waitFor(() => finished, { timeoutMs: 40_000, message: 'the long job to finish' });
        await waitFor(
          async () => (await jobRows(h.adminPool, processing))[0]?.state === 'completed',
          {
            message: 'its completion: the deadline never applied to it',
          },
        );

        // The genuinely unfetched job: present until the real window ends, then gone, with no dead letter.
        expect(await exists(unfetched)).toBe(true);
        await waitFor(async () => !(await exists(unfetched)), {
          timeoutMs: 90_000,
          message: 'the 80 s window to delete the job nobody fetched',
        });
        const waited = (Date.now() - startedAt) / 1000;
        expect(waited, 'deleted before its deadline').toBeGreaterThanOrEqual(78);
        expect(await jobRows(h.adminPool, `${unfetched}.dlq`)).toEqual([]);
        expect(
          h.logs.warn.some((m) => m.includes(unfetched) && /1 job on .* waited past/.test(m)),
        ).toBe(true);
        expect(h.logs.warn.join('\n')).not.toContain('BEARER-LINK');
      } finally {
        await worker.close(500);
      }
    }, 200_000);

    it('a queue nobody watches is cleaned by pg-boss alone: silently, and up to a maintenance interval late', async () => {
      const queue = uniqueQueue('window');
      const api = h.makeJobs({ pendingSweepSeconds: 1, maintenanceIntervalSeconds: 3 });
      const config = {
        retention: { pending: 300 },
        retryLimit: 1,
        expireInSeconds: 10,
        retryDelaySeconds: 5,
        retryDelayMaxSeconds: 30,
      };
      await api.jobs.defineQueue(queue, config);
      await api.jobs.start();
      try {
        const id = (await api.jobs.send(queue, { secret: 'QUIET' }))!;
        await h.adminPool.query(
          "UPDATE pgboss.job SET keep_until = now() - interval '1 second' WHERE id = $1",
          [id],
        );
        // Only a worker watches; an API process does not. pg-boss's maintenance pass needs a
        // SUPERVISING instance, and an API process does not supervise either: the job simply stays
        // until some worker's pass (or ours) runs. This is why retention.pending belongs where the
        // queue's worker defines it.
        await sleep(6_000);
        expect(await exists(queue)).toBe(true);
        const worker = h.makeJobs({
          worker: true,
          maintenanceIntervalSeconds: 3,
          pendingSweepSeconds: 3600,
        });
        await worker.jobs.start(); // supervises: pg-boss's own deletion runs, with no report
        try {
          await waitFor(async () => !(await exists(queue)), {
            timeoutMs: 30_000,
            message: "pg-boss's own deletion",
          });
          expect(h.logs.warn.some((m) => m.includes(queue))).toBe(false);
        } finally {
          await worker.close(500);
        }
      } finally {
        await api.close();
      }
    }, 60_000);

    it('a worker that DEFINES the queue watches it: a dropped job is reported within a sweep', async () => {
      const queue = uniqueQueue('window');
      const worker = h.makeJobs({ worker: true, pendingSweepSeconds: 2 });
      await worker.jobs.handle(queue, () => Promise.resolve(), {
        retention: { pending: 300 },
        retryLimit: 1,
        expireInSeconds: 10,
        retryDelaySeconds: 5,
        retryDelayMaxSeconds: 30,
      });
      await worker.jobs.start();
      const startedAt = Date.now();
      try {
        // Deferred just past the window, so it can never be fetched before it is dropped.
        const id = (await worker.jobs.send(queue, { secret: 'BEARER-LINK-2' }, { startAfter: 1 }))!;
        await h.adminPool.query(
          "UPDATE pgboss.job SET start_after = now() + interval '1 hour', keep_until = now() + interval '4 seconds' WHERE id = $1",
          [id],
        );
        await waitFor(async () => !(await exists(queue)), {
          timeoutMs: 80_000,
          message: 'the drop',
        });
        expect((Date.now() - startedAt) / 1000).toBeGreaterThanOrEqual(3);
        expect(
          h.logs.warn.some(
            (m) =>
              m.includes(queue) && /1 job on .* waited past retention.pending \(300 s\)/.test(m),
          ),
        ).toBe(true);
        expect(h.logs.warn.join('\n')).not.toContain('BEARER-LINK-2');
      } finally {
        await worker.close(500);
      }
    }, 120_000);
  });
});
