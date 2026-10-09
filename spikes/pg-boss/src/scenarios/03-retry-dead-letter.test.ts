import { dockerTestsEnabled } from '@quynhonsemiconductor/testing';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBoss, ensureQueues, type SpikeBoss } from '../support/boss.ts';
import { startCluster, type Cluster } from '../support/cluster.ts';
import { jobRows } from '../support/jobs-sql.ts';
import { waitFor } from '../support/wait.ts';
import { recordResult } from '../support/results.ts';

/**
 * Scenario 3 (PORTFOLIO-TECH-REVIEW §2A.6):
 *
 *   Failing job.
 *   PASS: retries with backoff, then lands in the dead-letter queue.
 *
 * Also checks the two things the platform plan builds on: the dead-lettered copy keeps the
 * payload, the source queue and the error (so an operator can act on it and `redrive` it), and
 * what "retention" really means in pg-boss, because WP-7 promises "completed 7 days, failed 30
 * days, dead-letter until handled".
 */
const enabled = await dockerTestsEnabled();

describe.skipIf(!enabled)('scenario 3 — failing job: retry with backoff, then dead-letter', () => {
  let cluster: Cluster;
  let boss: SpikeBoss;
  let pool: Pool;
  const QUEUE = 'webhook.deliver';
  const DLQ = 'webhook.deliver.dlq';
  const ATTEMPTS: number[] = [];

  beforeAll(async () => {
    cluster = await startCluster();
    pool = cluster.pool(8);
    boss = createBoss(pool);
    await boss.start();
    // The dead-letter queue must exist before a queue can name it.
    await ensureQueues(boss, [
      { name: DLQ, retentionSeconds: 5 * 365 * 24 * 3600, deleteAfterSeconds: 30 * 24 * 3600 },
      {
        name: QUEUE,
        retryLimit: 3,
        retryDelay: 1,
        retryBackoff: true,
        deadLetter: DLQ,
        deleteAfterSeconds: 7 * 24 * 3600,
      },
    ]);
  });
  afterAll(async () => {
    await boss?.stop({ graceful: true, timeout: 5_000 });
    await cluster?.stop();
  });

  it('retries with growing delays, then moves the job to the dead-letter queue intact', async () => {
    await boss.work(QUEUE, { pollingIntervalSeconds: 0.5 }, async () => {
      ATTEMPTS.push(Date.now());
      throw new Error('receiver answered 503');
    });
    const payload = { url: 'https://hooks.example.test/x', body: { event: 'order.paid' } };
    const sentAt = Date.now();
    const id = await boss.send(QUEUE, payload);
    expect(id).toBeTypeOf('string');

    const dead = await waitFor(
      async () => (await jobRows(pool, DLQ))[0],
      'the job to reach the dead-letter queue',
      { timeoutMs: 60_000, intervalMs: 250 },
    );

    // 1 first attempt + retryLimit (3) retries, then no more.
    expect(ATTEMPTS).toHaveLength(4);
    const gapsMs = ATTEMPTS.slice(1).map((t, i) => t - ATTEMPTS[i]!);
    // retryDelay 1 s with backoff: each retry waits at least as long as the one before it (the
    // jitter is bounded below by the un-jittered half), and the later ones are strictly longer
    // than the first.
    expect(gapsMs[0]!).toBeGreaterThanOrEqual(900);
    expect(gapsMs[2]!).toBeGreaterThan(gapsMs[0]!);

    // The original is `failed`, having used its whole retry budget.
    const [original] = await jobRows(pool, QUEUE);
    expect(original!.id).toBe(id);
    expect(original!.state).toBe('failed');
    expect(original!.retry_count).toBe(3);
    expect(JSON.stringify(original!.output)).toContain('receiver answered 503');

    // The dead-lettered copy is a new job carrying the payload and where it came from.
    expect(dead.data).toEqual(payload);
    expect(dead.state).toBe('created');
    const { rows } = await pool.query<{
      source_name: string;
      source_id: string;
      source_retry_count: number;
      source_output: unknown;
      keep_until: Date;
      deletion_seconds: number;
    }>(
      `SELECT source_name, source_id, source_retry_count, source_output, keep_until, deletion_seconds
         FROM pgboss.job WHERE id = $1`,
      [dead.id],
    );
    expect(rows[0]!.source_name).toBe(QUEUE);
    expect(rows[0]!.source_id).toBe(id);
    expect(rows[0]!.source_retry_count).toBe(3);
    expect(JSON.stringify(rows[0]!.source_output)).toContain('receiver answered 503');

    // "Dead-letter until handled": the copy is kept for the DLQ queue's own retentionSeconds,
    // not the 14-day default, and for 30 days once handled.
    const keptDays = (rows[0]!.keep_until.getTime() - Date.now()) / 86_400_000;
    expect(keptDays).toBeGreaterThan(5 * 365 - 2);
    expect(rows[0]!.deletion_seconds).toBe(30 * 24 * 3600);

    recordResult('scenario-3', {
      attempts: ATTEMPTS.length,
      retryGapsMs: gapsMs,
      totalMsToDeadLetter: Date.now() - sentAt,
      sourceRetryCount: rows[0]!.source_retry_count,
      deadLetterKeptDays: Math.round(keptDays),
    });
  });

  it('a dead-lettered job can be redriven to its source queue and succeed', async () => {
    // Fix the "receiver": a handler that now succeeds. The failing worker is replaced.
    await boss.offWork(QUEUE);
    const handled: unknown[] = [];
    await boss.work(QUEUE, { pollingIntervalSeconds: 0.5 }, async (jobs) => {
      handled.push(...jobs.map((j) => j.data));
      return undefined;
    });

    const result = await boss.redrive(DLQ);
    expect(result).toBeDefined();
    await waitFor(() => handled.length === 1 || undefined, 'the redriven job to be handled', {
      timeoutMs: 20_000,
    });
    expect(handled[0]).toEqual({
      url: 'https://hooks.example.test/x',
      body: { event: 'order.paid' },
    });
    const dlq = await jobRows(pool, DLQ);
    expect(
      dlq.every((j) => j.state !== 'created'),
      'redrive left the job in the DLQ',
    ).toBe(true);
  });

  it('pg-boss emitted no errors', () => {
    expect(boss.errors).toEqual([]);
  });
});
