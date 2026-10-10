import { PgBoss } from 'pg-boss';
import type { Pool, PoolClient } from 'pg';

/** Double-quote an identifier, doubling embedded quotes. Never interpolate a role name without it. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Our own table in the `pgboss` schema, for `jobs.once`: one row per effect that has run. It lives
 * with the queue tables because that is the one schema this package owns (P6): the product's
 * schema never gets a table from a package.
 */
export const EFFECT_TABLE = 'pgboss.platform_effect';

const EFFECT_DDL = `
CREATE TABLE IF NOT EXISTS ${EFFECT_TABLE} (
  key text PRIMARY KEY,
  done_at timestamptz NOT NULL DEFAULT now()
)`;
const EFFECT_INDEX_DDL = `CREATE INDEX IF NOT EXISTS platform_effect_done_at_idx ON ${EFFECT_TABLE} (done_at)`;

/**
 * The grants the application role needs, and all it needs (ADR 0001, F8). `migrator` owns the
 * schema, so `ALTER DEFAULT PRIVILEGES FOR ROLE migrator` covers the tables and sequences a later
 * release adds.
 *
 * The application role can send, work, retry, dead-letter, schedule, supervise, monitor, redrive
 * and cancel with these alone. It cannot DROP, ALTER, TRUNCATE or CREATE in the schema, and must
 * not need to: `partition: true` queues and `persistQueueStats` do need more, which is why this
 * package uses neither.
 */
export function jobsGrantsSql(appRole: string, migratorRole: string): string[] {
  const app = quoteIdent(appRole);
  const migrator = quoteIdent(migratorRole);
  return [
    `GRANT USAGE ON SCHEMA pgboss TO ${app}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO ${app}`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pgboss TO ${app}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} IN SCHEMA pgboss GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${app}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} IN SCHEMA pgboss GRANT USAGE, SELECT ON SEQUENCES TO ${app}`,
  ];
}

export interface InstallJobsSchemaOptions {
  /** The role the product's API and worker connect as. */
  appRole: string;
}

/**
 * Install or upgrade the `pgboss` schema, then grant the application role what it needs. Run it
 * from the MIGRATION Job, with the MIGRATOR role's pool (`createMigratorPool()`); it is
 * idempotent, and safe to run on every release.
 *
 * It uses pg-boss's own install path (`migrate: true, createSchema: true`), which runs exactly the
 * SQL the version in this package ships; no supervisor, no schedule and no queue is started. The
 * whole install (pg-boss's schema, our effect table, the grants) runs under ONE advisory lock on
 * ONE session, so concurrent runs are serialised. The application role never gets to run this: it has no
 * `CREATE` on the schema, and `start()` as that role rejects against an older schema instead.
 */
export async function installJobsSchema(
  migratorPool: Pool,
  options: InstallJobsSchemaOptions,
): Promise<void> {
  // One session for the whole install, holding an advisory lock: two Jobs started together (a
  // rolling migration, a retried Job) install ONE AT A TIME, so the second finds a finished schema
  // instead of racing the first through the table DDL and the grants.
  const client = await migratorPool.connect();
  // If the unlock fails the session may still HOLD the lock, and a pooled connection that holds an
  // advisory lock would block every later install until the process dies. Release it with the error
  // so the pool destroys the connection (which frees the lock) instead of reusing it.
  let broken: Error | undefined;
  try {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [INSTALL_LOCK]);
    try {
      await install(client, options);
    } finally {
      await client
        .query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [INSTALL_LOCK])
        .catch((error: unknown) => {
          broken = error instanceof Error ? error : new Error(String(error));
        });
    }
  } finally {
    client.release(broken);
  }
}

const INSTALL_LOCK = '@quynhonsemiconductor/platform-jobs:install';

async function install(client: PoolClient, options: InstallJobsSchemaOptions): Promise<void> {
  const { rows } = await client.query<{ me: string }>('SELECT current_user AS me');
  const migrator = rows[0]!.me;
  if (migrator === options.appRole) {
    throw new Error(
      `installJobsSchema must run as the migrator role, not as the application role "${options.appRole}": ` +
        'the application role must never own the pgboss schema.',
    );
  }

  const boss = new PgBoss({
    db: { executeSql: (text: string, values?: unknown[]) => client.query(text, values) },
    schema: 'pgboss',
    migrate: true,
    createSchema: true,
    supervise: false,
    schedule: false,
    persistQueueStats: false,
    registerInstance: false,
  });
  boss.on('error', () => undefined);
  await boss.start();
  await boss.stop({ graceful: true, close: false, timeout: 5_000 });

  await client.query(EFFECT_DDL);
  await client.query(EFFECT_INDEX_DDL);
  for (const statement of jobsGrantsSql(options.appRole, migrator)) {
    await client.query(statement);
  }
}
