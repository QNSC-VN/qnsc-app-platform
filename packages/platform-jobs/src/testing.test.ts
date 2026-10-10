import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drainQueue, runInline } from './testing';
import { PermanentJobError } from './errors';
import { dockerOn, jobRows, startJobsDb, uniqueQueue, type JobsDb } from './test-support/harness';
import { createJobs } from './engine';
import type { Pool } from 'pg';

describe('runInline', () => {
  const jobs = createJobs({ pool: {} as Pool, env: {} });

  it('runs the registered handler with the data, a fresh id and attempt 1, without a database', async () => {
    const seen: unknown[] = [];
    const queue = uniqueQueue('inline');
    await jobs.handle<{ to: string }>(queue, (job) => {
      seen.push({
        data: job.data,
        attempt: job.attempt,
        aborted: job.signal.aborted,
        idLength: job.id.length,
      });
      return Promise.resolve();
    });
    await runInline(jobs, queue, { to: 'ada@example.test' });
    expect(seen).toEqual([
      { data: { to: 'ada@example.test' }, attempt: 1, aborted: false, idLength: 36 },
    ]);
  });

  it('works whatever ROLE is, because it never involves a worker', async () => {
    const queue = uniqueQueue('inline');
    let ran = false;
    await jobs.handle(queue, () => Promise.resolve(void (ran = true)));
    await runInline(jobs, queue, {});
    expect(ran).toBe(true);
  });

  it('rejects with what the handler throws', async () => {
    const queue = uniqueQueue('inline');
    await jobs.handle(queue, () => Promise.reject(new Error('handler bug')));
    await expect(runInline(jobs, queue, {})).rejects.toThrow('handler bug');
  });

  it('can simulate a retry by overriding the attempt', async () => {
    const queue = uniqueQueue('inline');
    const attempts: number[] = [];
    await jobs.handle(queue, (job) => Promise.resolve(void attempts.push(job.attempt)));
    await runInline(jobs, queue, {}, { attempt: 3 });
    expect(attempts).toEqual([3]);
  });

  it('says which queue has no handler', async () => {
    await expect(runInline(jobs, 'nobody.home', {})).rejects.toThrow(
      /No handler is registered for queue "nobody.home"/,
    );
  });

  it('refuses a Jobs it did not create', async () => {
    await expect(runInline({} as never, 'q', {})).rejects.toThrow(/createJobs/);
  });
});

describe.skipIf(!dockerOn)('drainQueue, against a real database', () => {
  let h: JobsDb;
  beforeAll(async () => {
    h = await startJobsDb();
  }, 180_000);
  afterAll(async () => {
    await h?.stop();
  }, 60_000);

  it('processes every ready job now, without a worker and without waiting for polling', async () => {
    // An ordinary API-role instance: no ROLE=worker, no polling. A product test does exactly this.
    const { jobs, close } = h.makeJobs();
    const queue = uniqueQueue('drain');
    const done: number[] = [];
    await jobs.handle<{ n: number }>(queue, (job) => Promise.resolve(void done.push(job.data.n)));
    await jobs.start();
    try {
      for (const n of [1, 2, 3, 4, 5]) await jobs.send(queue, { n });
      const startedAt = Date.now();
      await drainQueue(jobs, queue);
      expect(Date.now() - startedAt).toBeLessThan(3_000);
      expect(done.sort()).toEqual([1, 2, 3, 4, 5]);
      expect((await jobRows(h.appPool, queue)).every((r) => r.state === 'completed')).toBe(true);
    } finally {
      await close();
    }
  });

  it('drains more than one batch', async () => {
    const { jobs, close } = h.makeJobs();
    const queue = uniqueQueue('drain');
    let n = 0;
    await jobs.handle(queue, () => Promise.resolve(void n++), { concurrency: 2 });
    await jobs.start();
    try {
      for (let i = 0; i < 7; i++) await jobs.send(queue, { i });
      await drainQueue(jobs, queue);
      expect(n).toBe(7);
    } finally {
      await close();
    }
  });

  it('applies the real retention: with completed "immediate" the rows are gone afterwards', async () => {
    const { jobs, close } = h.makeJobs();
    const queue = uniqueQueue('drain');
    await jobs.handle(queue, () => Promise.resolve(), { retention: { completed: 'immediate' } });
    await jobs.start();
    try {
      await jobs.send(queue, { secret: 's' });
      await drainQueue(jobs, queue);
      expect(await jobRows(h.appPool, queue)).toEqual([]);
    } finally {
      await close();
    }
  });

  it('rejects with the handler error, after settling the job as a failure that will be retried', async () => {
    const { jobs, close } = h.makeJobs();
    const queue = uniqueQueue('drain');
    await jobs.handle(queue, () => Promise.reject(new Error('handler bug')), {
      retryDelaySeconds: 30,
      retryDelayMaxSeconds: 30,
    });
    await jobs.start();
    try {
      await jobs.send(queue, {});
      await expect(drainQueue(jobs, queue)).rejects.toThrow(/handler bug/);
      const [row] = await jobRows(h.appPool, queue);
      expect(row!.state).toBe('retry');
      // The retry is scheduled 30 s out, so it is not "ready": a second drain leaves it alone.
      await drainQueue(jobs, queue);
    } finally {
      await close();
    }
  });

  it('hands the handler a REAL AbortSignal, as a worker does', async () => {
    const { jobs, close } = h.makeJobs();
    const queue = uniqueQueue('drain');
    const seen: { isSignal: boolean; aborted: boolean }[] = [];
    await jobs.handle(queue, (job) => {
      seen.push({ isSignal: job.signal instanceof AbortSignal, aborted: job.signal.aborted });
      return Promise.resolve();
    });
    await jobs.start();
    try {
      await jobs.send(queue, {});
      await drainQueue(jobs, queue);
      expect(seen).toEqual([{ isSignal: true, aborted: false }]);
    } finally {
      await close();
    }
  });

  it('stores the failure the way a worker does: name and message, not "[object Object]"', async () => {
    const { jobs, close } = h.makeJobs();
    const queue = uniqueQueue('drain');
    await jobs.handle(queue, () => Promise.reject(new TypeError('handler bug')), {
      retryDelaySeconds: 30,
      retryDelayMaxSeconds: 30,
    });
    await jobs.start();
    try {
      await jobs.send(queue, {});
      await expect(drainQueue(jobs, queue)).rejects.toThrow(/handler bug/);
      const [row] = await jobRows(h.appPool, queue);
      expect(row!.output).toEqual({ name: 'TypeError', message: 'handler bug' });
      expect(JSON.stringify(row!.output)).not.toContain('[object Object]');
    } finally {
      await close();
    }
  });

  it('honours PermanentJobError: dead-lettered on the first attempt, with no retry left to wait for', async () => {
    const { jobs, close } = h.makeJobs();
    const queue = uniqueQueue('drain');
    const attempts: number[] = [];
    await jobs.handle(
      queue,
      (job) => {
        attempts.push(job.attempt);
        return Promise.reject(new PermanentJobError('no such user'));
      },
      { retryLimit: 5 },
    );
    await jobs.start();
    try {
      await jobs.send(queue, { user: 'gone' });
      await expect(drainQueue(jobs, queue)).rejects.toThrow(/no such user/);
      expect(attempts).toEqual([1]);
      expect((await jobRows(h.appPool, queue))[0]).toMatchObject({
        state: 'failed',
        retry_count: 0,
      });
      const dead = await jobRows(h.appPool, `${queue}.dlq`);
      expect(dead).toHaveLength(1);
      expect(dead[0]!.data).toEqual({ user: 'gone' });
    } finally {
      await close();
    }
  });

  it('THROWS when the queue is not quiet by the timeout, instead of returning as if it had drained', async () => {
    const hung = createJobs({
      pool: h.appPool,
      env: { ...h.appEnv },
      internal: { drainTimeoutMs: 800 },
    });
    const queue = uniqueQueue('hang');
    await hung.handle(queue, () => new Promise<void>(() => undefined));
    await hung.start();
    try {
      await hung.send(queue, {});
      const startedAt = Date.now();
      await expect(drainQueue(hung, queue)).rejects.toThrow(
        /still had ready or active jobs after 800 ms/,
      );
      expect(Date.now() - startedAt, 'it waited for a handler that never returns').toBeLessThan(
        5_000,
      );
    } finally {
      await hung.stop(300).catch(() => undefined);
    }
  });

  it('refuses to drain before start() (it needs the database)', async () => {
    const { jobs, close } = h.makeJobs();
    const queue = uniqueQueue('drain');
    await jobs.handle(queue, () => Promise.resolve());
    try {
      await expect(drainQueue(jobs, queue)).rejects.toThrow(/not started/);
    } finally {
      await close();
    }
  });

  it('leaves jobs scheduled for later alone', async () => {
    const { jobs, close } = h.makeJobs();
    const queue = uniqueQueue('drain');
    let ran = 0;
    await jobs.handle(queue, () => Promise.resolve(void ran++));
    await jobs.start();
    try {
      await jobs.send(queue, {}, { startAfter: 3600 });
      await jobs.send(queue, {});
      await drainQueue(jobs, queue);
      expect(ran).toBe(1);
      expect((await jobRows(h.appPool, queue)).map((r) => r.state).sort()).toEqual([
        'completed',
        'created',
      ]);
    } finally {
      await close();
    }
  });

  it('is a no-op on an empty queue', async () => {
    const { jobs, close } = h.makeJobs();
    const queue = uniqueQueue('drain');
    await jobs.handle(queue, () => Promise.resolve());
    await jobs.start();
    try {
      await expect(drainQueue(jobs, queue)).resolves.toBeUndefined();
    } finally {
      await close();
    }
  });
});
