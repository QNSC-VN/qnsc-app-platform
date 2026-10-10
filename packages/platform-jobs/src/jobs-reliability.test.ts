import { fork, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  dockerOn,
  jobRows,
  sleep,
  startJobsDb,
  uniqueQueue,
  waitFor,
  type JobsDb,
} from './test-support/harness';

const CHILD = join(__dirname, 'test-support', 'worker-child.cjs');

describe.skipIf(!dockerOn)('platform-jobs reliability, as a non-owner application role', () => {
  let h: JobsDb;
  const children = new Set<ChildProcess>();
  beforeAll(async () => {
    h = await startJobsDb();
  }, 180_000);
  afterAll(async () => {
    for (const child of children) child.kill('SIGKILL');
    expect(h.logs.error.filter((m) => /permission denied/i.test(m))).toEqual([]);
    await h?.stop();
  }, 60_000);

  /** Start a worker in its own process; resolves when it has registered its handler. */
  async function startChild(queue: string, worker: string, options: object): Promise<ChildProcess> {
    const child = fork(CHILD, [], {
      env: {
        PATH: process.env['PATH'] ?? '',
        ...h.appEnv,
        CHILD_CONFIG: JSON.stringify({ queue, worker, options }),
      },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    children.add(child);
    await new Promise<void>((resolve, reject) => {
      child.once('message', () => resolve());
      child.once('exit', (code) => reject(new Error(`the child worker exited early (${code})`)));
    });
    return child;
  }

  const effects = async (key: string) =>
    (
      await h.adminPool.query<{ worker: string }>(
        'SELECT worker FROM effects_done WHERE key = $1',
        [key],
      )
    ).rows;

  describe('concurrency and throughput', () => {
    it('never runs more than `concurrency` jobs at once, and does run that many together', async () => {
      const worker = h.makeJobs({ worker: true });
      const queue = uniqueQueue('conc');
      let inFlight = 0;
      let max = 0;
      let done = 0;
      await worker.jobs.handle(
        queue,
        async () => {
          max = Math.max(max, ++inFlight);
          await sleep(300);
          inFlight--;
          done++;
        },
        { concurrency: 3 },
      );
      const api = h.makeJobs();
      api.jobs.defineQueue(queue);
      await api.jobs.start();
      for (let i = 0; i < 9; i++) await api.jobs.send(queue, { i });
      await worker.jobs.start();
      try {
        await waitFor(() => done === 9, { message: 'nine jobs' });
        expect(max).toBe(3);
      } finally {
        await worker.close();
        await api.close();
      }
    }, 60_000);

    it('keeps up with far more than one job per second (pg-boss defaults would take 200 s)', async () => {
      const worker = h.makeJobs({ worker: true });
      const queue = uniqueQueue('rate');
      let done = 0;
      await worker.jobs.handle(queue, () => Promise.resolve(void done++), { concurrency: 25 });
      const api = h.makeJobs();
      api.jobs.defineQueue(queue);
      await api.jobs.start();
      for (let i = 0; i < 200; i++) await api.jobs.send(queue, { i });
      await worker.jobs.start();
      const startedAt = Date.now();
      try {
        await waitFor(() => done === 200, { timeoutMs: 30_000, message: '200 jobs' });
        // A worker with pg-boss's defaults (batchSize 1) drains ONE job per polling interval.
        expect(Date.now() - startedAt).toBeLessThan(15_000);
      } finally {
        await worker.close();
        await api.close();
      }
    }, 60_000);

    it('picks a job up within 1.5 s at p95 with the default 1 s polling interval', async () => {
      const worker = h.makeJobs({ worker: true });
      const api = h.makeJobs();
      const queue = uniqueQueue('lat');
      const sentAt = new Map<string, number>();
      const latencies: number[] = [];
      await worker.jobs.handle<{ n: number }>(queue, (job) => {
        latencies.push(Date.now() - sentAt.get(String(job.data.n))!);
        return Promise.resolve();
      });
      api.jobs.defineQueue(queue);
      await api.jobs.start();
      await worker.jobs.start();
      try {
        for (let n = 0; n < 40; n++) {
          // Random gaps, so the sends do not lock onto the polling phase.
          await sleep(150 + Math.random() * 1_000);
          sentAt.set(String(n), Date.now());
          await api.jobs.send(queue, { n });
        }
        await waitFor(() => latencies.length === 40, { message: 'all 40 pickups' });
        latencies.sort((a, b) => a - b);
        const p95 = latencies[Math.ceil(latencies.length * 0.95) - 1]!;
        console.log(
          `pickup latency n=40 p50=${latencies[19]} ms p95=${p95} ms max=${latencies[39]} ms`,
        );
        expect(p95).toBeLessThanOrEqual(1_500);
      } finally {
        await worker.close();
        await api.close();
      }
    }, 120_000);
  });

  describe('graceful stop (a pod drain)', () => {
    it('lets a short job finish within the budget, and completes it', async () => {
      const worker = h.makeJobs({ worker: true });
      const queue = uniqueQueue('drain');
      let finished = false;
      let started = false;
      await worker.jobs.handle(queue, async () => {
        started = true;
        await sleep(700);
        finished = true;
      });
      await worker.jobs.start();
      await worker.jobs.send(queue, {});
      await waitFor(() => started, { message: 'the job to start' });
      await worker.jobs.stop(5_000);
      try {
        expect(finished).toBe(true);
        expect((await jobRows(h.appPool, queue))[0]!.state).toBe('completed');
      } finally {
        await worker.pool.end();
      }
    }, 30_000);

    it('a job still running when the budget ends spends ONE retry and runs again elsewhere, not dead-lettered', async () => {
      const queue = uniqueQueue('drain');
      const attempts: number[] = [];
      const handler = async (job: { attempt: number; signal: AbortSignal }) => {
        attempts.push(job.attempt);
        // Honours the abort that pg-boss raises when the stop budget runs out.
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, job.attempt === 1 ? 60_000 : 200);
          job.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('aborted: the worker is shutting down'));
          });
        });
      };
      const w1 = h.makeJobs({ worker: true });
      await w1.jobs.handle(queue, handler, { retryDelaySeconds: 1, retryDelayMaxSeconds: 1 });
      await w1.jobs.start();
      await w1.jobs.send(queue, {});
      await waitFor(() => attempts.length === 1, { message: 'attempt 1 to start' });

      await w1.jobs.stop(500); // a drain with a short budget
      await w1.pool.end();

      const afterDrain = (await jobRows(h.adminPool, queue))[0]!;
      expect(afterDrain.state, 'the interrupted job was lost instead of re-queued').toBe('retry');
      // retry_count counts claims after the first, so it goes up when the retry is picked up.
      expect(afterDrain.retry_count).toBe(0);
      expect(await jobRows(h.adminPool, `${queue}.dlq`), 'a drain dead-lettered a job').toEqual([]);

      const w2 = h.makeJobs({ worker: true });
      await w2.jobs.handle(queue, handler, { retryDelaySeconds: 1, retryDelayMaxSeconds: 1 });
      await w2.jobs.start();
      try {
        await waitFor(async () => (await jobRows(h.adminPool, queue))[0]?.state === 'completed', {
          timeoutMs: 30_000,
          message: 'the second worker to finish the job',
        });
        expect(attempts).toEqual([1, 2]);
      } finally {
        await w2.close();
      }
    }, 90_000);

    it('a job whose handler SUCCEEDED stays completed when a slower job in its batch is cut off by the drain', async () => {
      // concurrency 2 => both jobs are fetched as one batch. The fast one finishes and has its
      // side effect; the slow one is still running when stop(1000) ends. pg-boss then fails every
      // job it still holds for the batch, so unless each job is completed the moment its handler
      // returns, the finished job is retried and its side effect runs again on every deploy.
      const queue = uniqueQueue('batchdrain');
      const effects: string[] = [];
      const w = h.makeJobs({ worker: true });
      await w.jobs.handle<{ kind: string }>(
        queue,
        async (job) => {
          if (job.data.kind === 'fast') {
            effects.push('fast');
            return;
          }
          await new Promise<void>((_resolve, reject) => {
            job.signal.addEventListener('abort', () => reject(new Error('aborted')));
          });
        },
        { concurrency: 2, retryDelaySeconds: 30, retryDelayMaxSeconds: 30 },
      );
      const api = h.makeJobs();
      await api.jobs.defineQueue(queue, { retryDelaySeconds: 30, retryDelayMaxSeconds: 30 });
      await api.jobs.start();
      const fastId = (await api.jobs.send(queue, { kind: 'fast' }))!;
      const slowId = (await api.jobs.send(queue, { kind: 'slow' }))!;
      await w.jobs.start();
      try {
        await waitFor(() => effects.length === 1, { message: 'the fast job to run' });
        await sleep(300);
        await w.jobs.stop(1_000);

        const states = Object.fromEntries(
          (await jobRows(h.adminPool, queue)).map((r) => [r.id, r.state]),
        );
        expect(states[fastId], 'a job that had succeeded was failed with its batch').toBe(
          'completed',
        );
        expect(states[slowId]).toBe('retry');
        expect(effects, 'the fast job ran again').toEqual(['fast']);
      } finally {
        await w.pool.end().catch(() => undefined);
        await api.close();
      }
    }, 60_000);

    it('with retryLimit 0 (accepted explicitly), the same drain dead-letters the job: the cost the option documents', async () => {
      const queue = uniqueQueue('drain0');
      const options = { retryLimit: 0, acceptDeadLetterOnDrain: true };
      const w = h.makeJobs({ worker: true });
      let started = false;
      await w.jobs.handle(
        queue,
        (job) =>
          new Promise<void>((_resolve, reject) => {
            started = true;
            job.signal.addEventListener('abort', () => reject(new Error('aborted')));
          }),
        options,
      );
      await w.jobs.start();
      await w.jobs.send(queue, { precious: true });
      await waitFor(() => started, { message: 'the job to start' });
      await w.jobs.stop(300);
      await w.pool.end();

      expect((await jobRows(h.adminPool, queue))[0]!.state).toBe('failed');
      expect(await jobRows(h.adminPool, `${queue}.dlq`)).toHaveLength(1);
    }, 30_000);
  });

  describe('a worker that dies', () => {
    it('SIGKILL mid-job: the job is retried after its lease, and the side effect happens once (jobs.once)', async () => {
      const queue = uniqueQueue('crash');
      const options = { expireInSeconds: 4, retryDelaySeconds: 1, retryDelayMaxSeconds: 1 };

      const child = await startChild(queue, 'A', options);
      const api = h.makeJobs();
      api.jobs.defineQueue(queue, options);
      await api.jobs.start();
      const id = (await api.jobs.send(queue, { work: 'transcode' }))!;
      await waitFor(async () => (await effects(`started:${id}`)).length === 1, {
        message: 'worker A to start the job',
      });
      expect(await effects(id)).toEqual([{ worker: 'A' }]);

      child.kill('SIGKILL'); // the effect is done; the job is not

      // Worker B takes over once the lease ends and a supervise pass notices.
      const b = h.makeJobs({
        worker: true,
        superviseIntervalSeconds: 2,
        monitorIntervalSeconds: 2,
      });
      const seenBy: number[] = [];
      await b.jobs.handle(
        queue,
        async (job) => {
          seenBy.push(job.attempt);
          const result = await b.jobs.once(h.db, job.id, (tx) =>
            tx.execute(sql`INSERT INTO effects_done (key, worker) VALUES (${job.id}, 'B')`),
          );
          expect(result.ran, 'the side effect ran a second time').toBe(false);
        },
        options,
      );
      await b.jobs.start();
      try {
        await waitFor(async () => (await jobRows(h.adminPool, queue))[0]?.state === 'completed', {
          timeoutMs: 45_000,
          message: 'worker B to finish the recovered job',
        });
        expect(seenBy).toEqual([2]);
        expect(await effects(id), 'exactly one side effect, from the worker that died').toEqual([
          { worker: 'A' },
        ]);
      } finally {
        await b.close();
        await api.close();
      }
    }, 90_000);

    it('with a heartbeat, a long job is recovered long before its lease ends', async () => {
      const queue = uniqueQueue('beat');
      // A 20-minute lease. Without the heartbeat the job would sit until it expired.
      const options = {
        expireInSeconds: 1200,
        heartbeatSeconds: 10,
        retryDelaySeconds: 1,
        retryDelayMaxSeconds: 1,
      };
      const child = await startChild(queue, 'A', options);
      const api = h.makeJobs();
      api.jobs.defineQueue(queue, options);
      await api.jobs.start();
      const id = (await api.jobs.send(queue, {}))!;
      await waitFor(async () => (await effects(`started:${id}`)).length === 1, {
        message: 'A to start the job',
      });

      const killedAt = Date.now();
      child.kill('SIGKILL');

      // The monitor pass (default 60 s, gated per queue) is what notices a lapsed heartbeat; shortened
      // here so the test measures the heartbeat, not that interval. Production adds up to 60 s.
      const b = h.makeJobs({
        worker: true,
        superviseIntervalSeconds: 2,
        monitorIntervalSeconds: 2,
      });
      await b.jobs.handle(queue, () => Promise.resolve(), options);
      await b.jobs.start();
      try {
        await waitFor(async () => (await jobRows(h.adminPool, queue))[0]?.state === 'completed', {
          timeoutMs: 90_000,
          message: 'recovery through the heartbeat',
        });
        const seconds = (Date.now() - killedAt) / 1000;
        console.log(
          `recovered ${seconds.toFixed(1)} s after the kill (lease: 1200 s, heartbeat: 10 s)`,
        );
        expect(seconds).toBeLessThan(60);
      } finally {
        await b.close();
        await api.close();
      }
    }, 120_000);

    it('a long-running job that is ALIVE is not taken over: the heartbeat keeps its claim', async () => {
      const queue = uniqueQueue('alive');
      const options = { expireInSeconds: 1200, heartbeatSeconds: 10 };
      const runs: number[] = [];
      const a = h.makeJobs({
        worker: true,
        superviseIntervalSeconds: 2,
        monitorIntervalSeconds: 2,
      });
      await a.jobs.handle(
        queue,
        async (job) => {
          runs.push(job.attempt);
          await sleep(35_000); // longer than three heartbeat intervals
        },
        options,
      );
      const peer = h.makeJobs({
        worker: true,
        superviseIntervalSeconds: 2,
        monitorIntervalSeconds: 2,
      });
      await peer.jobs.handle(queue, async (job) => void runs.push(100 + job.attempt), options);
      await a.jobs.start();
      await a.jobs.send(queue, {});
      await waitFor(() => runs.length === 1, { message: 'the job to start' });
      await peer.jobs.start();
      try {
        await waitFor(async () => (await jobRows(h.adminPool, queue))[0]?.state === 'completed', {
          timeoutMs: 60_000,
          message: 'the long job to finish',
        });
        expect(runs).toEqual([1]);
      } finally {
        await a.close();
        await peer.close();
      }
    }, 120_000);
  });

  describe('schedules', () => {
    it('two workers, one execution per tick (cron every minute, Asia/Ho_Chi_Minh)', async () => {
      const queue = uniqueQueue('cron');
      const w1 = h.makeJobs({ worker: true });
      const w2 = h.makeJobs({ worker: true });
      const ran: { by: string; at: number }[] = [];
      for (const [name, w] of [
        ['w1', w1],
        ['w2', w2],
      ] as const) {
        await w.jobs.handle(queue, () =>
          Promise.resolve(void ran.push({ by: name, at: Date.now() })),
        );
        await w.jobs.schedule(queue, '* * * * *', { tick: true });
        await w.jobs.start();
      }
      try {
        await waitFor(
          async () =>
            (await jobRows(h.adminPool, queue)).filter((r) => r.state === 'completed').length >= 2,
          {
            timeoutMs: 170_000,
            intervalMs: 1_000,
            message: 'two ticks',
          },
        );
        const rows = await jobRows(h.adminPool, queue);
        // One job per minute, however many replicas registered the schedule...
        const minutes = rows.map((r) => Math.floor(r.created_on.getTime() / 60_000));
        expect(
          new Set(minutes).size,
          `a tick produced more than one job: ${minutes.join(',')}`,
        ).toBe(minutes.length);
        // ...and one execution per job.
        expect(ran.length).toBe(rows.filter((r) => r.state === 'completed').length);
        const { rows: sched } = await h.adminPool.query<{ timezone: string; cron: string }>(
          'SELECT timezone, cron FROM pgboss.schedule WHERE name = $1',
          [queue],
        );
        expect(sched).toEqual([{ timezone: 'Asia/Ho_Chi_Minh', cron: '* * * * *' }]);
      } finally {
        await w1.close();
        await w2.close();
      }
    }, 200_000);

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

  describe('jobs.once', () => {
    it('runs the effect once per key, however many times it is called', async () => {
      const { jobs, close } = h.makeJobs();
      try {
        let runs = 0;
        const effect = () => {
          runs++;
          return Promise.resolve('done');
        };
        const key = `k-${Math.random()}`;
        expect(await jobs.once(h.db, key, effect)).toEqual({ ran: true, value: 'done' });
        expect(await jobs.once(h.db, key, effect)).toEqual({ ran: false });
        expect(await jobs.once(h.db, `${key}-other`, effect)).toEqual({ ran: true, value: 'done' });
        expect(runs).toBe(2);
      } finally {
        await close();
      }
    });

    it('a failing effect leaves no marker, so the redelivery runs it again', async () => {
      const { jobs, close } = h.makeJobs();
      try {
        const key = `fail-${Math.random()}`;
        await expect(
          jobs.once(h.db, key, () => Promise.reject(new Error('provider down'))),
        ).rejects.toThrow('provider down');
        expect(await jobs.once(h.db, key, () => Promise.resolve('second time lucky'))).toEqual({
          ran: true,
          value: 'second time lucky',
        });
      } finally {
        await close();
      }
    });

    it("shares the caller's transaction: roll it back and the marker goes with the effect", async () => {
      const { jobs, close } = h.makeJobs();
      try {
        const key = `tx-${Math.random()}`;
        const { withTransaction } = await import('@quynhonsemiconductor/platform-db/drizzle');
        await withTransaction(h.db, async (tx) => {
          await jobs.once(tx, key, (inner) =>
            inner.execute(sql`INSERT INTO effects_done (key, worker) VALUES (${key}, 'tx')`),
          );
          throw new Error('rolled back');
        }).catch(() => undefined);
        expect(await effects(key)).toEqual([]);
        expect((await jobs.once(h.db, key, () => Promise.resolve(1))).ran).toBe(true);
      } finally {
        await close();
      }
    });

    it('an effect that throws is rolled back WITH its marker even when the caller catches it and commits', async () => {
      const { jobs, close } = h.makeJobs();
      try {
        const { withTransaction } = await import('@quynhonsemiconductor/platform-db/drizzle');
        const key = `savepoint-${Math.random()}`;
        await withTransaction(h.db, async (tx) => {
          // The caller swallows the failure and carries on to commit the rest of its work.
          await jobs
            .once(tx, key, async (inner) => {
              await inner.execute(
                sql`INSERT INTO effects_done (key, worker) VALUES (${key}, 'half')`,
              );
              throw new Error('the effect failed half way');
            })
            .catch(() => undefined);
          await tx.execute(sql`INSERT INTO orders (id, customer) VALUES (7001, 'kept')`);
        });

        expect(await effects(key), 'the partial effect committed').toEqual([]);
        const { rows } = await h.adminPool.query(
          'SELECT 1 FROM pgboss.platform_effect WHERE key = $1',
          [key],
        );
        expect(rows, 'the marker committed, so every later delivery would skip the effect').toEqual(
          [],
        );
        expect((await h.adminPool.query('SELECT 1 FROM orders WHERE id = 7001')).rows).toHaveLength(
          1,
        );

        expect((await jobs.once(h.db, key, () => Promise.resolve('again'))).ran).toBe(true);
      } finally {
        await close();
      }
    });

    it('rejects an empty key', async () => {
      const { jobs, close } = h.makeJobs();
      try {
        await expect(jobs.once(h.db, '', () => Promise.resolve())).rejects.toThrow(/key/);
      } finally {
        await close();
      }
    });
  });
});
