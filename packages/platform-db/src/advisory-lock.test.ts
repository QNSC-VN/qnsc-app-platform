import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  dockerTestsEnabled,
  startPostgres,
  type PostgresHarness,
} from '@quynhonsemiconductor/testing';
import type { Pool } from 'pg';
import { withAdvisoryLock } from './advisory-lock';
import { DatabaseConnectionError } from './errors';
import { createPool } from './pool';

const enabled = await dockerTestsEnabled();
const quiet = { warn: () => undefined, error: () => undefined };

/** A body that stays inside the lock until released, so two callers genuinely overlap. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

describe.skipIf(!enabled)('withAdvisoryLock', () => {
  let pg: PostgresHarness;
  /** Two pools = two pods: a session lock must exclude across connections, not within one. */
  let podA: Pool;
  let podB: Pool;

  beforeAll(async () => {
    pg = await startPostgres({ tls: true });
  }, 180_000);
  afterAll(async () => {
    await pg?.stop();
  }, 60_000);

  beforeEach(() => {
    podA = createPool({ ...pg.env(), DB_POOL_MAX: '3' }, { logger: quiet });
    podB = createPool({ ...pg.env(), DB_POOL_MAX: '3' }, { logger: quiet });
    return async () => {
      await Promise.all([podA.end(), podB.end()]);
    };
  });

  /** Locks held by sessions other than this one, from the server's own point of view. */
  async function heldLocks(): Promise<number> {
    const { rows } = await pg
      .createPool({ max: 1 })
      .query<{ n: string }>(`SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory'`);
    return Number(rows[0]!.n);
  }

  it('lets exactly one of two concurrent callers run', async () => {
    const g = gate();
    let runs = 0;

    const first = withAdvisoryLock(podA, 'sweep', async () => {
      runs++;
      await g.opened;
      return 'a';
    });
    // B fires while A is inside the lock.
    await expect.poll(() => heldLocks()).toBe(1);
    const second = await withAdvisoryLock(podB, 'sweep', () => {
      runs++;
      return Promise.resolve('b');
    });

    expect(second).toEqual({ acquired: false });
    expect(runs, 'the second caller ran while the first held the lock').toBe(1);

    g.open();
    expect(await first).toEqual({ acquired: true, value: 'a' });
  });

  it('exactly one runs when many callers fire at once', async () => {
    const g = gate();
    let runs = 0;
    const pods = [podA, podB, podA, podB, podA, podB];

    const results = Promise.all(
      pods.map((pool) =>
        withAdvisoryLock(pool, 'burst', async () => {
          runs++;
          await g.opened;
        }),
      ),
    );
    await expect.poll(() => runs).toBeGreaterThanOrEqual(1);
    // Give the losers time to have tried and returned.
    await new Promise((resolve) => setTimeout(resolve, 300));
    g.open();

    const outcomes = await results;
    expect(outcomes.filter((o) => o.acquired)).toHaveLength(1);
    expect(runs).toBe(1);
  });

  it('releases the lock when the body finishes, so the next tick runs', async () => {
    await withAdvisoryLock(podA, 'sweep', () => Promise.resolve());
    expect(await heldLocks()).toBe(0);
    const next = await withAdvisoryLock(podB, 'sweep', () => Promise.resolve('next'));
    expect(next).toEqual({ acquired: true, value: 'next' });
  });

  it('releases the lock when the body throws, and rethrows the body error unchanged', async () => {
    const boom = new Error('job blew up');
    await expect(withAdvisoryLock(podA, 'sweep', () => Promise.reject(boom))).rejects.toBe(boom);

    expect(await heldLocks(), 'a throwing job left its lock held').toBe(0);
    expect(await withAdvisoryLock(podB, 'sweep', () => Promise.resolve(1))).toEqual({
      acquired: true,
      value: 1,
    });
  });

  it('locks per key, so unrelated jobs do not block each other', async () => {
    const g = gate();
    const first = withAdvisoryLock(podA, 'one', () => g.opened);
    await expect.poll(() => heldLocks()).toBe(1);

    const other = await withAdvisoryLock(podB, 'two', () => Promise.resolve('ran'));
    expect(other).toEqual({ acquired: true, value: 'ran' });

    g.open();
    await first;
  });

  it('is freed by the server when the holder dies, with no TTL to wait out', async () => {
    const g = gate();
    let holderPid = 0;
    const holder = withAdvisoryLock(podA, 'crashy', async () => {
      const { rows } = await podA.query<{ pid: number }>(
        `SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted LIMIT 1`,
      );
      holderPid = rows[0]!.pid;
      await g.opened;
    });
    try {
      await expect.poll(() => holderPid).toBeGreaterThan(0);
      // Still held: a second caller is turned away.
      expect(await withAdvisoryLock(podB, 'crashy', () => Promise.resolve(1))).toEqual({
        acquired: false,
      });

      // Kill the holder's session, as a crashed pod's dropped connection would. The process
      // survives (no uncaught 'error' on the checked-out client) and the lock is gone.
      await podB.query('SELECT pg_terminate_backend($1)', [holderPid]);

      await expect
        .poll(() => withAdvisoryLock(podB, 'crashy', () => Promise.resolve('took over')))
        .toEqual({ acquired: true, value: 'took over' });
    } finally {
      g.open();
      // The holder's own unlock fails on the dead connection; it still settles.
      await holder.catch(() => undefined);
    }
  });

  it('never returns a client that still holds the lock to the pool', async () => {
    // One pooled connection only: if the unlock were skipped, the next acquire would reuse
    // the same session (already holding the lock) and appear to take it again.
    const single = createPool({ ...pg.env(), DB_POOL_MAX: '1' }, { logger: quiet });
    try {
      await withAdvisoryLock(single, 'k', () => Promise.resolve());
      expect(await heldLocks()).toBe(0);
      // Another session must be able to take it right away.
      expect(await withAdvisoryLock(podB, 'k', () => Promise.resolve(1))).toEqual({
        acquired: true,
        value: 1,
      });
    } finally {
      await single.end();
    }
  });

  it('rejects with a named DatabaseConnectionError, before the body starts, when it cannot connect', async () => {
    const broken = createPool(
      { ...pg.env(), DATABASE_PASSWORD: 'definitely-not-the-password' },
      { logger: quiet },
    );
    let started = false;
    try {
      const error = await withAdvisoryLock(broken, 'k', () => {
        started = true;
        return Promise.resolve();
      }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(DatabaseConnectionError);
      expect(error).toMatchObject({ code: 'AUTH_FAILED' });
      expect(started).toBe(false);
    } finally {
      await broken.end();
    }
  });
});
