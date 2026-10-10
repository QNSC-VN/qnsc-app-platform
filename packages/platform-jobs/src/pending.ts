import { getMeter } from '@quynhonsemiconductor/observability';
import type { Pool } from 'pg';

/** How often a worker looks for jobs that waited past `retention.pending`. */
export const PENDING_SWEEP_SECONDS = 60;

export const PENDING_DROPPED_METRIC = 'queue.pending_dropped';

/**
 * The key of the advisory lock pg-boss takes around its own `DELETE` of expired jobs
 * (`advisoryLockKey(schema, table + 'deletion')` in pg-boss's `plans.js`, for the `pgboss` schema and
 * the `job` table). Taking the same lock serialises this sweep with that deletion: two multi-row
 * `DELETE`s of the same rows, locking them in different orders, can deadlock.
 */
export const DELETION_LOCK_KEY_SQL =
  "('x' || encode(sha224((current_database() || '.pgboss.pgbossjobdeletion')::bytea), 'hex'))::bit(64)::bigint";

/** The deletion itself ($1: the queue names). See {@link sweepPending} for each clause. */
export const SWEEP_SQL = `WITH gone AS (
  DELETE FROM pgboss.job
   WHERE name = ANY($1::text[]) AND state < 'active' AND NOT blocked
     AND keep_until < pgboss.job_now()
   RETURNING name
)
SELECT name, count(*) AS n FROM gone GROUP BY name`;

/**
 * Delete, and COUNT, the jobs of `queues` that waited past their deadline without being processed.
 *
 * This is the SAME deletion pg-boss performs (`state < 'active' AND keep_until < job_now()`): a job
 * still waiting (`created`) or waiting to be retried (`retry`), at its own deadline, which a retry does
 * not extend. It never touches an `active` job, so a job being processed is safe however long it runs,
 * and a job that is fetched at the same instant is not deleted: Postgres re-checks the predicate on
 * the row's new version. pg-boss does it silently, every `maintenanceIntervalSeconds`, on any worker;
 * doing it here, at start and every minute and only for the queues that asked for `retention.pending`,
 * is what lets the loss be reported instead of discovered. Whoever deletes first wins; the other finds
 * nothing, so the count is a LOWER BOUND of what was dropped.
 *
 * - `pgboss.job_now()` is the clock pg-boss compares `keep_until` with (the test suite can move it).
 * - The transaction takes pg-boss's own `deletion` advisory lock first, as its maintenance does.
 * - `NOT blocked` lets the planner use pg-boss's partial index of waiting jobs
 *   (`state < 'active' AND NOT blocked`) instead of reading the table (106 ms over 1M rows
 *   became 2.9 ms). A `blocked` job (a flow dependency, which `platform-jobs` does not expose) is left
 *   to pg-boss.
 *
 * Returns the number deleted per queue.
 */
export async function sweepPending(
  pool: Pool,
  queues: readonly string[],
): Promise<Map<string, number>> {
  if (queues.length === 0) return new Map();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // As pg-boss's own transaction: never wait on a lock for long, never sit idle holding one.
    await client.query('SET LOCAL lock_timeout = 30000');
    await client.query('SET LOCAL idle_in_transaction_session_timeout = 30000');
    await client.query(`SELECT pg_advisory_xact_lock(${DELETION_LOCK_KEY_SQL})`);
    const { rows } = await client.query<{ name: string; n: string }>(SWEEP_SQL, [queues]);
    await client.query('COMMIT');
    return new Map(rows.map((row) => [row.name, Number(row.n)]));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** The counter. Label: the queue only, a fixed name, never a payload. */
export class PendingMetrics {
  private readonly dropped = getMeter().createCounter(PENDING_DROPPED_METRIC, {
    description: 'Jobs deleted unprocessed because they waited past retention.pending',
  });

  record(queue: string, count: number): void {
    try {
      this.dropped.add(count, { queue });
    } catch {
      // A metric must never take the job runner down.
    }
  }
}
