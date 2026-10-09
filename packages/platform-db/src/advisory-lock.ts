import type { Pool } from 'pg';
import { classifyDatabaseError } from './errors';
import { targetOf } from './pool';

export type AdvisoryLockResult<T> = { acquired: true; value: T } | { acquired: false };

/**
 * Run `fn` only if no other session holds the advisory lock named `key`; otherwise do nothing.
 *
 * This is the Postgres leader lock: `pg_try_advisory_lock`, never the blocking variant, so
 * a caller that loses simply skips its tick. It is how a scheduled job runs once per tick
 * across replicas when there is no cache to take a lock in.
 *
 * - The lock is SESSION-scoped, so it is held on one pooled client for the whole of `fn`.
 *   That client is unavailable to the rest of the pool meanwhile; with `DB_POOL_MAX=1` the
 *   body of `fn` could never query. Keep `DB_POOL_MAX` at 2 or more where this is used.
 * - A crash, a killed pod or a dropped connection releases the lock on the server. There is
 *   no TTL to tune and nothing to expire; the job is also free of the "lock outlived the
 *   run" window a TTL lock has.
 * - If releasing fails the connection is destroyed rather than returned to the pool, because
 *   a pooled client that still holds the lock would block that key until the process dies.
 * - `key` is hashed to the 64-bit key space on the server (`hashtextextended`). Distinct
 *   names can in theory collide; a collision only makes two jobs exclude each other.
 *
 * The pool must come from `createPool()`: its clients carry the permanent 'error' listener that
 * keeps a dropped connection from becoming an uncaught exception.
 *
 * Errors thrown by `fn` propagate unchanged. A failure to obtain a connection or to run the
 * lock query rejects with a `DatabaseConnectionError` before `fn` has started.
 */
export async function withAdvisoryLock<T>(
  pool: Pool,
  key: string,
  fn: () => Promise<T>,
): Promise<AdvisoryLockResult<T>> {
  let client;
  let acquired = false;
  // If the backend dies mid-run (a failover, a killed connection) the client's 'error' event is
  // already handled by the permanent listener `createPool` puts on every client, so it cannot
  // take the process down. The lock is gone with the session anyway; `fn` is already running
  // and finishes or fails on its own, and the release below finds the connection dead and
  // destroys it.
  try {
    client = await pool.connect();
    const { rows } = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked',
      [key],
    );
    acquired = rows[0]?.locked === true;
  } catch (err) {
    client?.release(true);
    throw classifyDatabaseError(err, targetOf(pool));
  }

  if (!acquired) {
    client.release();
    return { acquired: false };
  }

  let destroy = false;
  try {
    return { acquired: true, value: await fn() };
  } finally {
    try {
      const { rows } = await client.query<{ unlocked: boolean }>(
        'SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked',
        [key],
      );
      destroy = rows[0]?.unlocked !== true;
    } catch {
      destroy = true;
    }
    client.release(destroy);
  }
}
