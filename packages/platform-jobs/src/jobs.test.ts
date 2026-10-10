import { randomUUID } from 'node:crypto';
import { QueueMetrics, requestContextStorage } from '@quynhonsemiconductor/observability';
import { currentCorrelationId } from './correlation';
import { withTransaction } from '@quynhonsemiconductor/platform-db/drizzle';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { JobsConfigError } from './config';
import { PermanentJobError } from './errors';
import { idempotencyId } from './idempotency';
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

describe.skipIf(!dockerOn)(
  'platform-jobs against PostgreSQL 18 as a non-owner application role',
  () => {
    let h: JobsDb;
    beforeAll(async () => {
      h = await startJobsDb();
    }, 180_000);
    afterAll(async () => {
      // The whole suite ran with only the grants of installJobsSchema: nothing may have been denied.
      expect(h.logs.error.filter((m) => /permission denied/i.test(m))).toEqual([]);
      expect(h.logs.warn.filter((m) => /permission denied/i.test(m))).toEqual([]);
      await h?.stop();
    }, 60_000);

    const ordersCount = async () =>
      Number((await h.appPool.query<{ n: string }>('SELECT count(*) AS n FROM orders')).rows[0]!.n);

    describe('transactional enqueue through the platform-db DbExecutor', () => {
      it('rolls back with the transaction: no business row, and NO job', async () => {
        const { jobs, close } = h.makeJobs();
        const queue = uniqueQueue('tx');
        jobs.defineQueue(queue);
        await jobs.start();
        const boom = new Error('business rule failed');
        try {
          await expect(
            withTransaction(h.db, async (tx) => {
              await tx.execute(sql`INSERT INTO orders (id, customer) VALUES (1, 'ada')`);
              await jobs.send(queue, { order: 1 }, { tx });
              throw boom;
            }),
          ).rejects.toBe(boom);

          expect(
            await jobRows(h.appPool, queue),
            'a rolled-back transaction left a job behind',
          ).toEqual([]);
          expect(await ordersCount()).toBe(0);
        } finally {
          await close();
        }
      });

      it('commits with the transaction: the order AND the job', async () => {
        const { jobs, close } = h.makeJobs();
        const queue = uniqueQueue('tx');
        jobs.defineQueue(queue);
        await jobs.start();
        try {
          const id = await withTransaction(h.db, async (tx) => {
            await tx.execute(sql`INSERT INTO orders (id, customer) VALUES (2, 'grace')`);
            return jobs.send(queue, { order: 2 }, { tx });
          });
          expect(id).toMatch(/^[0-9a-f-]{36}$/);
          const rows = await jobRows(h.appPool, queue);
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatchObject({ id, state: 'created', data: { order: 2 } });
          expect(await ordersCount()).toBeGreaterThanOrEqual(1);
        } finally {
          await close();
        }
      });

      it('is invisible to others before the commit', async () => {
        const { jobs, close } = h.makeJobs();
        const queue = uniqueQueue('tx');
        jobs.defineQueue(queue);
        await jobs.start();
        try {
          await withTransaction(h.db, async (tx) => {
            await jobs.send(queue, { n: 1 }, { tx });
            expect(await jobRows(h.adminPool, queue), 'the job was visible before commit').toEqual(
              [],
            );
          });
          expect(await jobRows(h.adminPool, queue)).toHaveLength(1);
        } finally {
          await close();
        }
      });

      it('joins an outer transaction through withTransaction: inner send dies with the outer rollback', async () => {
        const { jobs, close } = h.makeJobs();
        const queue = uniqueQueue('tx');
        jobs.defineQueue(queue);
        await jobs.start();
        try {
          await expect(
            withTransaction(h.db, async (outer) => {
              await withTransaction(outer, (inner) => jobs.send(queue, { n: 1 }, { tx: inner }));
              throw new Error('outer failed');
            }),
          ).rejects.toThrow('outer failed');
          expect(await jobRows(h.appPool, queue)).toEqual([]);
        } finally {
          await close();
        }
      });

      it('accepts the root database as the executor too (a one-statement enqueue)', async () => {
        const { jobs, close } = h.makeJobs();
        const queue = uniqueQueue('tx');
        jobs.defineQueue(queue);
        await jobs.start();
        try {
          expect(await jobs.send(queue, { n: 1 }, { tx: h.db })).not.toBeNull();
          expect(await jobRows(h.appPool, queue)).toHaveLength(1);
        } finally {
          await close();
        }
      });
    });

    describe('idempotency key = job id', () => {
      it('a duplicate key inserts nothing and returns null', async () => {
        const { jobs, close } = h.makeJobs();
        const queue = uniqueQueue('idem');
        jobs.defineQueue(queue);
        await jobs.start();
        try {
          const first = await jobs.send(queue, { to: 'a' }, { idempotencyKey: 'welcome:u1' });
          const second = await jobs.send(queue, { to: 'a' }, { idempotencyKey: 'welcome:u1' });
          expect(first).toBe(idempotencyId(queue, 'welcome:u1'));
          expect(second).toBeNull();
          expect(await jobRows(h.appPool, queue)).toHaveLength(1);
        } finally {
          await close();
        }
      });

      it('different keys make different jobs; no key makes a job every time', async () => {
        const { jobs, close } = h.makeJobs();
        const queue = uniqueQueue('idem');
        jobs.defineQueue(queue);
        await jobs.start();
        try {
          await jobs.send(queue, {}, { idempotencyKey: 'a' });
          await jobs.send(queue, {}, { idempotencyKey: 'b' });
          await jobs.send(queue, {});
          await jobs.send(queue, {});
          expect(await jobRows(h.appPool, queue)).toHaveLength(4);
        } finally {
          await close();
        }
      });

      it('holds inside a transaction, and a rolled-back first send does not reserve the key', async () => {
        const { jobs, close } = h.makeJobs();
        const queue = uniqueQueue('idem');
        jobs.defineQueue(queue);
        await jobs.start();
        try {
          await withTransaction(h.db, async (tx) => {
            expect(await jobs.send(queue, {}, { tx, idempotencyKey: 'k' })).not.toBeNull();
            expect(await jobs.send(queue, {}, { tx, idempotencyKey: 'k' })).toBeNull();
          });
          expect(await jobRows(h.appPool, queue)).toHaveLength(1);
        } finally {
          await close();
        }
      });

      it('a rolled-back send does not reserve the key', async () => {
        const { jobs, close } = h.makeJobs();
        const queue = uniqueQueue('idem');
        jobs.defineQueue(queue);
        await jobs.start();
        try {
          await withTransaction(h.db, async (tx) => {
            await jobs.send(queue, {}, { tx, idempotencyKey: 'k' });
            throw new Error('rollback');
          }).catch(() => undefined);
          expect(await jobs.send(queue, {}, { idempotencyKey: 'k' })).not.toBeNull();
        } finally {
          await close();
        }
      });

      it('two concurrent duplicates in transactions: exactly one job; the second waits for the first to commit', async () => {
        const { jobs, close } = h.makeJobs();
        const queue = uniqueQueue('idem');
        jobs.defineQueue(queue);
        await jobs.start();
        try {
          let secondDone = false;
          let release!: () => void;
          const gate = new Promise<void>((resolve) => (release = resolve));
          const first = withTransaction(h.db, async (tx) => {
            await jobs.send(queue, {}, { tx, idempotencyKey: 'race' });
            await gate;
          });
          await sleep(200);
          const second = withTransaction(h.db, (tx) =>
            jobs.send(queue, {}, { tx, idempotencyKey: 'race' }),
          ).then((id) => {
            secondDone = true;
            return id;
          });
          await sleep(400);
          expect(secondDone, 'the duplicate did not wait for the first transaction').toBe(false);
          release();
          await first;
          expect(await second).toBeNull();
          expect(await jobRows(h.appPool, queue)).toHaveLength(1);
        } finally {
          await close();
        }
      });

      it('keeps deduplicating after the job completed, while the row is retained', async () => {
        const worker = h.makeJobs({ worker: true });
        const queue = uniqueQueue('idem');
        let ran = 0;
        await worker.jobs.handle(queue, () => Promise.resolve(void ran++));
        await worker.jobs.start();
        try {
          await worker.jobs.send(queue, {}, { idempotencyKey: 'once' });
          await waitFor(async () => (await jobRows(h.appPool, queue))[0]?.state === 'completed', {
            message: 'completion',
          });
          expect(await worker.jobs.send(queue, {}, { idempotencyKey: 'once' })).toBeNull();
          expect(ran).toBe(1);
        } finally {
          await worker.close();
        }
      });
    });

    describe('ROLE=worker: only a worker runs handlers', () => {
      it('an API process records the queue and enqueues, but never runs the handler; a worker does', async () => {
        const queue = uniqueQueue('role');
        const ran: string[] = [];

        const api = h.makeJobs();
        await api.jobs.handle(queue, () => Promise.resolve(void ran.push('api')));
        await api.jobs.start();
        try {
          await api.jobs.send(queue, { n: 1 });
          await sleep(2_500);
          expect(ran, 'an API process ran a handler').toEqual([]);
          expect((await jobRows(h.appPool, queue))[0]!.state).toBe('created');

          const worker = h.makeJobs({ worker: true });
          await worker.jobs.handle(queue, () => Promise.resolve(void ran.push('worker')));
          await worker.jobs.start();
          try {
            await waitFor(() => ran.length > 0, { message: 'the worker to run the job' });
            expect(ran).toEqual(['worker']);
          } finally {
            await worker.close();
          }
        } finally {
          await api.close();
        }
      });

      it('anything but ROLE=worker is an API process (a typo fails safe)', async () => {
        const queue = uniqueQueue('role');
        let ran = 0;
        const typo = h.makeJobs({ env: { ROLE: 'wroker' } });
        await typo.jobs.handle(queue, () => Promise.resolve(void ran++));
        await typo.jobs.start();
        try {
          await typo.jobs.send(queue, {});
          await sleep(2_000);
          expect(ran).toBe(0);
        } finally {
          await typo.close();
        }
      });

      it('a worker passes the job data and a 1-based attempt number to the handler', async () => {
        const worker = h.makeJobs({ worker: true });
        const queue = uniqueQueue('ctx');
        const seen: { id: string; data: unknown; attempt: number; aborted: boolean }[] = [];
        await worker.jobs.handle<{ to: string }>(queue, (job) => {
          seen.push({
            id: job.id,
            data: job.data,
            attempt: job.attempt,
            aborted: job.signal.aborted,
          });
          return Promise.resolve();
        });
        await worker.jobs.start();
        try {
          const id = await worker.jobs.send(queue, { to: 'ada@example.test' });
          await waitFor(() => seen.length > 0, { message: 'the handler' });
          expect(seen[0]).toEqual({
            id,
            data: { to: 'ada@example.test' },
            attempt: 1,
            aborted: false,
          });
        } finally {
          await worker.close();
        }
      });
    });

    describe('retries, backoff and dead letters', () => {
      it('retries a failing job, then dead-letters it with its payload and the error', async () => {
        const worker = h.makeJobs({ worker: true });
        const queue = uniqueQueue('dlq');
        const attempts: number[] = [];
        await worker.jobs.handle(
          queue,
          (job) => {
            attempts.push(job.attempt);
            return Promise.reject(new Error(`boom ${job.attempt}`));
          },
          { retryLimit: 2, retryDelaySeconds: 1, retryDelayMaxSeconds: 1 },
        );
        await worker.jobs.start();
        try {
          await worker.jobs.send(queue, { invoice: 42 });
          const dead = await waitFor(
            async () => {
              const rows = await jobRows(h.adminPool, `${queue}.dlq`);
              return rows.length > 0 ? rows : false;
            },
            { timeoutMs: 40_000, message: 'the dead-letter copy' },
          );
          expect(attempts).toEqual([1, 2, 3]);
          expect(dead).toHaveLength(1);
          expect(dead[0]!.data).toEqual({ invoice: 42 });

          const [source] = await jobRows(h.adminPool, queue);
          expect(source).toMatchObject({ state: 'failed', retry_count: 2 });
          expect(source!.output).toMatchObject({ name: 'Error', message: 'boom 3' });
        } finally {
          await worker.close();
        }
      }, 60_000);

      it('one failing job in a batch does not fail the others', async () => {
        const worker = h.makeJobs({ worker: true });
        const queue = uniqueQueue('batch');
        const ok: string[] = [];
        await worker.jobs.handle<{ n: number }>(
          queue,
          (job) => {
            if (job.data.n === 2) return Promise.reject(new Error('only this one'));
            ok.push(`${job.data.n}`);
            return Promise.resolve();
          },
          { concurrency: 5, retryLimit: 1, retryDelaySeconds: 30, retryDelayMaxSeconds: 30 },
        );
        // Enqueue before the worker starts, so all five land in ONE batch.
        const api = h.makeJobs();
        api.jobs.defineQueue(queue, {
          retryLimit: 1,
          retryDelaySeconds: 30,
          retryDelayMaxSeconds: 30,
        });
        await api.jobs.start();
        for (const n of [1, 2, 3, 4, 5]) await api.jobs.send(queue, { n });
        await worker.jobs.start();
        try {
          await waitFor(() => ok.length === 4, { message: 'the four good jobs' });
          // pg-boss settles the batch after the handlers return: wait for the states, not the handlers.
          const rows = await waitFor(
            async () => {
              const all = await jobRows(h.appPool, queue);
              return all.filter((r) => r.state === 'completed').length === 4 &&
                all.filter((r) => r.state === 'retry').length === 1
                ? all
                : false;
            },
            { message: 'four completed and one waiting to retry' },
          );
          expect(rows).toHaveLength(5);
        } finally {
          await worker.close();
          await api.close();
        }
      });

      it('an error message that is huge is stored truncated', async () => {
        const worker = h.makeJobs({ worker: true });
        const queue = uniqueQueue('trunc');
        await worker.jobs.handle(queue, () => Promise.reject(new Error('x'.repeat(10_000))), {
          retryLimit: 1,
          retryDelaySeconds: 1,
          retryDelayMaxSeconds: 1,
        });
        await worker.jobs.start();
        try {
          await worker.jobs.send(queue, {});
          const row = await waitFor(
            async () => (await jobRows(h.adminPool, queue)).find((r) => r.output !== null),
            { message: 'a stored failure' },
          );
          expect(String((row.output as { message: string }).message).length).toBeLessThanOrEqual(
            500,
          );
        } finally {
          await worker.close();
        }
      });
    });

    describe('PermanentJobError', () => {
      it('goes straight to the dead-letter queue: one attempt, no retries, no backoff', async () => {
        const worker = h.makeJobs({ worker: true });
        const queue = uniqueQueue('perm');
        const attempts: number[] = [];
        await worker.jobs.handle(
          queue,
          (job) => {
            attempts.push(job.attempt);
            return Promise.reject(new PermanentJobError('the recipient does not exist'));
          },
          { retryLimit: 5 },
        );
        await worker.jobs.start();
        try {
          await worker.jobs.send(queue, { to: 'nobody' });
          const dead = await waitFor(
            async () => {
              const rows = await jobRows(h.adminPool, `${queue}.dlq`);
              return rows.length > 0 ? rows : false;
            },
            { message: 'the dead-letter copy' },
          );
          expect(attempts, 'a permanent failure was retried').toEqual([1]);
          expect(dead[0]!.data).toEqual({ to: 'nobody' });
          const [source] = await jobRows(h.adminPool, queue);
          expect(source).toMatchObject({ state: 'failed', retry_count: 0 });
          expect(source!.output).toMatchObject({
            name: 'PermanentJobError',
            message: 'the recipient does not exist',
          });
        } finally {
          await worker.close();
        }
      });

      it('an ordinary error from the same handler IS retried (the contrast)', async () => {
        const worker = h.makeJobs({ worker: true });
        const queue = uniqueQueue('perm');
        const attempts: number[] = [];
        await worker.jobs.handle(
          queue,
          (job) => {
            attempts.push(job.attempt);
            return job.attempt === 1 ? Promise.reject(new Error('transient')) : Promise.resolve();
          },
          { retryDelaySeconds: 1, retryDelayMaxSeconds: 1 },
        );
        await worker.jobs.start();
        try {
          await worker.jobs.send(queue, {});
          await waitFor(async () => (await jobRows(h.adminPool, queue))[0]?.state === 'completed', {
            timeoutMs: 20_000,
            message: 'the retry to succeed',
          });
          expect(attempts).toEqual([1, 2]);
        } finally {
          await worker.close();
        }
      }, 30_000);
    });

    describe('observability: contract metrics and job context', () => {
      it('counts processed and failed jobs on the platform contract names (queue.processed / queue.failures)', async () => {
        const processed = vi.spyOn(QueueMetrics.prototype, 'recordProcessed');
        const failures = vi.spyOn(QueueMetrics.prototype, 'recordFailure');
        const worker = h.makeJobs({ worker: true });
        const queue = uniqueQueue('metrics');
        await worker.jobs.handle<{ ok: boolean }>(queue, (job) =>
          job.data.ok ? Promise.resolve() : Promise.reject(new PermanentJobError('bad')),
        );
        await worker.jobs.start();
        try {
          await worker.jobs.send(queue, { ok: true });
          await worker.jobs.send(queue, { ok: false });
          await waitFor(
            () =>
              processed.mock.calls.some(([q]) => q === queue) &&
              failures.mock.calls.some(([q]) => q === queue),
            { message: 'both outcomes recorded' },
          );
          expect(processed.mock.calls.filter(([q]) => q === queue)).toHaveLength(1);
          expect(failures.mock.calls.filter(([q]) => q === queue)).toHaveLength(1);
        } finally {
          processed.mockRestore();
          failures.mockRestore();
          await worker.close();
        }
      });

      it('runs every handler inside a job context, so its logs carry `queue:jobId`', async () => {
        const worker = h.makeJobs({ worker: true });
        const queue = uniqueQueue('ctx');
        const seen: (string | undefined)[] = [];
        await worker.jobs.handle(queue, (job) => {
          seen.push(requestContextStorage.getStore()?.correlationId);
          expect(job.id).toBeTruthy();
          return Promise.resolve();
        });
        await worker.jobs.start();
        try {
          const id = await worker.jobs.send(queue, {});
          await waitFor(() => seen.length === 1, { message: 'the handler' });
          expect(seen).toEqual([`${queue}:${id}`]);
        } finally {
          await worker.close();
        }
      });
    });

    describe('correlation: a job continues the request that caused it', () => {
      /** Send a job from inside a request context, the way a controller does, and report what the handler saw. */
      async function run(payloadId: unknown, requestId = 'req-from-the-browser') {
        const worker = h.makeJobs({ worker: true });
        const queue = uniqueQueue('corr');
        const seen: { correlationId: string | undefined; data: unknown }[] = [];
        await worker.jobs.handle(queue, (job) => {
          seen.push({
            correlationId: requestContextStorage.getStore()?.correlationId,
            data: job.data,
          });
          return Promise.resolve();
        });
        await worker.jobs.start();
        try {
          const id = await requestContextStorage.run({ correlationId: requestId } as never, () =>
            worker.jobs.send(
              queue,
              payloadId === 'FROM_CONTEXT'
                ? { correlationId: currentCorrelationId(), n: 1 }
                : { correlationId: payloadId, n: 1 },
            ),
          );
          await waitFor(() => seen.length === 1, { message: 'the handler' });
          return { seen: seen[0]!, queue, jobId: id! };
        } finally {
          await worker.close();
        }
      }

      it("the sender puts the request's id in the payload with currentCorrelationId(), and the handler's logs carry it", async () => {
        const { seen } = await run('FROM_CONTEXT');
        expect(seen.correlationId).toBe('req-from-the-browser');
        // The payload is exactly what was sent: nothing was injected, nothing removed.
        expect(seen.data).toEqual({ correlationId: 'req-from-the-browser', n: 1 });
      });

      it.each([
        ['has a space', 'two words'],
        ['forges a log line', 'abc\r\nfake: line'],
        ['is too long', 'a'.repeat(129)],
        ['is not a string', 42],
        ['is empty', ''],
      ])('an id in the payload that %s is replaced by queue:jobId', async (_why, bad) => {
        const { seen, queue, jobId } = await run(bad);
        expect(seen.correlationId).toBe(`${queue}:${jobId}`);
      });

      it('a payload with no id gets queue:jobId, and the platform never adds a key to the data', async () => {
        const worker = h.makeJobs({ worker: true });
        const queue = uniqueQueue('corr');
        const seen: { correlationId: string | undefined; data: unknown }[] = [];
        await worker.jobs.handle(queue, (job) => {
          seen.push({
            correlationId: requestContextStorage.getStore()?.correlationId,
            data: job.data,
          });
          return Promise.resolve();
        });
        await worker.jobs.start();
        try {
          const id = await requestContextStorage.run(
            { correlationId: 'req-ignored' } as never,
            () => worker.jobs.send(queue, { strict: true }),
          );
          await waitFor(() => seen.length === 1, { message: 'the handler' });
          expect(seen[0]).toEqual({ correlationId: `${queue}:${id}`, data: { strict: true } });
        } finally {
          await worker.close();
        }
      });

      it('a job that sends a follow-up job continues the same id down the chain', async () => {
        const worker = h.makeJobs({ worker: true });
        const first = uniqueQueue('corr');
        const second = uniqueQueue('corr');
        const seen: string[] = [];
        await worker.jobs.handle(first, async () => {
          await worker.jobs.send(second, { correlationId: currentCorrelationId() });
        });
        await worker.jobs.handle(second, () => {
          seen.push(requestContextStorage.getStore()!.correlationId!);
          return Promise.resolve();
        });
        await worker.jobs.start();
        try {
          await requestContextStorage.run({ correlationId: 'req-chain' } as never, () =>
            worker.jobs.send(first, { correlationId: currentCorrelationId() }),
          );
          await waitFor(() => seen.length === 1, { message: 'the second job' });
          expect(seen).toEqual(['req-chain']);
        } finally {
          await worker.close();
        }
      });
    });

    describe('a long queue name cannot break the correlation chain', () => {
      it('a 96-character queue name with a slash: the handler and its follow-up job carry the same VALID id', async () => {
        const worker = h.makeJobs({ worker: true });
        // Near the longest a queue name can be (96, so that `<name>.dlq` still fits in 100), with a slash:
        // the plain `queue:jobId` would be 133 characters.
        const first = `lms/${randomUUID().slice(0, 8)}${'a'.repeat(84)}`;
        const second = `lms/${randomUUID().slice(0, 8)}${'b'.repeat(84)}`;
        expect(first).toHaveLength(96);
        const seen: { first?: string; second?: string; sent?: string | undefined } = {};
        await worker.jobs.handle(first, async () => {
          seen.first = requestContextStorage.getStore()!.correlationId;
          seen.sent = currentCorrelationId();
          await worker.jobs.send(second, { correlationId: currentCorrelationId() });
        });
        await worker.jobs.handle(second, () => {
          seen.second = requestContextStorage.getStore()!.correlationId;
          return Promise.resolve();
        });
        await worker.jobs.start();
        try {
          await worker.jobs.send(first, {});
          await waitFor(() => seen.second !== undefined, { message: 'the follow-up job' });
          expect(seen.first).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
          expect(seen.sent, 'currentCorrelationId() refused the job id: the chain broke').toBe(
            seen.first,
          );
          expect(seen.second, 'the follow-up job started a new id').toBe(seen.first);
        } finally {
          await worker.close();
        }
      });
    });

    describe('a succeeded job is counted even when its early settle throws', () => {
      it('the batch-level settle still completes it, so it is a processed job', async () => {
        const processed = vi.spyOn(QueueMetrics.prototype, 'recordProcessed');
        const worker = h.makeJobs({ worker: true });
        const queue = uniqueQueue('early');
        // Break ONLY our early, fenced settle (a database hiccup); pg-boss's own batch settle is a
        // different code path and still works.
        const boss = (worker.jobs as unknown as { boss: { complete: () => Promise<never> } }).boss;
        boss.complete = () => Promise.reject(new Error('connection reset'));
        let ran = 0;
        await worker.jobs.handle(queue, () => Promise.resolve(void ran++));
        await worker.jobs.start();
        try {
          await worker.jobs.send(queue, {});
          await waitFor(async () => (await jobRows(h.adminPool, queue))[0]?.state === 'completed', {
            message: 'the batch settle to complete the job',
          });
          expect(ran).toBe(1);
          expect(
            h.logs.warn.some((m) => /Could not settle job .* early: connection reset/.test(m)),
          ).toBe(true);
          expect(
            processed.mock.calls.filter(([q]) => q === queue),
            'a job that succeeded and was completed was not counted',
          ).toHaveLength(1);
        } finally {
          processed.mockRestore();
          await worker.close();
        }
      });
    });

    describe('queue.processed / queue.failures count only what the fenced settle landed on', () => {
      const lostClaim = async (outcome: 'succeed' | 'throw') => {
        const processed = vi.spyOn(QueueMetrics.prototype, 'recordProcessed');
        const failures = vi.spyOn(QueueMetrics.prototype, 'recordFailure');
        const worker = h.makeJobs({ worker: true });
        const queue = uniqueQueue('lost');
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        let started = false;
        await worker.jobs.handle(queue, async () => {
          started = true;
          await gate;
          if (outcome === 'throw') throw new Error('late failure');
        });
        await worker.jobs.start();
        try {
          const id = (await worker.jobs.send(queue, {}))!;
          await waitFor(() => started, { message: 'the handler to start' });
          await h.adminPool.query(
            "UPDATE pgboss.job SET state = 'cancelled', completed_on = now() WHERE id = $1",
            [id],
          );
          release();
          await waitFor(() => h.logs.warn.some((m) => m.includes(id) && /claim was lost/.test(m)), {
            message: 'the lost-claim warning',
          });
          await sleep(300);
          return {
            processed: processed.mock.calls.filter(([q]) => q === queue).length,
            failures: failures.mock.calls.filter(([q]) => q === queue).length,
          };
        } finally {
          processed.mockRestore();
          failures.mockRestore();
          await worker.close();
        }
      };

      it('a handler that SUCCEEDS after its claim was lost is not a processed job', async () => {
        expect(await lostClaim('succeed')).toEqual({ processed: 0, failures: 0 });
      });

      it('a handler that THROWS after its claim was lost is not a failure of the queue', async () => {
        expect(await lostClaim('throw')).toEqual({ processed: 0, failures: 0 });
      });
    });

    describe('immediate deletion is fenced to the attempt that ran', () => {
      it('a handler that finishes AFTER its claim was lost neither completes nor deletes the row', async () => {
        const worker = h.makeJobs({ worker: true });
        const queue = uniqueQueue('fence');
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        let started = false;
        await worker.jobs.handle(
          queue,
          async () => {
            started = true;
            await gate;
          },
          { retention: { completed: 'immediate', failed: DAY } },
        );
        await worker.jobs.start();
        try {
          const id = (await worker.jobs.send(queue, { precious: true }))!;
          await waitFor(() => started, { message: 'the handler to start' });
          // An operator (or another worker's supervisor) takes the claim away while the handler runs.
          await h.adminPool.query(
            "UPDATE pgboss.job SET state = 'cancelled', completed_on = now() WHERE id = $1",
            [id],
          );
          release();
          await waitFor(() => h.logs.warn.some((m) => /claim was lost/.test(m)), {
            message: 'the lost-claim warning',
          });
          const rows = await jobRows(h.adminPool, queue);
          expect(
            rows.map((r) => r.state),
            'the stale attempt deleted or completed a row it no longer owned',
          ).toEqual(['cancelled']);
        } finally {
          await worker.close();
        }
      });
    });

    describe('defineQueue after start()', () => {
      it('resolves once the queue exists, so a send straight after cannot hit a missing queue', async () => {
        const { jobs, close } = h.makeJobs();
        try {
          await jobs.start();
          const queue = uniqueQueue('late');
          await jobs.defineQueue(queue, { retryLimit: 2 });
          expect(await jobs.send(queue, { n: 1 })).not.toBeNull();
          const { rows } = await h.adminPool.query(
            'SELECT retry_limit FROM pgboss.queue WHERE name = $1',
            [queue],
          );
          expect(rows).toEqual([{ retry_limit: 2 }]);
        } finally {
          await close();
        }
      });
    });

    describe('per-queue retention', () => {
      const queueRow = async (name: string) =>
        (
          await h.adminPool.query<{
            deletion_seconds: number;
            retention_seconds: number;
            retry_limit: number;
            heartbeat_seconds: number | null;
            dead_letter: string | null;
            expire_seconds: number;
          }>(
            `SELECT deletion_seconds, retention_seconds, retry_limit, heartbeat_seconds, dead_letter, expire_seconds
             FROM pgboss.queue WHERE name = $1`,
            [name],
          )
        ).rows[0];

      it("mail.send style: a completed job's row is DELETED immediately; nothing of it remains", async () => {
        const worker = h.makeJobs({ worker: true });
        const queue = uniqueQueue('mail');
        let ran = 0;
        await worker.jobs.handle(queue, () => Promise.resolve(void ran++), {
          retention: { completed: 'immediate', failed: DAY, deadLetter: DAY },
        });
        await worker.jobs.start();
        try {
          const id = await worker.jobs.send(queue, { secret: 'a-reset-token' });
          await waitFor(() => ran === 1, { message: 'the handler' });
          await waitFor(async () => (await jobRows(h.adminPool, queue)).length === 0, {
            message: 'the completed row to be deleted',
          });
          const { rows } = await h.adminPool.query('SELECT 1 FROM pgboss.job WHERE id = $1', [id]);
          expect(rows, 'the payload outlived its use').toEqual([]);
          expect(h.logs.warn.filter((m) => /Could not delete/.test(m))).toEqual([]);
          expect(h.logs.error.filter((m) => /pg-boss error/.test(m))).toEqual([]);
        } finally {
          await worker.close();
        }
      });

      it('mail.send style: a FAILED job is kept (24 h), and so is its dead-letter copy', async () => {
        const worker = h.makeJobs({ worker: true });
        const queue = uniqueQueue('mail');
        await worker.jobs.handle(queue, () => Promise.reject(new Error('smtp down')), {
          retryLimit: 1,
          retryDelaySeconds: 1,
          retryDelayMaxSeconds: 1,
          retention: { completed: 'immediate', failed: DAY, deadLetter: DAY },
        });
        await worker.jobs.start();
        try {
          await worker.jobs.send(queue, { to: 'x' });
          await waitFor(async () => (await jobRows(h.adminPool, `${queue}.dlq`)).length === 1, {
            timeoutMs: 30_000,
            message: 'the dead letter',
          });
          const failed = (
            await h.adminPool.query<{ state: string; deletion_seconds: number }>(
              'SELECT state, deletion_seconds FROM pgboss.job WHERE name = $1',
              [queue],
            )
          ).rows;
          expect(failed).toEqual([{ state: 'failed', deletion_seconds: DAY }]);

          const dlq = (
            await h.adminPool.query<{ ttl: number; deletion_seconds: number }>(
              `SELECT extract(epoch FROM keep_until - created_on)::int AS ttl, deletion_seconds
             FROM pgboss.job WHERE name = $1`,
              [`${queue}.dlq`],
            )
          ).rows[0]!;
          expect(dlq.ttl).toBe(DAY);
          expect(dlq.deletion_seconds).toBe(DAY);
        } finally {
          await worker.close();
        }
      }, 60_000);

      it('writes each queue its own retention, retry and heartbeat settings', async () => {
        const api = h.makeJobs();
        const a = uniqueQueue('ret');
        const b = uniqueQueue('ret');
        api.jobs.defineQueue(a, { retention: { completed: 3600 }, retryLimit: 5 });
        api.jobs.defineQueue(b, {
          expireInSeconds: 1800,
          retention: { completed: 'immediate', failed: DAY, deadLetter: 7200 },
        });
        await api.jobs.start();
        try {
          expect(await queueRow(a)).toMatchObject({
            deletion_seconds: 3600,
            retry_limit: 5,
            heartbeat_seconds: 30,
            dead_letter: `${a}.dlq`,
            expire_seconds: 900,
          });
          expect(await queueRow(b)).toMatchObject({
            deletion_seconds: DAY,
            heartbeat_seconds: 30,
            expire_seconds: 1800,
          });
          expect(await queueRow(`${b}.dlq`)).toMatchObject({
            retention_seconds: 7200,
            deletion_seconds: DAY,
          });
          expect(await queueRow(`${a}.dlq`)).toMatchObject({ retention_seconds: 30 * DAY });
        } finally {
          await api.close();
        }
      });

      it('deletes retained finished jobs when their retention passes (the maintenance pass runs as the app role)', async () => {
        const worker = h.makeJobs({ worker: true, maintenanceIntervalSeconds: 2 });
        const queue = uniqueQueue('ttl');
        let ran = 0;
        await worker.jobs.handle(queue, () => Promise.resolve(void ran++), {
          retention: { completed: 1 },
        });
        await worker.jobs.start();
        try {
          await worker.jobs.send(queue, {});
          await waitFor(async () => (await jobRows(h.adminPool, queue))[0]?.state === 'completed', {
            message: 'completion',
          });
          await waitFor(async () => (await jobRows(h.adminPool, queue)).length === 0, {
            timeoutMs: 30_000,
            message: 'the maintenance pass to delete the finished job',
          });
          expect(ran).toBe(1);
        } finally {
          await worker.close();
        }
      }, 60_000);

      it('converges an EXISTING queue to what the code now says (createQueue alone would not)', async () => {
        const queue = uniqueQueue('conv');
        const v1 = h.makeJobs();
        v1.jobs.defineQueue(queue, { retention: { completed: 100 }, retryLimit: 2 });
        await v1.jobs.start();
        await v1.close();
        expect(await queueRow(queue)).toMatchObject({ deletion_seconds: 100, retry_limit: 2 });

        const v2 = h.makeJobs();
        v2.jobs.defineQueue(queue, {
          retention: { completed: 200 },
          retryLimit: 4,
          expireInSeconds: 60,
        });
        await v2.jobs.start();
        await v2.close();
        expect(await queueRow(queue)).toMatchObject({
          deletion_seconds: 200,
          retry_limit: 4,
          expire_seconds: 60,
          heartbeat_seconds: null,
        });
      });
    });

    describe('definitions are validated before anything runs', () => {
      it('refuses retryLimit 0 without acceptDeadLetterOnDrain', async () => {
        const { jobs, close } = h.makeJobs();
        try {
          await expect(
            jobs.handle(uniqueQueue(), () => Promise.resolve(), { retryLimit: 0 }),
          ).rejects.toThrow(JobsConfigError);
        } finally {
          await close();
        }
      });

      it('a second handler for a queue, or a conflicting definition, is an error', async () => {
        const { jobs, close } = h.makeJobs();
        const queue = uniqueQueue();
        try {
          await jobs.handle(queue, () => Promise.resolve());
          await expect(jobs.handle(queue, () => Promise.resolve())).rejects.toThrow(
            /already has a handler/,
          );
          expect(() => jobs.defineQueue(queue, { retryLimit: 9 })).toThrow(/defined twice/);
          expect(() => jobs.defineQueue(queue)).not.toThrow();
        } finally {
          await close();
        }
      });

      it('send before start, with bad data, or to an undefined queue explains itself', async () => {
        const { jobs, close } = h.makeJobs();
        const queue = uniqueQueue();
        try {
          await expect(jobs.send(queue, {})).rejects.toThrow(/not started/);
          jobs.defineQueue(queue);
          await jobs.start();
          await expect(jobs.send(queue, 'text' as unknown as object)).rejects.toThrow(
            /must be an object/,
          );
          await expect(jobs.send(queue, {}, { priority: 1.5 })).rejects.toThrow(/priority/);
          await expect(jobs.send(queue, {}, { idempotencyKey: '' })).rejects.toThrow(
            /idempotencyKey/,
          );
          await expect(jobs.send('never.defined', {})).rejects.toThrow(
            /not defined.*defineQueue|handle/s,
          );
        } finally {
          await close();
        }
      });

      it('start() is idempotent and a stopped instance cannot be restarted', async () => {
        const { jobs, close } = h.makeJobs();
        await jobs.start();
        await jobs.start();
        await jobs.stop(500);
        await expect(jobs.start()).rejects.toThrow(/stopped/);
        await close();
      });
    });
  },
);
