import { afterAll, beforeAll, beforeEach, describe, expect, expectTypeOf, it } from 'vitest';
import {
  dockerTestsEnabled,
  startPostgres,
  type PostgresHarness,
} from '@quynhonsemiconductor/testing';
import { eq, sql } from 'drizzle-orm';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import type { Pool } from 'pg';
import { createPool, createReadPool } from '../pool';
import {
  createDatabase,
  withTransaction,
  type Database,
  type DbExecutor,
  type ReplicatedDatabase,
  type Transaction,
} from './index';

const accounts = pgTable('accounts', {
  id: integer('id').primaryKey(),
  owner: text('owner').notNull(),
});
const schema = { accounts };
type Schema = typeof schema;

const enabled = await dockerTestsEnabled();
const quiet = { warn: () => undefined, error: () => undefined };

describe.skipIf(!enabled)('platform-db/drizzle', () => {
  let pg: PostgresHarness;
  let pool: Pool;
  let db: Database<Schema>;

  beforeAll(async () => {
    pg = await startPostgres({ tls: true });
    pool = createPool(pg.env(), { logger: quiet });
    db = createDatabase(pool, { schema });
    await pool.query('CREATE TABLE accounts (id integer PRIMARY KEY, owner text NOT NULL)');
  }, 180_000);
  afterAll(async () => {
    await pool?.end();
    await pg?.stop();
  }, 60_000);
  beforeEach(() => pg.truncate());

  const owners = async (executor: DbExecutor<Schema> = db) =>
    (await executor.select().from(accounts).orderBy(accounts.id)).map((r) => r.owner);

  describe('withTransaction', () => {
    it('commits when the body resolves, and returns its value', async () => {
      const result = await withTransaction(db, async (tx) => {
        await tx.insert(accounts).values({ id: 1, owner: 'ada' });
        return 'done';
      });
      expect(result).toBe('done');
      expect(await owners()).toEqual(['ada']);
    });

    it('rolls back every write when the body throws, and rethrows that error', async () => {
      const boom = new Error('business rule failed');
      await expect(
        withTransaction(db, async (tx) => {
          await tx.insert(accounts).values({ id: 1, owner: 'ada' });
          await tx.insert(accounts).values({ id: 2, owner: 'grace' });
          throw boom;
        }),
      ).rejects.toBe(boom);

      expect(await owners(), 'a failed transaction left rows behind').toEqual([]);
    });

    it('rolls back when a statement fails mid-way (a constraint violation)', async () => {
      await db.insert(accounts).values({ id: 1, owner: 'ada' });
      await expect(
        withTransaction(db, async (tx) => {
          await tx.insert(accounts).values({ id: 2, owner: 'grace' });
          await tx.insert(accounts).values({ id: 1, owner: 'duplicate' });
        }),
      ).rejects.toThrow();
      expect(await owners()).toEqual(['ada']);
    });

    it('does not make the write visible to others before commit', async () => {
      let seenInside: string[] | undefined;
      await withTransaction(db, async (tx) => {
        await tx.insert(accounts).values({ id: 1, owner: 'ada' });
        seenInside = await owners(); // the root connection, a different session
        expect(await owners(tx)).toEqual(['ada']);
      });
      expect(seenInside).toEqual([]);
    });

    it('JOINS an open transaction: the inner work lives or dies with the outer one', async () => {
      const boom = new Error('outer failed after inner succeeded');
      await expect(
        withTransaction(db, async (outer) => {
          await outer.insert(accounts).values({ id: 1, owner: 'outer' });
          await withTransaction(outer, async (inner) => {
            expect(inner).toBe(outer); // same transaction, no savepoint
            await inner.insert(accounts).values({ id: 2, owner: 'inner' });
          });
          throw boom;
        }),
      ).rejects.toBe(boom);

      expect(await owners(), 'the inner write survived the outer rollback').toEqual([]);
    });

    it('commits inner and outer together when nothing fails', async () => {
      await withTransaction(db, async (outer) => {
        await outer.insert(accounts).values({ id: 1, owner: 'outer' });
        await withTransaction(outer, (inner) =>
          inner.insert(accounts).values({ id: 2, owner: 'inner' }),
        );
      });
      expect(await owners()).toEqual(['outer', 'inner']);
    });

    it('refuses a transaction config while joining, instead of silently ignoring it', async () => {
      await expect(
        withTransaction(db, (outer) =>
          withTransaction(outer, () => Promise.resolve(), { isolationLevel: 'serializable' }),
        ),
      ).rejects.toThrow(/already open/);
    });

    it('applies the isolation level when it opens the transaction', async () => {
      const level = await withTransaction(
        db,
        async (tx) => {
          const { rows } = await tx.execute<{ transaction_isolation: string }>(
            sql`SHOW transaction_isolation`,
          );
          return rows[0]!.transaction_isolation;
        },
        { isolationLevel: 'serializable' },
      );
      expect(level).toBe('serializable');
    });

    it('accepts either the root database or a transaction wherever a DbExecutor is expected', async () => {
      const save = (owner: string, id: number, executor: DbExecutor<Schema> = db) =>
        executor.insert(accounts).values({ id, owner });

      await save('direct', 1);
      await withTransaction(db, (tx) => save('enlisted', 2, tx));
      expect(await owners()).toEqual(['direct', 'enlisted']);

      expectTypeOf(db).toExtend<DbExecutor<Schema>>();
      expectTypeOf<Transaction<Schema>>().toExtend<DbExecutor<Schema>>();
    });
  });

  describe('the backend dies under a running transaction (failover, node drain, CNPG switchover)', () => {
    /**
     * pg-pool removes its own error listener when it hands a client out, and Drizzle's
     * transaction() adds none. So when the server terminates the transaction's backend, the
     * client's 'error' event (57P01 "terminating connection due to administrator command")
     * had no listener at all and Node treated it as an uncaught exception: one dropped
     * connection restarted the whole process.
     */
    it('rejects the transaction, raises NO uncaught exception, and the pool keeps serving', async () => {
      const uncaught: unknown[] = [];
      const onUncaught = (err: unknown) => uncaught.push(err);
      process.on('uncaughtException', onUncaught);
      const killer = pg.createPool({ max: 1 });
      try {
        const result = withTransaction(db, async (tx) => {
          await tx.insert(accounts).values({ id: 1, owner: 'doomed' });
          const { rows } = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
          // Kill the transaction's OWN backend, as a failover would.
          await killer.query('SELECT pg_terminate_backend($1)', [rows[0]!.pid]);
          await new Promise((resolve) => setTimeout(resolve, 300));
          await tx.insert(accounts).values({ id: 2, owner: 'never' });
        });

        await expect(result).rejects.toThrow();
        // Give an unhandled 'error' event the chance to surface: it is emitted asynchronously.
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(uncaught, 'a dropped connection raised an uncaught exception').toEqual([]);

        // The dead client is discarded and the pool serves the next query.
        const { rows } = await pool.query<{ ok: number }>('SELECT 1 AS ok');
        expect(rows[0]!.ok).toBe(1);
        expect(await owners(), 'the killed transaction left rows behind').toEqual([]);
      } finally {
        process.off('uncaughtException', onUncaught);
      }
    });
  });

  describe('read replica slot', () => {
    it('is the plain primary database when no read pool exists', () => {
      expect('$primary' in db).toBe(false);
    });

    it('routes reads to the read pool, and writes and transactions to the primary', async () => {
      const read = createReadPool({ ...pg.env(), DATABASE_READ_HOST: pg.host }, { logger: quiet })!;
      const replicated = createDatabase(pool, { schema, readPool: read });
      try {
        // Distinguishable by pool: only the read pool should have opened a connection for a read.
        expect(read.totalCount).toBe(0);
        await replicated.insert(accounts).values({ id: 1, owner: 'ada' });
        await replicated.select().from(accounts).where(eq(accounts.id, 1));
        expect(read.totalCount, 'a plain read did not go to the replica').toBe(1);

        const before = read.totalCount;
        await withTransaction(replicated, (tx) =>
          tx.insert(accounts).values({ id: 2, owner: 'grace' }),
        );
        expect(read.totalCount, 'a transaction went to the replica').toBe(before);

        // `$primary` is how a caller reads its own write.
        expect(await replicated.$primary.select().from(accounts)).toHaveLength(2);
      } finally {
        await read.end();
      }
    });
  });
});

/**
 * COMPILE-TIME CONTRACT. `platform-jobs` and `identity` v8 accept the bare `DbExecutor` (no
 * schema argument) and are handed a product's database or transaction, whose schema is the
 * product's own. If these stop being assignable, those packages cannot take a `tx` and the whole
 * point of the shared transaction contract is lost. `pnpm typecheck` compiles this file
 * (tsconfig.test.json); vitest only strips types and would never notice.
 */
describe('DbExecutor type contract', () => {
  it('a real-schema database and transaction are assignable to the bare DbExecutor', () => {
    expectTypeOf<Database<Schema>>().toExtend<DbExecutor>();
    expectTypeOf<Transaction<Schema>>().toExtend<DbExecutor>();
    expectTypeOf<ReplicatedDatabase<Schema>>().toExtend<DbExecutor>();

    // The shape a consumer actually writes:
    const takesBare = (executor: DbExecutor): DbExecutor => executor;
    const fromDb = (db: Database<Schema>) => takesBare(db);
    const fromTx = (tx: Transaction<Schema>) => takesBare(tx);
    expect([fromDb, fromTx]).toHaveLength(2);

    // and withTransaction hands the callback something the bare type accepts
    const inTx = (db: Database<Schema>) =>
      withTransaction(db, (tx) => Promise.resolve(takesBare(tx)));
    expect(inTx).toBeTypeOf('function');
  });

  it('$primary is in the return type exactly when a read pool is given', () => {
    const pool = {} as Pool;
    const withRead = createDatabase(pool, { schema, readPool: pool });
    const without = createDatabase(pool, { schema });
    expectTypeOf(withRead).toHaveProperty('$primary');
    expectTypeOf(without).not.toHaveProperty('$primary');
    expectTypeOf(withRead.$primary).toExtend<DbExecutor<Schema>>();
  });
});
