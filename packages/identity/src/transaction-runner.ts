/**
 * Transaction-runner **port** for the identity bounded context.
 *
 * The shared auth logic performs multi-step writes (e.g. rotate refresh token +
 * stamp last-login) that must be atomic, but it must not depend on a concrete
 * ORM's transaction API. This port abstracts "run this callback inside one
 * transaction", threading the product's opaque transaction handle `Tx` through
 * to the repository ports (whose write methods accept the same `tx`).
 *
 * A product binds its ORM, e.g. a drizzle adapter:
 * `transaction: (fn) => this.db.transaction(fn)`.
 */

/** DI token for {@link ITransactionRunner}. */
export const TRANSACTION_RUNNER = Symbol('TRANSACTION_RUNNER');

/**
 * Runs a callback inside a single transaction and returns its result.
 *
 * @typeParam Tx - the product's transaction/executor handle, passed to the
 * callback and forwarded to transactional repository methods.
 */
export interface ITransactionRunner<Tx = unknown> {
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}
