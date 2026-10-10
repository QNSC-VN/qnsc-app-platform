import { AsyncLocalStorage } from 'node:async_hooks';
import { sql } from 'drizzle-orm';
import type { DbExecutor } from '@quynhonsemiconductor/platform-db/drizzle';

/**
 * The Drizzle transaction Better Auth currently has open, if any.
 *
 * Better Auth's Drizzle adapter, with `transaction: true`, calls `db.transaction(cb)` itself and
 * hands the transaction only to its own adapter — a callback such as `sendVerificationEmail`
 * receives no handle to it. Wrapping the `db` given to the adapter (see {@link withTxCapture})
 * records the transaction in AsyncLocalStorage for the duration of `cb`, so a callback can enqueue
 * its job through the SAME transaction (`jobs.send(…, { tx })`) and inherit commit/rollback.
 */
const store = new AsyncLocalStorage<DbExecutor>();

/** The transaction Better Auth has open around the current call, or `undefined` outside one. */
export function currentAuthTransaction(): DbExecutor | undefined {
  return store.getStore();
}

type Transactional = {
  transaction: (cb: (tx: never) => Promise<unknown>, config?: unknown) => Promise<unknown>;
};

/**
 * The transaction Better Auth opened is no longer usable: a statement inside it failed and the
 * failure was swallowed (Better Auth swallows what a callback such as `sendVerificationEmail`
 * throws), so the `COMMIT` that follows would be a silent `ROLLBACK`. Thrown instead of that, so
 * the request fails: nothing was written, and nothing may say it was.
 */
export class AuthTransactionAbortedError extends Error {
  override readonly name = 'AuthTransactionAbortedError';
  constructor(options?: { cause?: unknown }) {
    super('the authentication transaction was aborted and cannot commit', options);
  }
}

/**
 * `db`, behaving identically, except that `transaction()` publishes its transaction through
 * {@link currentAuthTransaction} while the callback runs, and refuses to "commit" one that
 * PostgreSQL has already aborted.
 *
 * Inside a transaction an SQL error aborts it: every later statement fails with 25P02 and `COMMIT`
 * answers `ROLLBACK` without an error, so Drizzle returns normally and Better Auth answers 200 for
 * a user that was never written (identity#191). After the callback, a trivial statement tells the
 * two states apart; on an aborted transaction it fails, and that failure is thrown, which rolls
 * back and reaches the caller as an error.
 */
export function withTxCapture<T extends object>(db: T): T {
  return new Proxy(db, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (prop === 'transaction') {
        return (cb: (tx: never) => Promise<unknown>, config?: unknown) =>
          (target as unknown as Transactional).transaction(async (tx) => {
            const executor = tx as unknown as DbExecutor;
            const result = await store.run(executor, () => cb(tx));
            try {
              await executor.execute(sql`select 1`);
            } catch (cause) {
              throw new AuthTransactionAbortedError({ cause });
            }
            return result;
          }, config);
      }
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}
