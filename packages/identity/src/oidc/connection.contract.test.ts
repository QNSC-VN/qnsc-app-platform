import { describe, it, expect } from 'vitest';
import {
  assertConnectionContract,
  SSO_CONNECTION_BROKER_COLUMNS,
  SSO_CONNECTION_DOMAINS_COLUMNS,
  type DbColumn,
} from './connection.contract';

const cols = (names: readonly string[]): DbColumn[] => names.map((column_name) => ({ column_name }));

/** A fetcher backed by a table→columns map. */
function fetcher(map: Record<string, readonly string[]>) {
  return (table: string) => Promise.resolve(cols(map[table] ?? []));
}

describe('assertConnectionContract', () => {
  it('passes when all broker columns + domain table columns are present', async () => {
    const run = fetcher({
      sso_connections: [...SSO_CONNECTION_BROKER_COLUMNS, 'id', 'workspace_id'],
      sso_connection_domains: [...SSO_CONNECTION_DOMAINS_COLUMNS, 'id'],
    });
    await expect(assertConnectionContract(run)).resolves.toBeUndefined();
  });

  it('throws naming a missing sso_connections broker column', async () => {
    const run = fetcher({
      sso_connections: SSO_CONNECTION_BROKER_COLUMNS.filter((c) => c !== 'client_secret_ref'),
      sso_connection_domains: [...SSO_CONNECTION_DOMAINS_COLUMNS],
    });
    await expect(assertConnectionContract(run)).rejects.toThrow(/client_secret_ref/);
  });

  it('throws when the domain routing table is missing a column', async () => {
    const run = fetcher({
      sso_connections: [...SSO_CONNECTION_BROKER_COLUMNS],
      sso_connection_domains: ['id'], // no connection_id / domain
    });
    await expect(assertConnectionContract(run)).rejects.toThrow(/sso_connection_domains/);
  });
});
