import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { withReplicas, type PgTransactionConfig } from 'drizzle-orm/pg-core';
import type { Pool } from 'pg';

/**
 * The Drizzle side of `platform-db`: the database instance and THE transaction contract.
 *
 * `DbExecutor` and `withTransaction` live here, not in the framework-agnostic entry point,
 * because a transaction object IS Drizzle's: `platform-jobs` (transactional enqueue) and
 * `identity` v8 both take a `DbExecutor` so their writes join the caller's transaction.
 */

/** A Drizzle database over the primary pool, with `$client` the pg `Pool`. */
export type Database<TSchema extends Record<string, unknown> = Record<string, never>> =
  NodePgDatabase<TSchema> & { $client: Pool };

/** The object Drizzle hands to a `db.transaction(async (tx) => …)` callback. */
export type Transaction<TSchema extends Record<string, unknown> = Record<string, never>> =
  Parameters<Parameters<NodePgDatabase<TSchema>['transaction']>[0]>[0];

/**
 * Either the root database or an open transaction — the type to accept wherever a function
 * may or may not be running inside a caller's transaction.
 *
 * ```ts
 * // A repository method enlists in the caller's transaction when given one:
 * async save(order: Order, db: DbExecutor<typeof schema> = this.db) {
 *   await db.insert(orders).values(order);
 * }
 *
 * // A job is enqueued in the SAME transaction as the business write: roll back ⇒ no job.
 * await withTransaction(db, async (tx) => {
 *   await orders.save(order, tx);
 *   await jobs.send('mail.send', message, { tx });
 * });
 * ```
 *
 * It names no Drizzle internals beyond the two types above, so it stays assignable even
 * when a consumer's tree holds a second copy of `drizzle-orm`.
 */
export type DbExecutor<TSchema extends Record<string, unknown> = Record<string, never>> =
  Database<TSchema> | Transaction<TSchema>;

export interface CreateDatabaseOptions<TSchema extends Record<string, unknown>> {
  schema: TSchema;
  /**
   * Read pool from `createReadPool()`. When present, reads are spread across it and writes and
   * transactions go to the primary (Drizzle `withReplicas`). Use `db.$primary` for a read that
   * must see your own write. Omit it until a replica exists.
   */
  readPool?: Pool | undefined;
}

/**
 * Build the Drizzle instance over a pool from `createPool()`.
 *
 * Returns the primary database, or — when `readPool` is given — one that routes reads to the
 * replica and exposes `$primary`.
 */
export function createDatabase<TSchema extends Record<string, unknown>>(
  pool: Pool,
  options: CreateDatabaseOptions<TSchema>,
): Database<TSchema> {
  const primary = drizzle(pool, { schema: options.schema }) as Database<TSchema>;
  if (!options.readPool) return primary;
  const replica = drizzle(options.readPool, { schema: options.schema }) as Database<TSchema>;
  return withReplicas(primary, [replica]) as unknown as Database<TSchema>;
}

/** A transaction is the only executor that can be rolled back from inside. */
function isTransaction(db: unknown): boolean {
  return typeof (db as { rollback?: unknown }).rollback === 'function';
}

/**
 * Run `fn` in a transaction: COMMIT when it resolves, ROLLBACK when it throws (and rethrow).
 *
 * - Given the ROOT database it opens a transaction.
 * - Given a TRANSACTION it JOINS it — `fn` runs in the caller's transaction with no savepoint
 *   and no commit of its own, so everything it wrote lives or dies with the outer one. This
 *   is what lets a service call `withTransaction` without knowing whether its caller already
 *   opened one.
 * - `config` (isolation level, access mode) can only be applied when opening. Passing it
 *   while joining throws, because silently running at a weaker isolation than asked for is
 *   a bug that never shows in a test.
 *
 * Never call an external provider (mail, HTTP, an LLM) inside `fn`: enqueue a job instead.
 */
export function withTransaction<TSchema extends Record<string, unknown>, T>(
  db: DbExecutor<TSchema>,
  fn: (tx: Transaction<TSchema>) => Promise<T>,
  config?: PgTransactionConfig,
): Promise<T> {
  if (isTransaction(db)) {
    if (config) {
      return Promise.reject(
        new Error(
          'withTransaction: a transaction config (isolation level, access mode) cannot be ' +
            'applied to a transaction that is already open. Set it where the outermost ' +
            'transaction starts.',
        ),
      );
    }
    return fn(db as Transaction<TSchema>);
  }
  return (db as Database<TSchema>).transaction(fn, config);
}
