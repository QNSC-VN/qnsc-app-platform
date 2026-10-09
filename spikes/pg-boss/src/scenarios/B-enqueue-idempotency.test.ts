import { dockerTestsEnabled } from '@quynhonsemiconductor/testing';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBoss, ensureQueues, type SpikeBoss } from '../support/boss.ts';
import { startCluster, type Cluster } from '../support/cluster.ts';
import { createAppDb, send, withTransaction, type AppDb } from '../support/drizzle.ts';
import { idempotencyId, JOB_EFFECTS_DDL, runOnce } from '../support/idempotency.ts';
import { jobCount } from '../support/jobs-sql.ts';
import { recordResult } from '../support/results.ts';
import { waitFor } from '../support/wait.ts';

/**
 * Not one of the seven scenarios, but WP-7 and WP-8 both promise "duplicate idempotency key ⇒
 * one job/email", and APP-PLATFORM-PLAN §6.7 says the key "maps to pg-boss singleton/dedup key".
 * Whether that mapping holds decides the shape of `jobs.send`, so it is measured here.
 */
const enabled = await dockerTestsEnabled();

describe.skipIf(!enabled)('enqueue idempotency — which pg-boss mechanism dedupes a key?', () => {
  let cluster: Cluster;
  let boss: SpikeBoss;
  let db: AppDb;
  let pool: Pool;
  const found: Record<string, unknown> = {};

  beforeAll(async () => {
    cluster = await startCluster();
    pool = cluster.pool(8);
    db = await createAppDb(pool);
    await pool.query(JOB_EFFECTS_DDL);
    boss = createBoss(pool);
    await boss.start();
    await ensureQueues(boss, ['std', 'throttled', 'by-id']);
  });
  afterAll(async () => {
    recordResult('idempotency', found);
    await boss?.stop({ graceful: true, timeout: 5_000 });
    await cluster?.stop();
  });

  it('singletonKey alone does NOT dedupe on a standard queue', async () => {
    const a = await boss.send('std', { n: 1 }, { singletonKey: 'welcome:42' });
    const b = await boss.send('std', { n: 2 }, { singletonKey: 'welcome:42' });
    found['singletonKeyAlone'] = {
      first: a !== null,
      second: b !== null,
      rows: await jobCount(pool, 'std'),
    };
    expect(a).toBeTypeOf('string');
    expect(b, 'a second job with the same singletonKey was created').toBeTypeOf('string');
  });

  it('singletonKey + singletonSeconds dedupes, but only inside the time slot', async () => {
    const a = await boss.send('throttled', { n: 1 }, { singletonKey: 'k', singletonSeconds: 60 });
    const b = await boss.send('throttled', { n: 2 }, { singletonKey: 'k', singletonSeconds: 60 });
    found['singletonKeyWithSlot'] = { first: a !== null, second: b !== null };
    expect(a).toBeTypeOf('string');
    expect(b).toBeNull();
  });

  it('a deterministic job id dedupes, in a transaction too, and returns null for the duplicate', async () => {
    const id = idempotencyId('by-id', 'receipt:order-7');
    const first = await withTransaction(db, (tx) => send(boss, 'by-id', { n: 1 }, { tx, id }));
    const second = await withTransaction(db, (tx) => send(boss, 'by-id', { n: 2 }, { tx, id }));
    found['deterministicId'] = { first, second, rows: await jobCount(pool, 'by-id') };
    expect(first).toBe(id);
    expect(second).toBeNull();
    expect(await jobCount(pool, 'by-id')).toBe(1);
  });

  it('…and keeps deduping after the first job has completed and while it is retained', async () => {
    const id = idempotencyId('by-id', 'receipt:order-8');
    const handled: string[] = [];
    await boss.work('by-id', { pollingIntervalSeconds: 0.5 }, async (jobs) => {
      handled.push(...jobs.map((j) => j.id));
      return undefined;
    });
    await send(boss, 'by-id', { n: 1 }, { id });
    await waitFor(() => handled.includes(id) || undefined, 'the first job to be handled');
    await waitFor(async () => {
      const { rows } = await pool.query('SELECT 1 FROM pgboss.job WHERE id = $1 AND state = $2', [
        id,
        'completed',
      ]);
      return rows.length === 1 || undefined;
    }, 'the first job to be marked completed');

    const again = await send(boss, 'by-id', { n: 2 }, { id });
    await boss.offWork('by-id');
    found['deterministicIdAfterCompletion'] = { second: again };
    expect(again, 'a completed job stopped blocking its idempotency key').toBeNull();
  });

  it('a mid-transaction duplicate blocks until the first transaction settles, then returns null', async () => {
    // Two requests carrying the same key race. The unique index makes the second WAIT for the
    // first to commit or roll back, rather than both succeeding.
    const id = idempotencyId('by-id', 'receipt:order-9');
    let releaseFirst!: () => void;
    const hold = new Promise<void>((resolve) => (releaseFirst = resolve));
    let secondSettledAt = 0;
    const t0 = Date.now();

    const first = withTransaction(db, async (tx) => {
      await send(boss, 'by-id', { n: 1 }, { tx, id });
      await hold;
    });
    await new Promise((r) => setTimeout(r, 200));
    const second = withTransaction(db, (tx) => send(boss, 'by-id', { n: 2 }, { tx, id })).then(
      (v) => {
        secondSettledAt = Date.now() - t0;
        return v;
      },
    );
    await new Promise((r) => setTimeout(r, 800));
    expect(secondSettledAt, 'the duplicate did not wait for the first transaction').toBe(0);
    releaseFirst();
    await first;
    expect(await second).toBeNull();
    found['concurrentDuplicate'] = { duplicateWaitedMs: secondSettledAt, result: null };
  });

  it('runOnce: the handler-side guard runs the effect once however often the job is delivered', async () => {
    let effects = 0;
    const outcomes: string[] = [];
    for (let delivery = 0; delivery < 3; delivery++) {
      outcomes.push(
        await runOnce(pool, 'mail:welcome:42', async () => {
          effects++;
        }),
      );
    }
    expect(outcomes).toEqual(['ran', 'skipped', 'skipped']);
    expect(effects).toBe(1);

    // A failing effect must NOT leave a marker behind, or the retry would be skipped.
    await expect(
      runOnce(pool, 'mail:welcome:43', async () => {
        throw new Error('smtp down');
      }),
    ).rejects.toThrow('smtp down');
    expect(await runOnce(pool, 'mail:welcome:43', async () => undefined)).toBe('ran');
  });
});
