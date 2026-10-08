import type { Pool } from 'pg';
import { classifyDatabaseError } from './errors';
import { targetOf } from './pool';

/**
 * Check the database can serve a query, for `/readyz`.
 *
 * Resolves on success. On failure it rejects with a `DatabaseConnectionError` whose `code`
 * and message name the cause (wrong password, CA mismatch, connection limit, unreachable…),
 * so a failing readiness probe says why in the log instead of a bare `28P01`.
 *
 * It does not enforce a deadline of its own beyond the pool's `DB_POOL_CONNECT_TIMEOUT_MS`;
 * the readiness endpoint wraps every check in one.
 */
export async function pingDatabase(pool: Pool): Promise<void> {
  try {
    await pool.query('SELECT 1');
  } catch (err) {
    throw classifyDatabaseError(err, targetOf(pool));
  }
}
