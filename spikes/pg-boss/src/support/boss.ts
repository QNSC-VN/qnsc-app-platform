import { PgBoss, type ConstructorOptions, type Db, type Queue } from 'pg-boss';
import type { Pool } from 'pg';

/**
 * pg-boss on top of a pool that `platform-db` built.
 *
 * pg-boss would happily open its own `pg.Pool` from host/user/password/ssl options. It is not
 * allowed to here, because that second pool would bypass what `platform-db` guarantees — verified
 * TLS against the cluster CA, the permanent per-client 'error' listener, the sized pool and the
 * named errors. `db` is pg-boss's documented seam for a caller-owned connection: it only needs
 * `executeSql`. The cost is two optional capabilities this adapter does not offer — LISTEN/NOTIFY
 * (`useListenNotify`) and pg-boss-owned transactions (`work(..., { transactional: true })`) —
 * neither of which the platform plan needs; see the ADR.
 */
export function poolDatabase(pool: Pool): Db {
  return {
    executeSql: (text, values) => pool.query(text, values as unknown[] | undefined),
  };
}

export interface CreateBossOptions extends Omit<ConstructorOptions, 'db'> {
  /** Called for every 'error' event pg-boss emits. Default: collect into {@link SpikeBoss.errors}. */
  onError?: (error: Error) => void;
}

export interface SpikeBoss extends PgBoss {
  /** Errors pg-boss emitted, so a test can assert none went unnoticed. */
  readonly errors: Error[];
}

export function createBoss(pool: Pool, options: CreateBossOptions = {}): SpikeBoss {
  const { onError, ...rest } = options;
  const boss = new PgBoss({ db: poolDatabase(pool), schema: 'pgboss', ...rest }) as SpikeBoss;
  const errors: Error[] = [];
  Object.defineProperty(boss, 'errors', { value: errors });
  boss.on('error', (error) => {
    errors.push(error);
    onError?.(error);
  });
  return boss;
}

/** `createQueue` is idempotent for an existing queue, so this can run on every start. */
export async function ensureQueues(
  boss: PgBoss,
  queues: readonly (Queue | string)[],
): Promise<void> {
  for (const queue of queues) {
    const { name, ...options } = typeof queue === 'string' ? { name: queue } : queue;
    await boss.createQueue(name, options);
  }
}
