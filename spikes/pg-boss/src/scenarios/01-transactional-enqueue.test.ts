import { dockerTestsEnabled } from '@quynhonsemiconductor/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBoss, ensureQueues, type SpikeBoss } from '../support/boss.ts';
import { startCluster, type Cluster } from '../support/cluster.ts';
import { createAppDb, orders, send, withTransaction, type AppDb } from '../support/drizzle.ts';
import { jobCount, jobRows } from '../support/jobs-sql.ts';
import { sleep, waitFor } from '../support/wait.ts';

/**
 * Scenario 1 (PORTFOLIO-TECH-REVIEW §2A.6) and the WP-6 addition "enqueue inside a Drizzle
 * transaction through the DbExecutor from platform-db".
 *
 *   Email job enqueued inside a business transaction; transaction rolled back.
 *   PASS: no job exists after rollback; job exists after commit.
 */
const enabled = await dockerTestsEnabled();

describe.skipIf(!enabled)('scenario 1 — transactional enqueue through the DbExecutor', () => {
  let cluster: Cluster;
  let db: AppDb;
  let boss: SpikeBoss;
  const QUEUE = 'mail.send';
  const pool = () => db.$client;

  beforeAll(async () => {
    cluster = await startCluster();
    db = await createAppDb(cluster.pool(8));
    boss = createBoss(db.$client);
    await boss.start();
    await ensureQueues(boss, [QUEUE]);
  });
  afterAll(async () => {
    await boss?.stop({ graceful: true, timeout: 5_000 });
    await cluster?.stop();
  });

  const orderExists = async (id: number) =>
    (await db.select().from(orders).where(eq(orders.id, id))).length === 1;

  it('rollback: a job enqueued in a transaction that throws does not exist afterwards', async () => {
    const before = await jobCount(pool(), QUEUE);
    const boom = new Error('business rule failed after the email was enqueued');

    await expect(
      withTransaction(db, async (tx) => {
        await tx.insert(orders).values({ id: 1, customer: 'ada' });
        const id = await send(boss, QUEUE, { to: 'ada@example.test', template: 'receipt' }, { tx });
        expect(id, 'send inside the transaction returns a job id').toBeTypeOf('string');
        throw boom;
      }),
    ).rejects.toBe(boom);

    expect(await jobCount(pool(), QUEUE)).toBe(before);
    expect(await orderExists(1), 'the business row must have rolled back too').toBe(false);
  });

  it('rollback: a database error AFTER the enqueue (constraint violation) also removes the job', async () => {
    await db.insert(orders).values({ id: 2, customer: 'grace' });
    const before = await jobCount(pool(), QUEUE);

    await expect(
      withTransaction(db, async (tx) => {
        await send(boss, QUEUE, { to: 'dup@example.test' }, { tx });
        await tx.insert(orders).values({ id: 2, customer: 'duplicate primary key' });
      }),
    ).rejects.toThrow();

    expect(await jobCount(pool(), QUEUE)).toBe(before);
  });

  it('commit: the job exists, with the business row, once the transaction commits', async () => {
    const jobId = await withTransaction(db, async (tx) => {
      await tx.insert(orders).values({ id: 3, customer: 'linus' });
      return send(boss, QUEUE, { to: 'linus@example.test', orderId: 3 }, { tx });
    });

    expect(jobId).toBeTypeOf('string');
    expect(await orderExists(3)).toBe(true);
    const rows = (await jobRows(pool(), QUEUE)).filter((r) => r.id === jobId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe('created');
    expect(rows[0]!.data).toEqual({ to: 'linus@example.test', orderId: 3 });
  });

  it('is invisible to workers before the commit, then delivered after it', async () => {
    const queue = 'mail.visibility';
    await ensureQueues(boss, [queue]);
    const seen: number[] = [];
    const t0 = Date.now();
    await boss.work(queue, { pollingIntervalSeconds: 0.5 }, async (jobs) => {
      seen.push(...jobs.map(() => Date.now() - t0));
      return undefined;
    });

    let committedAt = 0;
    await withTransaction(db, async (tx) => {
      await tx.insert(orders).values({ id: 4, customer: 'barbara' });
      await send(boss, queue, { orderId: 4 }, { tx });
      // Four polling intervals with the job written but not committed.
      await sleep(2_000);
      expect(seen, 'a worker fetched a job whose transaction had not committed').toEqual([]);
      committedAt = Date.now() - t0;
    });

    await waitFor(() => seen.length === 1 || undefined, 'the committed job to be delivered');
    expect(seen[0]!).toBeGreaterThanOrEqual(committedAt);
    await boss.offWork(queue);
  });

  it('JOINS an outer transaction: an inner withTransaction does not commit the job early', async () => {
    const before = await jobCount(pool(), QUEUE);
    const boom = new Error('outer failed after inner succeeded');

    await expect(
      withTransaction(db, async (outer) => {
        await withTransaction(outer, async (inner) => {
          expect(inner).toBe(outer);
          await send(boss, QUEUE, { to: 'inner@example.test' }, { tx: inner });
        });
        throw boom;
      }),
    ).rejects.toBe(boom);

    expect(await jobCount(pool(), QUEUE), 'the inner enqueue survived the outer rollback').toBe(
      before,
    );
  });

  it('accepts the ROOT database as a DbExecutor too (no transaction: the job commits on its own)', async () => {
    const before = await jobCount(pool(), QUEUE);
    const id = await send(boss, QUEUE, { to: 'root@example.test' }, { tx: db });
    expect(id).toBeTypeOf('string');
    expect(await jobCount(pool(), QUEUE)).toBe(before + 1);
  });

  it('startAfter and priority pass through the transactional path', async () => {
    const when = new Date(Date.now() + 3_600_000);
    const id = await withTransaction(db, (tx) =>
      send(boss, QUEUE, { n: 1 }, { tx, startAfter: when, priority: 7 }),
    );
    const { rows } = await pool().query<{ priority: number; start_after: Date }>(
      'SELECT priority, start_after FROM pgboss.job WHERE id = $1',
      [id],
    );
    expect(rows[0]!.priority).toBe(7);
    expect(rows[0]!.start_after.getTime()).toBe(when.getTime());
  });

  it('pg-boss emitted no errors', () => {
    expect(boss.errors).toEqual([]);
  });
});
