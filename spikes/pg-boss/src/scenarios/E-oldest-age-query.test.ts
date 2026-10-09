import { dockerTestsEnabled } from '@quynhonsemiconductor/testing';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBoss, ensureQueues, type SpikeBoss } from '../support/boss.ts';
import { startCluster, type Cluster } from '../support/cluster.ts';
import { recordResult } from '../support/results.ts';

/**
 * Not one of the seven. Without `persistQueueStats` (which the least-privilege scenario shows is
 * unsafe for a non-owner app role) pg-boss does not compute "age of the oldest ready job":
 * `pgboss.queue.ready_oldest_seconds` stays NULL, and the built-in OTel gauge has no age. WP-7
 * promises that metric, so it has to come from a query of its own. This measures what that query
 * costs on a table the size a busy product reaches, because a gauge that scans the table every
 * 15 seconds would be a cure worse than the disease. (It does not scan: with `NOT blocked` in the
 * WHERE clause the planner uses pg-boss's own partial index; without it, a sequential scan.)
 */
const enabled = await dockerTestsEnabled();

describe.skipIf(!enabled)('oldest-ready-job age as a platform-owned query', () => {
  let cluster: Cluster;
  let pool: Pool;
  let boss: SpikeBoss;

  beforeAll(async () => {
    cluster = await startCluster();
    pool = cluster.pool(4);
    boss = createBoss(pool, { schedule: false, supervise: false });
    await boss.start();
    await ensureQueues(boss, ['age.a', 'age.b']);
    // 1 000 000 completed rows (what a week of retention holds at ~1.6 jobs/s), 500 waiting.
    await pool.query(
      `INSERT INTO pgboss.job (name, state, data, start_after, created_on, started_on, completed_on, keep_until)
       SELECT 'age.' || (CASE WHEN g % 2 = 0 THEN 'a' ELSE 'b' END), 'completed', '{}'::jsonb,
              now() - interval '1 day', now() - interval '1 day', now() - interval '1 day',
              now() - interval '1 day', now() + interval '6 days'
         FROM generate_series(1, 1000000) g`,
    );
    await pool.query(
      `INSERT INTO pgboss.job (name, state, data, start_after, created_on, keep_until)
       SELECT 'age.a', 'created', '{}'::jsonb, now() - (g || ' seconds')::interval, now() - (g || ' seconds')::interval, now() + interval '1 day'
         FROM generate_series(1, 500) g`,
    );
    await pool.query('ANALYZE pgboss.job');
  }, 300_000);
  afterAll(async () => {
    await boss?.stop({ graceful: true, timeout: 3_000 });
    await cluster?.stop();
  });

  // Spelled with the job states pg-boss's own claim query uses, so the planner can use its partial
  // indexes (their predicate is `state < 'active' AND NOT blocked`; without the second term the query seq-scans the table).
  const SQL = `SELECT name, extract(epoch FROM (now() - min(start_after)))::int AS oldest_ready_seconds
                 FROM pgboss.job
                WHERE name = ANY($1) AND state < 'active' AND NOT blocked AND start_after <= now()
                GROUP BY name`;

  it('is an index-only scan on a million-row job table, well under a millisecond', async () => {
    const { rows } = await pool.query<{ name: string; oldest_ready_seconds: number }>(SQL, [
      ['age.a', 'age.b'],
    ]);
    expect(rows).toEqual([{ name: 'age.a', oldest_ready_seconds: 500 }]);

    const timings: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t = performance.now();
      await pool.query(SQL, [['age.a', 'age.b']]);
      timings.push(performance.now() - t);
    }
    const idx = await pool.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE schemaname='pgboss' AND tablename LIKE 'job%'",
    );
    const plan = await pool.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN (ANALYZE, BUFFERS) ${SQL.replace('$1', "ARRAY['age.a','age.b']")}`,
    );
    const text = plan.rows.map((r) => r['QUERY PLAN']).join('\n');
    const execMs = Number(/Execution Time: ([\d.]+) ms/.exec(text)![1]);
    const sorted = [...timings].sort((a, b) => a - b);
    recordResult('oldest-age-query', {
      completedRows: 1_000_000,
      waitingRows: 500,
      roundTripMsP50: Math.round(sorted[10]! * 10) / 10,
      roundTripMsMax: Math.round(sorted.at(-1)! * 10) / 10,
      explainExecutionMs: execMs,
      usesSeqScan: /Seq Scan on (job|pgboss\.job)/.test(text),
      planHead: text.split('\n').slice(0, 8),
      jobIndexes: idx.rows.map((r) => r.indexdef.replace(/ON pgboss\./, 'ON ')),
    });
    expect(/Seq Scan/.test(text), text).toBe(false);
    expect(execMs).toBeLessThan(5);
  });
});
