/**
 * Connection schema contract — owned by @qnsc-vn/identity so every consuming app
 * keeps the same `sso_connections` shape (no per-app drift). Apps run
 * {@link assertConnectionContract} against their real DB in an e2e; the package
 * is the single source of truth for the broker columns + routing table.
 */

/** Minimal shape of an `information_schema.columns` row we care about. */
export interface DbColumn {
  column_name: string;
  data_type?: string;
  is_nullable?: 'YES' | 'NO';
}

/** Broker columns every app's `identity.sso_connections` MUST have (beyond the base ones). */
export const SSO_CONNECTION_BROKER_COLUMNS = [
  'kind',
  'authority_url',
  'jwks_uri',
  'accepted_issuers',
  'scopes',
  'client_id',
  'client_secret_ref',
  'display_name',
] as const;

/** The normalized owned-domain routing table + its required columns. */
export const SSO_CONNECTION_DOMAINS_TABLE = 'sso_connection_domains';
export const SSO_CONNECTION_DOMAINS_COLUMNS = ['connection_id', 'domain'] as const;

/** Fetch the columns of one table (e.g. from `information_schema.columns`). */
export type ColumnFetcher = (table: string) => Promise<DbColumn[]>;

/**
 * Assert the consuming app's schema satisfies the broker contract. Throws an
 * Error naming every missing column. Intended for an app-side e2e against the
 * real database, so a schema drift fails CI rather than production login.
 */
export async function assertConnectionContract(fetchColumns: ColumnFetcher): Promise<void> {
  const connectionCols = new Set((await fetchColumns('sso_connections')).map((c) => c.column_name));
  const missingConn = SSO_CONNECTION_BROKER_COLUMNS.filter((c) => !connectionCols.has(c));
  if (missingConn.length > 0) {
    throw new Error(`sso_connections is missing broker columns: ${missingConn.join(', ')}`);
  }

  const domainCols = new Set(
    (await fetchColumns(SSO_CONNECTION_DOMAINS_TABLE)).map((c) => c.column_name),
  );
  const missingDomain = SSO_CONNECTION_DOMAINS_COLUMNS.filter((c) => !domainCols.has(c));
  if (missingDomain.length > 0) {
    throw new Error(
      `${SSO_CONNECTION_DOMAINS_TABLE} is missing columns: ${missingDomain.join(', ')}`,
    );
  }
}
