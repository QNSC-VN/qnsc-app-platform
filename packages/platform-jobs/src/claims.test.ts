import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HELD_CLAIMS_SQL } from './claims';
import {
  dockerOn,
  sleep,
  startJobsDb,
  uniqueQueue,
  waitFor,
  type JobsDb,
} from './test-support/harness';

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  Plans?: PlanNode[];
}

function nodes(plan: PlanNode): PlanNode[] {
  return [plan, ...(plan.Plans ?? []).flatMap(nodes)];
}

describe.skipIf(!dockerOn)('HELD_CLAIMS_SQL, against a table with many other jobs', () => {
  let h: JobsDb;
  beforeAll(async () => {
    h = await startJobsDb();
  }, 180_000);
  afterAll(async () => {
    await h?.stop();
  }, 60_000);

  it('answers which claims are still held: active, and at the attempt that ran', async () => {
    const { jobs, close } = h.makeJobs({ worker: true });
    const queue = uniqueQueue('claims');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let started = 0;
    await jobs.handle(
      queue,
      async () => {
        started++;
        await gate;
      },
      { concurrency: 2 },
    );
    await jobs.start();
    try {
      const a = (await jobs.send(queue, { n: 1 }))!;
      const b = (await jobs.send(queue, { n: 2 }))!;
      await waitFor(() => started === 2, { message: 'both jobs to be active' });

      const held = async (ids: string[], attempts: number[]) =>
        (await h.appPool.query<{ id: string }>(HELD_CLAIMS_SQL, [queue, ids, attempts])).rows
          .map((r) => r.id)
          .sort();

      expect(await held([a, b], [0, 0])).toEqual([a, b].sort());
      expect(await held([a, b], [0, 1]), 'a wrong attempt number still counted as held').toEqual([
        a,
      ]);
      expect(await held([a, randomUUID()], [0, 0]), 'an unknown job counted as held').toEqual([a]);
      expect(await held([a], [0]).then((r) => r.length)).toBe(1);

      await h.adminPool.query("UPDATE pgboss.job SET state = 'cancelled' WHERE id = $1", [b]);
      expect(await held([a, b], [0, 0]), 'a job that is no longer active counted as held').toEqual([
        a,
      ]);
      expect(
        await h.appPool.query(HELD_CLAIMS_SQL, ['some.other.queue', [a], [0]]).then((r) => r.rows),
      ).toEqual([]);
    } finally {
      release();
      await close();
    }
  });

  it('is an index probe on the primary key, not a scan of every queue (30,000 other jobs)', async () => {
    const { jobs, close } = h.makeJobs();
    const queue = uniqueQueue('claims');
    await jobs.defineQueue(queue);
    await jobs.start();
    try {
      const id = (await jobs.send(queue, { n: 1 }))!;
      // 30,000 more jobs on other queues: clones of a real row, so the table is real.
      await h.adminPool.query(
        `INSERT INTO pgboss.job
           SELECT (jsonb_populate_record(NULL::pgboss.job,
                    to_jsonb(j) || jsonb_build_object('id', gen_random_uuid(), 'state', 'completed')
                                || jsonb_build_object('name', $2::text))).*
             FROM pgboss.job j, generate_series(1, 30000)
            WHERE j.id = $1`,
        [id, queue],
      );
      await h.adminPool.query('ANALYZE pgboss.job');
      await sleep(200);

      const { rows } = await h.adminPool.query<{ 'QUERY PLAN': [{ Plan: PlanNode }] }>(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${HELD_CLAIMS_SQL}`,
        [queue, [id, randomUUID()], [0, 0]],
      );
      const plan = rows[0]!['QUERY PLAN'][0].Plan;
      const all = nodes(plan);
      const scans = all.filter(
        (n) => /Seq Scan/.test(n['Node Type']) && /^job/.test(n['Relation Name'] ?? ''),
      );
      const buffers = all.reduce(
        (sum, n) => sum + (n['Shared Hit Blocks'] ?? 0) + (n['Shared Read Blocks'] ?? 0),
        0,
      );

      expect(
        scans.map((n) => n['Relation Name']),
        'the claim check scans the job table',
      ).toEqual([]);
      // The sequential scan this replaces reads thousands of buffers at this size.
      expect(buffers).toBeLessThan(300);
    } finally {
      await close();
    }
  }, 120_000);
});
