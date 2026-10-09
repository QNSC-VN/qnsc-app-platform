import { createPool } from '@quynhonsemiconductor/platform-db';
import { startPostgres, type PostgresHarness } from '@quynhonsemiconductor/testing';
import type { Pool } from 'pg';

/**
 * The database every scenario runs against: PostgreSQL 18 serving TLS from a CA generated for
 * this run, reached through `platform-db`'s `createPool` — so every connection the spike makes,
 * pg-boss's included, is VERIFIED TLS with the same client code the products will use. The
 * Postgres role is a superuser here (the image's bootstrap user); the least-privilege probe
 * creates its own roles.
 */
export interface Cluster {
  readonly pg: PostgresHarness;
  /** `DATABASE_*` for a child process; `DATABASE_SSL_CA` is a path that lives until `stop()`. */
  readonly env: Record<string, string>;
  /** A pool built by platform-db's `createPool`, closed by `stop()`. */
  pool(max?: number): Pool;
  stop(): Promise<void>;
}

const quiet = { warn: () => undefined, error: () => undefined };

export async function startCluster(): Promise<Cluster> {
  const pg = await startPostgres({ tls: true });
  const env = { ...pg.env(), NODE_ENV: 'test' };
  const pools = new Set<Pool>();
  return {
    pg,
    env,
    pool(max = 10) {
      const pool = createPool({ ...env, DB_POOL_MAX: String(max) }, { logger: quiet });
      pools.add(pool);
      return pool;
    },
    async stop() {
      await Promise.allSettled([...pools].map((pool) => pool.end()));
      pools.clear();
      await pg.stop();
    },
  };
}
