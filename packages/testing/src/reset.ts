/**
 * The smallest surface the reset helpers need. `pg`'s `Client`/`Pool` and Drizzle's raw client
 * satisfy it, so this package imposes no driver on the caller.
 */
export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/** Double-quote an identifier, doubling embedded quotes. Never interpolate a name without it. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Return the database to an empty state: every non-system schema dropped (CASCADE) and `public`
 * recreated. Use between test FILES, or in `beforeAll`, when the next suite runs its own
 * migrations; it is the slow, total reset.
 */
export async function resetDatabase(db: Queryable): Promise<void> {
  const { rows } = await db.query(
    `SELECT nspname FROM pg_namespace
      WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'`,
  );
  for (const row of rows) {
    await db.query(`DROP SCHEMA IF EXISTS ${quoteIdent(String(row['nspname']))} CASCADE`);
  }
  await db.query('CREATE SCHEMA public');
}

export interface TruncateOptions {
  /** Schemas to clear. Default: `['public']`. */
  schemas?: string[];
  /** Fully unqualified table names to keep, e.g. a migrations journal. */
  except?: string[];
}

/**
 * Empty every table in the given schemas but keep the schema itself. Use between TESTS: it is
 * fast, resets identity sequences, and cascades through foreign keys.
 */
export async function truncateTables(db: Queryable, options: TruncateOptions = {}): Promise<void> {
  const schemas = options.schemas ?? ['public'];
  const except = new Set(options.except ?? []);
  const { rows } = await db.query(
    'SELECT schemaname, tablename FROM pg_tables WHERE schemaname = ANY($1::text[])',
    [schemas],
  );
  const targets = rows
    .filter((row) => !except.has(String(row['tablename'])))
    .map(
      (row) => `${quoteIdent(String(row['schemaname']))}.${quoteIdent(String(row['tablename']))}`,
    );
  if (targets.length === 0) return;
  await db.query(`TRUNCATE ${targets.join(', ')} RESTART IDENTITY CASCADE`);
}
