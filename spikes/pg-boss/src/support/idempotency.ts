import { createHash } from 'node:crypto';
import type { Pool } from 'pg';

/** RFC 9562 namespace for this spike's idempotency keys. A fixed constant, not a secret. */
const NAMESPACE = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex'); // the DNS namespace

/**
 * A deterministic UUID (version 5) for an idempotency key.
 *
 * pg-boss lets the caller choose a job's `id`, and `id` is the table's primary key: a second
 * `send` with the same id inserts nothing and returns `null`. So mapping `idempotencyKey` to a
 * UUID makes "duplicate key ⇒ one job" a database constraint that holds for as long as the job
 * row exists (queued, active, and until retention deletes it) — see the scenario that measures
 * the alternatives.
 */
export function idempotencyId(queue: string, key: string): string {
  const hash = createHash('sha1').update(NAMESPACE).update(`${queue}\u0000${key}`).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The HANDLER half of idempotency, for at-least-once delivery: run `effect` at most once per
 * `key`, however many times the job is delivered.
 *
 * The marker row and the effect's own writes share one transaction, so a crash between them
 * cannot leave the effect done and unmarked. An effect that leaves the database (an email, an
 * HTTP call) cannot be made atomic with the marker; for those the provider's own idempotency key
 * must be the `key`, and this helper only narrows the window. Returns whether `effect` ran.
 */
export async function runOnce(
  pool: Pool,
  key: string,
  effect: (query: Pool['query']) => Promise<void>,
): Promise<'ran' | 'skipped'> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const claimed = await client.query(
      'INSERT INTO job_effects (key) VALUES ($1) ON CONFLICT (key) DO NOTHING RETURNING key',
      [key],
    );
    if (claimed.rowCount === 0) {
      await client.query('ROLLBACK');
      return 'skipped';
    }
    await effect(client.query.bind(client) as Pool['query']);
    await client.query('COMMIT');
    return 'ran';
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export const JOB_EFFECTS_DDL = `CREATE TABLE IF NOT EXISTS job_effects (
  key text PRIMARY KEY,
  done_at timestamptz NOT NULL DEFAULT now()
)`;
