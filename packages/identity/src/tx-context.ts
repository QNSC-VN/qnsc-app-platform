import { AsyncLocalStorage } from 'node:async_hooks';
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
 * `db`, behaving identically, except that `transaction()` publishes its transaction through
 * {@link currentAuthTransaction} while the callback runs.
 */
export function withTxCapture<T extends object>(db: T): T {
  return new Proxy(db, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (prop === 'transaction') {
        return (cb: (tx: never) => Promise<unknown>, config?: unknown) =>
          (target as unknown as Transactional).transaction(
            (tx) => store.run(tx as unknown as DbExecutor, () => cb(tx)),
            config,
          );
      }
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}
