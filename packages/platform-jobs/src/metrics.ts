import { getMeter, QueueMetrics } from '@quynhonsemiconductor/observability';
import type { Pool } from 'pg';

/** The gauge name sits next to pg-boss's own `pgboss.queue.jobs`. */
export const OLDEST_READY_AGE_METRIC = 'pgboss.queue.oldest_ready_age';

/** Do not query more often than this, however often the metrics are collected. */
const CACHE_MS = 10_000;

/**
 * The age, in seconds, of the oldest job that is READY to run, per queue (queues with nothing
 * ready are absent). Without `persistQueueStats` pg-boss cannot tell us this (F9).
 *
 * `state < 'active' AND NOT blocked AND start_after <= now()` is exactly pg-boss's own partial
 * index (`job_common_i11`): an index-only scan, 0.09 ms on a million completed rows. Leaving out
 * `NOT blocked` turns it into a 35 ms sequential scan.
 */
export async function readOldestReadyAge(
  pool: Pool,
  queues: readonly string[],
): Promise<Map<string, number>> {
  if (queues.length === 0) return new Map();
  const { rows } = await pool.query<{ name: string; age: string }>(
    `SELECT name, extract(epoch FROM now() - min(start_after)) AS age
       FROM pgboss.job
      WHERE name = ANY($1::text[])
        AND state < 'active'
        AND NOT blocked
        AND start_after <= now()
      GROUP BY name`,
    [queues],
  );
  return new Map(rows.map((row) => [row.name, Math.max(0, Number(row.age))]));
}

/**
 * Register the oldest-ready-age observable gauge. Pull-based: OpenTelemetry reads it on each
 * collection, so there is no timer here. A failing query reports nothing for that collection
 * instead of throwing into the metrics pipeline (a metric must never take the job runner down).
 */
export function registerOldestReadyAge(
  pool: Pool,
  queues: () => readonly string[],
  onError: (error: unknown) => void,
  queueMetrics: QueueMetrics = new QueueMetrics(),
): void {
  let cached: { at: number; ages: Map<string, number> } | undefined;

  const gauge = getMeter().createObservableGauge(OLDEST_READY_AGE_METRIC, {
    description: 'Age of the oldest job that is ready to run, per queue',
    unit: 's',
  });
  gauge.addCallback(async (result) => {
    try {
      const now = Date.now();
      if (!cached || now - cached.at > CACHE_MS) {
        cached = { at: now, ages: await readOldestReadyAge(pool, queues()) };
        // The platform contract's `queue.lag_seconds`: the age of the oldest READY job. Recorded
        // when it is read, which is at most every 10 s, so the series is not flooded.
        for (const queue of queues()) queueMetrics.recordLag(queue, cached.ages.get(queue) ?? 0);
      }
      const known = new Set(queues());
      for (const queue of known) {
        // A queue with nothing ready is reported as 0, not absent: an alert on "age > N" must be
        // able to see that the backlog drained.
        result.observe(cached.ages.get(queue) ?? 0, { queue });
      }
    } catch (error) {
      onError(error);
    }
  });
}
