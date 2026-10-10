/**
 * Which of these (id, attempt) pairs still hold their claim: the job is ACTIVE and at that attempt.
 *
 * Parameters: `$1` queue, `$2` ids (`uuid[]`), `$3` attempts (`int[]`, parallel to `$2`).
 *
 * A join on the primary key `(name, id)`, one probe per pair: 16 buffers and 0.04 ms against a
 * 200,000-row table. The obvious `(id::text || ':' || retry_count::text) = ANY(...)` cannot use any
 * index and reads every queue's jobs (3,637 buffers, 7 ms) on every batch that has a failure.
 * `claims.test.ts` fails if this regresses to a scan.
 */
export const HELD_CLAIMS_SQL = `SELECT j.id FROM unnest($2::uuid[], $3::int[]) AS t(id, rc)
   JOIN pgboss.job j ON j.id = t.id AND j.retry_count = t.rc
  WHERE j.name = $1 AND j.state = 'active'`;
