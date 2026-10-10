import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JobsConfigError } from './config';
import { PermanentJobError } from './errors';
import { idempotencyId } from './idempotency';
import type { HandleOptions, Jobs, RedriveOptions } from './types';
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

/** How many a redrive moved. (`skipped` has its own tests.) */
const redriven = async (jobs: Jobs, dlq: string, options?: RedriveOptions): Promise<number> =>
  (await jobs.redrive(dlq, options)).moved;

describe.skipIf(!dockerOn)('jobs.redrive, as a non-owner application role', () => {
  let h: JobsDb;
  beforeAll(async () => {
    h = await startJobsDb();
  }, 180_000);
  afterAll(async () => {
    expect(h.logs.error.filter((m) => /permission denied/i.test(m))).toEqual([]);
    await h?.stop();
  }, 60_000);

  /**
   * Dead-letter `payloads` on `queue` the way production does: a handler throws PermanentJobError.
   * Resolves with the ids of the ORIGINAL jobs, in order.
   */
  async function deadLetter(
    queue: string,
    payloads: { key?: string; data: object }[],
    config: HandleOptions = {},
  ): Promise<string[]> {
    const worker = h.makeJobs({ worker: true });
    await worker.jobs.handle(
      queue,
      () => Promise.reject(new PermanentJobError('provider said no')),
      config,
    );
    await worker.jobs.start();
    try {
      const ids: string[] = [];
      for (const { key, data } of payloads) {
        const id = await worker.jobs.send(queue, data, key ? { idempotencyKey: key } : {});
        ids.push(id!);
        // One at a time, so the dead-letter copies are created in the order they were sent.
        await waitFor(
          async () => {
            const { rows } = await h.adminPool.query<{ n: string }>(
              'SELECT count(*) AS n FROM pgboss.job WHERE name = $1 AND source_name = $2',
              [config.deadLetter ?? `${queue}.dlq`, queue],
            );
            return Number(rows[0]!.n) === ids.length;
          },
          { message: `copy ${ids.length} in the dead-letter queue` },
        );
        await sleep(15);
      }
      return ids;
    } finally {
      await worker.close();
    }
  }

  /** A started API-role instance that knows the queue (so it can redrive and send). */
  async function operator(
    queue: string,
    config: HandleOptions = {},
  ): Promise<{ jobs: Jobs; close: () => Promise<void> }> {
    const made = h.makeJobs();
    await made.jobs.defineQueue(queue, config);
    await made.jobs.start();
    return { jobs: made.jobs, close: () => made.close() };
  }

  const dlqRows = (queue: string) => jobRows(h.adminPool, `${queue}.dlq`);

  describe('a redriven job runs again, under the same id', () => {
    it('moves the copy back with a fresh budget and the idempotency id, runs, and still deduplicates', async () => {
      const queue = uniqueQueue('redrive');
      const [originalId] = await deadLetter(queue, [
        { key: 'order:42', data: { order: 42, correlationId: 'req-1' } },
      ]);
      expect(originalId).toBe(idempotencyId(queue, 'order:42'));
      expect((await jobRows(h.adminPool, queue))[0]).toMatchObject({
        id: originalId,
        state: 'failed',
      });

      const op = await operator(queue);
      try {
        expect(await redriven(op.jobs, `${queue}.dlq`)).toBe(1);
      } finally {
        await op.close();
      }

      expect(await dlqRows(queue), 'the copy was left behind').toEqual([]);
      const rows = await jobRows(h.adminPool, queue);
      expect(rows, 'the dead original and the redriven job must not both exist').toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: originalId,
        state: 'created',
        retry_count: 0,
        data: { order: 42, correlationId: 'req-1' },
      });

      // Now the cause is fixed: a worker with a handler that succeeds runs it, as attempt 1.
      const worker = h.makeJobs({ worker: true });
      const attempts: { id: string; attempt: number }[] = [];
      await worker.jobs.handle(queue, (job) =>
        Promise.resolve(void attempts.push({ id: job.id, attempt: job.attempt })),
      );
      await worker.jobs.start();
      try {
        await waitFor(async () => (await jobRows(h.adminPool, queue))[0]?.state === 'completed', {
          message: 'the redriven job to complete',
        });
        expect(attempts).toEqual([{ id: originalId, attempt: 1 }]);
        // The idempotency id survived: the same key is still a duplicate.
        expect(
          await worker.jobs.send(queue, { order: 42 }, { idempotencyKey: 'order:42' }),
        ).toBeNull();
        expect(await jobRows(h.adminPool, queue)).toHaveLength(1);
      } finally {
        await worker.close();
      }
    }, 60_000);

    it('gives a job whose retries were exhausted a FULL budget again', async () => {
      const queue = uniqueQueue('redrive');
      const config = { retryLimit: 2, retryDelaySeconds: 1, retryDelayMaxSeconds: 1 };
      // An ordinary failing handler: it burns every retry before dead-lettering.
      const worker = h.makeJobs({ worker: true });
      await worker.jobs.handle(
        queue,
        () => Promise.reject(new Error('transient, forever')),
        config,
      );
      await worker.jobs.start();
      try {
        await worker.jobs.send(queue, { n: 1 });
        await waitFor(async () => (await dlqRows(queue)).length === 1, {
          timeoutMs: 30_000,
          message: 'dead letter',
        });
      } finally {
        await worker.close();
      }
      expect((await jobRows(h.adminPool, queue))[0]).toMatchObject({
        state: 'failed',
        retry_count: 2,
      });

      const op = await operator(queue, config);
      try {
        expect(await redriven(op.jobs, `${queue}.dlq`)).toBe(1);
      } finally {
        await op.close();
      }
      expect((await jobRows(h.adminPool, queue))[0]).toMatchObject({
        state: 'created',
        retry_count: 0,
        retry_limit: 2,
      });
    }, 60_000);

    it('keeps the payload and the priority', async () => {
      const queue = uniqueQueue('redrive');
      const worker = h.makeJobs({ worker: true });
      await worker.jobs.handle(queue, () => Promise.reject(new PermanentJobError('no')));
      await worker.jobs.start();
      try {
        await worker.jobs.send(queue, { nested: { a: [1, 2, 3] }, text: 'héllo' }, { priority: 7 });
        await waitFor(async () => (await dlqRows(queue)).length === 1, { message: 'dead letter' });
      } finally {
        await worker.close();
      }
      const op = await operator(queue);
      try {
        await redriven(op.jobs, `${queue}.dlq`);
      } finally {
        await op.close();
      }
      const { rows } = await h.adminPool.query<{ data: unknown; priority: number }>(
        "SELECT data, priority FROM pgboss.job WHERE name = $1 AND state = 'created'",
        [queue],
      );
      expect(rows).toEqual([{ data: { nested: { a: [1, 2, 3] }, text: 'héllo' }, priority: 7 }]);
    });
  });

  describe('a duplicate redrive moves nothing twice', () => {
    it('the second call moves 0', async () => {
      const queue = uniqueQueue('redrive');
      await deadLetter(queue, [{ data: { n: 1 } }, { data: { n: 2 } }]);
      const op = await operator(queue);
      try {
        expect(await redriven(op.jobs, `${queue}.dlq`)).toBe(2);
        expect(await redriven(op.jobs, `${queue}.dlq`)).toBe(0);
        expect(
          (await jobRows(h.adminPool, queue)).filter((r) => r.state === 'created'),
        ).toHaveLength(2);
      } finally {
        await op.close();
      }
    }, 60_000);

    it('three redrives at once move every copy exactly once', async () => {
      const queue = uniqueQueue('redrive');
      const payloads = Array.from({ length: 12 }, (_, n) => ({ key: `k:${n}`, data: { n } }));
      const originals = await deadLetter(queue, payloads);

      const ops = await Promise.all([operator(queue), operator(queue), operator(queue)]);
      try {
        const counts = await Promise.all(ops.map((op) => redriven(op.jobs, `${queue}.dlq`)));
        expect(
          counts.reduce((a, b) => a + b, 0),
          `the three redrives moved ${counts.join(' + ')}`,
        ).toBe(12);
      } finally {
        await Promise.all(ops.map((op) => op.close()));
      }

      expect(await dlqRows(queue)).toEqual([]);
      const rows = await jobRows(h.adminPool, queue);
      expect(rows).toHaveLength(12);
      expect(rows.map((r) => r.id).sort()).toEqual([...originals].sort());
      expect(rows.every((r) => r.state === 'created' && r.retry_count === 0)).toBe(true);
    }, 90_000);
  });

  describe('limit', () => {
    it('moves at most `limit`, oldest first', async () => {
      const queue = uniqueQueue('redrive');
      await deadLetter(
        queue,
        [0, 1, 2, 3, 4].map((n) => ({ data: { n } })),
      );
      const copies = await dlqRows(queue);
      const oldestTwo = copies.slice(0, 2).map((c) => (c.data as { n: number }).n);

      const op = await operator(queue);
      try {
        expect(await redriven(op.jobs, `${queue}.dlq`, { limit: 2 })).toBe(2);
        expect(await dlqRows(queue)).toHaveLength(3);
        const moved = (await jobRows(h.adminPool, queue)).filter((r) => r.state === 'created');
        expect(moved.map((r) => (r.data as { n: number }).n).sort()).toEqual([...oldestTwo].sort());

        // The next call continues where it left off.
        expect(await redriven(op.jobs, `${queue}.dlq`, { limit: 10 })).toBe(3);
        expect(await dlqRows(queue)).toEqual([]);
      } finally {
        await op.close();
      }
    }, 60_000);

    it('the default limit is 100', async () => {
      const queue = uniqueQueue('redrive');
      const op = await operator(queue);
      try {
        // 105 copies, made directly: dead-lettering 105 jobs one by one would take a minute.
        await h.adminPool.query(
          `INSERT INTO pgboss.job (name, data, state, source_name, source_id, retry_limit, expire_seconds, keep_until)
             SELECT $1, jsonb_build_object('n', g), 'created', $2, gen_random_uuid(), 0, 900, now() + interval '1 day'
               FROM generate_series(1, 105) g`,
          [`${queue}.dlq`, queue],
        );
        expect(await redriven(op.jobs, `${queue}.dlq`)).toBe(100);
        expect(await dlqRows(queue)).toHaveLength(5);
      } finally {
        await op.close();
      }
    });

    it.each([0, -1, 1.5, 10_001])('rejects limit %s', async (limit) => {
      const queue = uniqueQueue('redrive');
      const op = await operator(queue);
      try {
        await expect(op.jobs.redrive(`${queue}.dlq`, { limit })).rejects.toThrow(JobsConfigError);
      } finally {
        await op.close();
      }
    });
  });

  describe('retention and configuration follow the ORIGIN queue as it is now', () => {
    it("the redriven job takes the origin queue's current retention, retry limit and expiry", async () => {
      const queue = uniqueQueue('redrive');
      await deadLetter(queue, [{ data: { n: 1 } }], {
        retention: { completed: 100 },
        retryLimit: 1,
      });

      // The queue is reconfigured after the job died; the redriven job follows the NEW configuration.
      const op = await operator(queue, {
        retention: { completed: 3600 },
        retryLimit: 7,
        expireInSeconds: 120,
      });
      try {
        expect(await redriven(op.jobs, `${queue}.dlq`)).toBe(1);
      } finally {
        await op.close();
      }
      const { rows } = await h.adminPool.query(
        "SELECT deletion_seconds, retry_limit, expire_seconds, retry_count FROM pgboss.job WHERE name = $1 AND state = 'created'",
        [queue],
      );
      expect(rows).toEqual([
        { deletion_seconds: 3600, retry_limit: 7, expire_seconds: 120, retry_count: 0 },
      ]);
    }, 60_000);

    it("with completed 'immediate' (mail.send), a redriven job that succeeds leaves no row", async () => {
      const queue = uniqueQueue('redrive');
      const config = {
        retention: { completed: 'immediate' as const, failed: DAY, deadLetter: DAY },
      };
      await deadLetter(queue, [{ data: { secret: 'a-link' } }], config);

      const op = await operator(queue, config);
      try {
        await redriven(op.jobs, `${queue}.dlq`);
      } finally {
        await op.close();
      }
      const worker = h.makeJobs({ worker: true });
      let ran = 0;
      await worker.jobs.handle(queue, () => Promise.resolve(void ran++), config);
      await worker.jobs.start();
      try {
        await waitFor(() => ran === 1, { message: 'the redriven job' });
        await waitFor(async () => (await jobRows(h.adminPool, queue)).length === 0, {
          message: 'the completed row to be deleted',
        });
      } finally {
        await worker.close();
      }
    }, 60_000);

    it('a redriven job that fails again dead-letters again, and can be redriven again', async () => {
      const queue = uniqueQueue('redrive');
      const [id] = await deadLetter(queue, [{ key: 'again', data: { n: 1 } }]);
      const op = await operator(queue);
      try {
        expect(await redriven(op.jobs, `${queue}.dlq`)).toBe(1);
        const worker = h.makeJobs({ worker: true });
        await worker.jobs.handle(queue, () => Promise.reject(new PermanentJobError('still no')));
        await worker.jobs.start();
        try {
          await waitFor(async () => (await dlqRows(queue)).length === 1, {
            message: 'the second dead letter',
          });
        } finally {
          await worker.close();
        }
        expect((await dlqRows(queue))[0]).toMatchObject({ data: { n: 1 } });
        expect(await redriven(op.jobs, `${queue}.dlq`)).toBe(1);
        expect((await jobRows(h.adminPool, queue)).map((r) => r.id)).toEqual([id]);
      } finally {
        await op.close();
      }
    }, 60_000);
  });

  describe('canRedrive: the origin queue can forbid some payloads, and says how many it skipped', () => {
    const noAuth = (data: unknown) =>
      (data as { category?: string }).category?.startsWith('auth.') !== true;

    it('an unfiltered redrive moves the allowed copy and leaves the forbidden one, reporting both counts', async () => {
      const queue = uniqueQueue('redrive');
      await deadLetter(queue, [
        {
          key: 'reset',
          data: {
            category: 'auth.reset',
            to: 'a@example.test',
            link: 'https://x.test/reset?t=SECRET-TOKEN',
          },
        },
        { key: 'digest', data: { category: 'digest.daily', to: 'b@example.test' } },
      ]);
      const op = await operator(queue, { canRedrive: noAuth });
      try {
        const result = await op.jobs.redrive(`${queue}.dlq`);
        expect(result).toEqual({ moved: 1, skipped: 1 });
      } finally {
        await op.close();
      }
      const waiting = await jobRows(h.adminPool, queue);
      expect(
        waiting
          .filter((r) => r.state === 'created')
          .map((r) => (r.data as { category: string }).category),
      ).toEqual(['digest.daily']);
      expect((await dlqRows(queue)).map((r) => (r.data as { category: string }).category)).toEqual([
        'auth.reset',
      ]);

      // Only a COUNT is logged, never a payload.
      const lines = h.logs.warn.filter((m) => m.includes(queue));
      expect(lines.some((m) => /1 dead letter from/.test(m))).toBe(true);
      expect(lines.join('\n')).not.toMatch(/SECRET-TOKEN|auth\.reset|a@example\.test/);
    }, 60_000);

    it('skipped copies do not count against the limit', async () => {
      const queue = uniqueQueue('redrive');
      await deadLetter(queue, [
        { data: { category: 'auth.verify' } },
        { data: { category: 'digest.1' } },
        { data: { category: 'digest.2' } },
        { data: { category: 'digest.3' } },
      ]);
      const op = await operator(queue, { canRedrive: noAuth });
      try {
        expect(await op.jobs.redrive(`${queue}.dlq`, { limit: 2 })).toEqual({
          moved: 2,
          skipped: 1,
        });
        expect(await dlqRows(queue)).toHaveLength(2);
      } finally {
        await op.close();
      }
    }, 60_000);

    it('a queue defined WITHOUT a rule redrives everything, and reports skipped 0', async () => {
      const queue = uniqueQueue('redrive');
      await deadLetter(queue, [{ data: { category: 'auth.reset' } }]);
      const op = await operator(queue);
      try {
        expect(await op.jobs.redrive(`${queue}.dlq`)).toEqual({ moved: 1, skipped: 0 });
      } finally {
        await op.close();
      }
    }, 60_000);

    it('an origin queue NOT defined in the calling process cannot be checked, so its copies stay (skipped)', async () => {
      const queue = uniqueQueue('redrive');
      await deadLetter(queue, [{ data: { category: 'digest.daily' } }]);
      const stranger = uniqueQueue('redrive');
      const op = await operator(stranger); // knows another queue, not this one
      try {
        const result = await op.jobs.redrive(`${queue}.dlq`);
        expect(result).toEqual({ moved: 0, skipped: 1 });
      } finally {
        await op.close();
      }
      expect(await dlqRows(queue), 'the payload was lost').toHaveLength(1);
      expect(
        h.logs.warn.some((m) => m.includes(queue) && /not defined in this process/.test(m)),
      ).toBe(true);
    }, 60_000);

    it('a rule that throws forbids the copy, and the log carries the error message, not the payload', async () => {
      const queue = uniqueQueue('redrive');
      await deadLetter(queue, [{ data: { category: 'digest', secret: 'PAYLOAD-VALUE' } }]);
      const op = await operator(queue, {
        canRedrive: () => {
          throw new Error('rule bug');
        },
      });
      try {
        expect(await op.jobs.redrive(`${queue}.dlq`)).toEqual({ moved: 0, skipped: 1 });
      } finally {
        await op.close();
      }
      const lines = h.logs.warn.filter((m) => m.includes(queue)).join('\n');
      expect(lines).toMatch(/threw \(rule bug\)/);
      expect(lines).not.toContain('PAYLOAD-VALUE');
      expect(await dlqRows(queue)).toHaveLength(1);
    }, 60_000);

    it('a rule must return exactly true: a truthy value is not permission', async () => {
      const queue = uniqueQueue('redrive');
      await deadLetter(queue, [{ data: { n: 1 } }]);
      const op = await operator(queue, {
        canRedrive: (() => 'yes') as unknown as (d: unknown) => boolean,
      });
      try {
        expect(await op.jobs.redrive(`${queue}.dlq`)).toEqual({ moved: 0, skipped: 1 });
      } finally {
        await op.close();
      }
    }, 60_000);

    it('the rule is part of the queue definition: defining it with and without throws', async () => {
      const made = h.makeJobs();
      try {
        const queue = uniqueQueue('redrive');
        await made.jobs.defineQueue(queue, { canRedrive: noAuth });
        expect(() => made.jobs.defineQueue(queue)).toThrow(/defined twice/);
        expect(() => made.jobs.defineQueue(queue, { canRedrive: noAuth })).not.toThrow();
        expect(() =>
          made.jobs.defineQueue(uniqueQueue('redrive'), { canRedrive: 'no' as never }),
        ).toThrow(/canRedrive must be a function/);
      } finally {
        await made.close();
      }
    });

    it("a shared dead-letter queue applies EACH origin queue's own rule", async () => {
      const guarded = uniqueQueue('redrive');
      const open = uniqueQueue('redrive');
      const shared = `shared.${guarded}.dead`;
      await deadLetter(guarded, [{ data: { category: 'auth.reset' } }], { deadLetter: shared });
      await deadLetter(open, [{ data: { category: 'auth.reset' } }], { deadLetter: shared });
      const op = await operator(guarded, { deadLetter: shared, canRedrive: noAuth });
      await op.jobs.defineQueue(open, { deadLetter: shared });
      try {
        expect(await op.jobs.redrive(shared)).toEqual({ moved: 1, skipped: 1 });
        expect(
          (await jobRows(h.adminPool, open)).filter((r) => r.state === 'created'),
        ).toHaveLength(1);
        expect(
          (await jobRows(h.adminPool, guarded)).filter((r) => r.state === 'created'),
        ).toHaveLength(0);
      } finally {
        await op.close();
      }
    }, 60_000);
  });

  describe('it refuses what is not a dead-letter queue', () => {
    it('the origin queue itself, and a queue that does not exist', async () => {
      const queue = uniqueQueue('redrive');
      await deadLetter(queue, [{ data: {} }]);
      const op = await operator(queue);
      try {
        await expect(op.jobs.redrive(queue)).rejects.toThrow(/"[^"]+" is not a dead-letter queue/);
        await expect(op.jobs.redrive('no.such.queue')).rejects.toThrow(/not a dead-letter queue/);
        expect(await dlqRows(queue), 'a refused call touched the copies').toHaveLength(1);
        expect(await jobRows(h.adminPool, queue)).toHaveLength(1);
      } finally {
        await op.close();
      }
    }, 60_000);

    it('refuses before start(), and a malformed id in the filter', async () => {
      const made = h.makeJobs();
      try {
        await expect(made.jobs.redrive('x.dlq')).rejects.toThrow(/not started/);
        await made.jobs.start();
        await expect(made.jobs.redrive('x.dlq', { filter: { ids: ['nope'] } })).rejects.toThrow(
          /not a job id/,
        );
      } finally {
        await made.close();
      }
    });

    it('a custom dead-letter queue shared by two queues is a dead-letter queue', async () => {
      const a = uniqueQueue('redrive');
      const b = uniqueQueue('redrive');
      const shared = `shared.${a}.dead`;
      await deadLetter(a, [{ data: { from: 'a' } }], { deadLetter: shared });
      await deadLetter(b, [{ data: { from: 'b' } }], { deadLetter: shared });
      const op = await operator(a, { deadLetter: shared });
      await op.jobs.defineQueue(b, { deadLetter: shared });
      try {
        // Only `a`'s copy: the filter picks the origin.
        expect(await redriven(op.jobs, shared, { filter: { origin: a } })).toBe(1);
        expect((await jobRows(h.adminPool, a)).filter((r) => r.state === 'created')).toHaveLength(
          1,
        );
        expect((await jobRows(h.adminPool, b)).filter((r) => r.state === 'created')).toHaveLength(
          0,
        );
        expect(await jobRows(h.adminPool, shared)).toHaveLength(1);
      } finally {
        await op.close();
      }
    }, 60_000);
  });

  describe('filters', () => {
    it('ids, createdBefore and data each select exactly the intended copies, and combine', async () => {
      const queue = uniqueQueue('redrive');
      await deadLetter(queue, [
        { data: { n: 1, kind: 'digest' } },
        { data: { n: 2, kind: 'notice' } },
        { data: { n: 3, kind: 'digest' } },
        { data: { n: 4, kind: 'digest' } },
      ]);
      const copies = await dlqRows(queue);
      const byN = (n: number) => copies.find((c) => (c.data as { n: number }).n === n)!;
      const movedNs = async () =>
        (await jobRows(h.adminPool, queue))
          .filter((r) => r.state === 'created')
          .map((r) => (r.data as { n: number }).n)
          .sort();
      const op = await operator(queue);
      try {
        // by payload containment
        expect(
          await redriven(op.jobs, `${queue}.dlq`, { filter: { data: { kind: 'notice' } } }),
        ).toBe(1);
        expect(await movedNs()).toEqual([2]);
        // by id
        expect(await redriven(op.jobs, `${queue}.dlq`, { filter: { ids: [byN(4).id] } })).toBe(1);
        expect(await movedNs()).toEqual([2, 4]);
        // by time: nothing is older than the first copy
        expect(
          await redriven(op.jobs, `${queue}.dlq`, { filter: { createdBefore: byN(1).created_on } }),
        ).toBe(0);
        // combined: digests that arrived before the 4th copy... only n=1 and n=3 remain
        expect(
          await redriven(op.jobs, `${queue}.dlq`, {
            filter: { data: { kind: 'digest' }, createdBefore: byN(3).created_on },
          }),
        ).toBe(1);
        expect(await movedNs()).toEqual([1, 2, 4]);
        expect(await dlqRows(queue)).toHaveLength(1);
      } finally {
        await op.close();
      }
    }, 90_000);
  });

  describe('it never loses a payload', () => {
    it('a live job with the same id keeps the copy in place, untouched, and warns', async () => {
      const queue = uniqueQueue('redrive');
      const [id] = await deadLetter(queue, [{ key: 'live', data: { n: 1 } }]);
      // Somebody re-enqueued the id and it is live again.
      await h.adminPool.query(
        "UPDATE pgboss.job SET state = 'created', completed_on = NULL WHERE name = $1 AND id = $2",
        [queue, id],
      );
      const op = await operator(queue);
      try {
        expect(await redriven(op.jobs, `${queue}.dlq`)).toBe(0);
      } finally {
        await op.close();
      }
      expect(await dlqRows(queue), 'the payload was lost').toHaveLength(1);
      expect((await jobRows(h.adminPool, queue))[0], 'a live job was removed').toMatchObject({
        id,
        state: 'created',
      });
      expect(h.logs.warn.some((m) => m.includes(`a job with id ${id} already exists`))).toBe(true);
    }, 60_000);

    it('does NOT replace a LATER job that was sent with the same key: its completed row survives and the old work does not run again', async () => {
      // The reviewer's probe. K died ({ v: 'old' }); retention removed the failed row; K was sent
      // again and completed ({ v: 'new' }). The completed row is retained 7 days, the dead-letter
      // copy 30. Redriving the copy must not delete the completed row and run the old payload.
      const queue = uniqueQueue('redrive');
      const [id] = await deadLetter(queue, [{ key: 'K', data: { v: 'old' } }]);
      await h.adminPool.query(
        "DELETE FROM pgboss.job WHERE name = $1 AND id = $2 AND state = 'failed'",
        [queue, id],
      );

      const runs: string[] = [];
      const worker = h.makeJobs({ worker: true });
      await worker.jobs.handle<{ v: string }>(queue, (job) =>
        Promise.resolve(void runs.push(job.data.v)),
      );
      await worker.jobs.start();
      try {
        expect(await worker.jobs.send(queue, { v: 'new' }, { idempotencyKey: 'K' })).toBe(id);
        await waitFor(async () => (await jobRows(h.adminPool, queue))[0]?.state === 'completed', {
          message: 'the later job to complete',
        });

        expect(await worker.jobs.redrive(`${queue}.dlq`)).toEqual({ moved: 0, skipped: 0 });
        await sleep(2_500); // time enough for a wrongly redriven job to be fetched and run

        const rows = await jobRows(h.adminPool, queue);
        expect(rows, 'the completed row was replaced').toEqual([
          expect.objectContaining({ id, state: 'completed', data: { v: 'new' } }),
        ]);
        expect(runs, 'the old payload ran again').toEqual(['new']);
        expect(await dlqRows(queue), 'the copy was lost').toHaveLength(1);
        expect(
          h.logs.warn.some(
            (m) => m.includes(`a job with id ${id} already exists`) && /live, or retained/.test(m),
          ),
        ).toBe(true);
      } finally {
        await worker.close();
      }
    }, 60_000);

    it.each(['cancelled', 'completed', 'created', 'retry', 'active'])(
      'only the dead original (state failed) is ever replaced; a row in state %s with the id is left alone',
      async (state) => {
        const queue = uniqueQueue('redrive');
        const [id] = await deadLetter(queue, [{ key: 'S', data: { n: 1 } }]);
        await h.adminPool.query('UPDATE pgboss.job SET state = $3 WHERE name = $1 AND id = $2', [
          queue,
          id,
          state,
        ]);
        const op = await operator(queue);
        try {
          expect((await op.jobs.redrive(`${queue}.dlq`)).moved).toBe(0);
        } finally {
          await op.close();
        }
        expect((await jobRows(h.adminPool, queue))[0]).toMatchObject({ id, state });
        expect(await dlqRows(queue)).toHaveLength(1);
      },
      30_000,
    );

    it('an EXPIRED dead-letter copy is not revived: it is as good as deleted, and redrive must not give it a new window', async () => {
      // Dead-letter queues are not swept, and pg-boss deletes an expired copy only on its next pass
      // (every 15 minutes). In that gap a redrive would have brought a payload that was meant to be
      // gone back to life with a fresh window.
      const queue = uniqueQueue('redrive');
      const [expiredId, liveId] = await deadLetter(queue, [
        { key: 'old', data: { n: 1 } },
        { key: 'new', data: { n: 2 } },
      ]);
      await h.adminPool.query(
        "UPDATE pgboss.job SET keep_until = now() - interval '1 second' WHERE name = $1 AND source_id = $2",
        [`${queue}.dlq`, expiredId],
      );

      const op = await operator(queue);
      try {
        expect(await op.jobs.redrive(`${queue}.dlq`)).toEqual({ moved: 1, skipped: 0 });
        // Not by id either.
        const expired = (
          await h.adminPool.query<{ id: string }>(
            'SELECT id FROM pgboss.job WHERE name = $1 AND source_id = $2',
            [`${queue}.dlq`, expiredId],
          )
        ).rows[0]!;
        expect(await op.jobs.redrive(`${queue}.dlq`, { filter: { ids: [expired.id] } })).toEqual({
          moved: 0,
          skipped: 0,
        });
      } finally {
        await op.close();
      }
      expect(
        (await jobRows(h.adminPool, queue)).filter((r) => r.state === 'created').map((r) => r.id),
      ).toEqual([liveId]);
      const left = await dlqRows(queue);
      expect(left, 'the expired copy must be left for pg-boss to delete').toHaveLength(1);
      expect((left[0]!.data as { n: number }).n).toBe(1);
    }, 60_000);

    it("redriving STARTS THE ORIGIN QUEUE'S WAITING WINDOW AGAIN: the job gets a fresh deadline, not the copy's remaining time", async () => {
      const queue = uniqueQueue('redrive');
      await deadLetter(queue, [{ data: { n: 1 } }]);
      // The copy has almost run out of time.
      await h.adminPool.query(
        "UPDATE pgboss.job SET keep_until = now() + interval '1 minute' WHERE name = $1",
        [`${queue}.dlq`],
      );
      const op = await operator(queue);
      try {
        expect(await op.jobs.redrive(`${queue}.dlq`)).toEqual({ moved: 1, skipped: 0 });
      } finally {
        await op.close();
      }
      const { rows } = await h.adminPool.query<{ window: number; queue_window: number }>(
        `SELECT extract(epoch FROM j.keep_until - j.start_after)::int AS window, q.retention_seconds AS queue_window
           FROM pgboss.job j JOIN pgboss.queue q ON q.name = j.name
          WHERE j.name = $1 AND j.state = 'created'`,
        [queue],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.window, 'the redriven job did not get the origin queue window').toBe(
        rows[0]!.queue_window,
      );
      expect(rows[0]!.window).toBeGreaterThan(60);
    }, 60_000);

    it('a copy whose origin queue is gone stays, and warns', async () => {
      const queue = uniqueQueue('redrive');
      await deadLetter(queue, [{ data: { n: 1 } }]);
      await h.adminPool.query("UPDATE pgboss.job SET source_name = 'ghost.queue' WHERE name = $1", [
        `${queue}.dlq`,
      ]);
      const op = await operator(queue);
      try {
        expect(await redriven(op.jobs, `${queue}.dlq`)).toBe(0);
      } finally {
        await op.close();
      }
      expect(await dlqRows(queue)).toHaveLength(1);
      expect(h.logs.warn.some((m) => m.includes('"ghost.queue" no longer exists'))).toBe(true);
    }, 60_000);

    it('a copy a worker is handling is not touched', async () => {
      const queue = uniqueQueue('redrive');
      await deadLetter(queue, [{ data: { n: 1 } }, { data: { n: 2 } }]);
      const [first] = await dlqRows(queue);
      await h.adminPool.query("UPDATE pgboss.job SET state = 'active' WHERE id = $1", [first!.id]);
      const op = await operator(queue);
      try {
        expect(await redriven(op.jobs, `${queue}.dlq`)).toBe(1);
      } finally {
        await op.close();
      }
      expect((await dlqRows(queue)).map((r) => r.id)).toEqual([first!.id]);
    }, 60_000);

    it('is ATOMIC per job: if the insert fails, the dead original and the copy are both still there', async () => {
      const queue = uniqueQueue('redrive');
      const [id] = await deadLetter(queue, [{ key: 'atomic', data: { n: 1 } }]);
      const made = h.makeJobs();
      await made.jobs.defineQueue(queue);
      await made.jobs.start();
      try {
        // Break only the insert, after the original has been removed inside the transaction.
        const boss = (made.jobs as unknown as { boss: { send: () => Promise<never> } }).boss;
        boss.send = () => Promise.reject(new Error('database went away'));
        await expect(made.jobs.redrive(`${queue}.dlq`)).rejects.toThrow('database went away');
      } finally {
        await made.close();
      }
      expect(
        await dlqRows(queue),
        'the copy was deleted though the job was never inserted',
      ).toHaveLength(1);
      expect(
        await jobRows(h.adminPool, queue),
        'the dead original was removed by a rolled-back move',
      ).toEqual([expect.objectContaining({ id, state: 'failed' })]);
    }, 60_000);
  });
});
