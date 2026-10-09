import {
  createDatabase,
  withTransaction,
  type Database,
  type DbExecutor,
} from '@quynhonsemiconductor/platform-db/drizzle';
import { sql } from 'drizzle-orm';
import { integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { fromDrizzle, type PgBoss, type SendOptions } from 'pg-boss';
import type { Pool } from 'pg';

/** A stand-in for a product table: an order, whose confirmation email must follow the commit. */
export const orders = pgTable('orders', {
  id: integer('id').primaryKey(),
  customer: text('customer').notNull(),
  placedAt: timestamp('placed_at').defaultNow().notNull(),
});

export const schema = { orders };
export type Schema = typeof schema;
export type AppDb = Database<Schema>;
export type AppExecutor = DbExecutor<Schema>;

export async function createAppDb(pool: Pool): Promise<AppDb> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS orders (
       id integer PRIMARY KEY,
       customer text NOT NULL,
       placed_at timestamp NOT NULL DEFAULT now()
     )`,
  );
  return createDatabase(pool, { schema });
}

export { sql, uuid, withTransaction };

/**
 * The prototype of `jobs.send(queue, data, { tx })` from APP-PLATFORM-PLAN §6.7: a transactional
 * enqueue that takes platform-db's `DbExecutor` — the root database or an open Drizzle
 * transaction — and writes the job through it.
 *
 * pg-boss ships the adapter (`fromDrizzle`), which runs pg-boss's SQL through `tx.execute(sql…)`
 * with every value a bind parameter. Nothing here reaches into Drizzle internals.
 */
export function send(
  boss: PgBoss,
  queue: string,
  data: object,
  options: Omit<SendOptions, 'db'> & { tx?: AppExecutor } = {},
): Promise<string | null> {
  const { tx, ...rest } = options;
  return boss.send(queue, data, tx ? { ...rest, db: fromDrizzle(tx, sql) } : rest);
}
