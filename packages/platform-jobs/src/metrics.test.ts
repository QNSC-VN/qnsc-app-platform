import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readOldestReadyAge, registerOldestReadyAge, OLDEST_READY_AGE_METRIC } from './metrics';
import { dockerOn, sleep, startJobsDb, uniqueQueue, type JobsDb } from './test-support/harness';
import type { Pool } from 'pg';

const { callbacks, createObservableGauge } = vi.hoisted(() => {
  const callbacks: ((result: {
    observe(value: number, attributes: object): void;
  }) => Promise<void>)[] = [];
  return {
    callbacks,
    createObservableGauge: vi.fn(() => ({
      addCallback: (cb: (typeof callbacks)[number]) => callbacks.push(cb),
    })),
  };
});
vi.mock('@quynhonsemiconductor/observability', () => ({
  getMeter: () => ({ createObservableGauge, createCounter: () => ({ add() {} }) }),
  QueueMetrics: class {
    recordLag() {}
  },
}));

describe('registerOldestReadyAge', () => {
  it('registers one observable gauge named next to pgboss.queue.jobs, in seconds', () => {
    registerOldestReadyAge(
      { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as Pool,
      () => ['a'],
      vi.fn(),
    );
    expect(createObservableGauge).toHaveBeenCalledWith(
      OLDEST_READY_AGE_METRIC,
      expect.objectContaining({ unit: 's' }),
    );
    expect(OLDEST_READY_AGE_METRIC).toBe('pgboss.queue.oldest_ready_age');
  });

  it('reports 0, not nothing, for a queue with no ready job, so an alert can see the backlog drain', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ name: 'busy', age: '12.5' }] });
    callbacks.length = 0;
    registerOldestReadyAge({ query } as unknown as Pool, () => ['busy', 'idle'], vi.fn());
    const observed: [number, object][] = [];
    await callbacks[0]!({ observe: (v, a) => observed.push([v, a]) });
    expect(observed).toEqual([
      [12.5, { queue: 'busy' }],
      [0, { queue: 'idle' }],
    ]);
  });

  it('records the contract metric queue.lag_seconds (the oldest ready age) when it reads, not on every collection', async () => {
    const recordLag = vi.fn();
    const query = vi.fn().mockResolvedValue({ rows: [{ name: 'busy', age: '42' }] });
    callbacks.length = 0;
    registerOldestReadyAge({ query } as unknown as Pool, () => ['busy', 'idle'], vi.fn(), {
      recordLag,
    } as never);
    for (let i = 0; i < 3; i++) await callbacks[0]!({ observe: () => undefined });
    expect(recordLag.mock.calls).toEqual([
      ['busy', 42],
      ['idle', 0],
    ]);
  });

  it('reads the database at most every 10 s however often it is collected', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    callbacks.length = 0;
    registerOldestReadyAge({ query } as unknown as Pool, () => ['q'], vi.fn());
    for (let i = 0; i < 5; i++) await callbacks[0]!({ observe: () => undefined });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('a failing query is reported and never thrown into the metrics pipeline', async () => {
    const onError = vi.fn();
    callbacks.length = 0;
    registerOldestReadyAge(
      { query: vi.fn().mockRejectedValue(new Error('db down')) } as unknown as Pool,
      () => ['q'],
      onError,
    );
    await expect(callbacks[0]!({ observe: () => undefined })).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledOnce();
  });

  it('does not query at all when there are no queues', async () => {
    const query = vi.fn();
    expect((await readOldestReadyAge({ query } as unknown as Pool, [])).size).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });
});

describe.skipIf(!dockerOn)('readOldestReadyAge, against a real database as the app role', () => {
  let h: JobsDb;
  beforeAll(async () => {
    h = await startJobsDb();
  }, 180_000);
  afterAll(async () => {
    await h?.stop();
  }, 60_000);

  it('reads the age of the oldest READY job, ignoring deferred and finished ones', async () => {
    const { jobs, close } = h.makeJobs();
    const waiting = uniqueQueue('age');
    const idle = uniqueQueue('age');
    jobs.defineQueue(waiting);
    jobs.defineQueue(idle);
    await jobs.start();
    try {
      await jobs.send(waiting, {});
      await jobs.send(waiting, {}, { startAfter: 3600 }); // deferred: not ready
      await sleep(1_300);
      const ages = await readOldestReadyAge(h.appPool, [waiting, idle]);
      expect(ages.get(waiting)).toBeGreaterThanOrEqual(1);
      expect(ages.get(waiting)).toBeLessThan(10);
      expect(ages.has(idle), 'a queue with nothing ready has no row').toBe(false);
    } finally {
      await close();
    }
  });
});
