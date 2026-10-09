import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CacheService } from '@quynhonsemiconductor/platform-cache';
import * as schema from '../src/db/schema';
import { createIdentity } from '../src/identity/create-identity';
import { strongPassword, uniqueEmail, verifiedUser } from './support/flows';
import { startStack, type Stack } from './support/stack';

/**
 * Criterion 6 — Drizzle schema generated and migrated; `uuidv7` IDs.
 *
 * The schema is `auth generate` (Better Auth CLI, Drizzle target) output -> src/db/schema.ts
 * (uuid columns, `identity` schema) -> `drizzle-kit generate` -> drizzle/0000_auth_tables.sql ->
 * applied by Drizzle's migrator in `startStack`. This file asserts what that produced.
 */
describe('C6 schema + uuidv7', () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack();
  });
  afterAll(async () => {
    await stack?.stop();
  });

  it('the migration created the auth tables in the product `identity` schema', async () => {
    const { rows } = await stack.pool.query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = 'identity' order by 1`,
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      'account',
      'invitation',
      'member',
      'organization',
      'session',
      'sso_provider',
      'user',
      'verification',
    ]);
    const journal = await stack.pool.query(
      `select count(*)::int as n from drizzle.__drizzle_migrations`,
    );
    expect(journal.rows[0].n).toBe(1);
  });

  it('every id column is a native uuid', async () => {
    const { rows } = await stack.pool.query<{ table_name: string; data_type: string }>(
      `select table_name, data_type from information_schema.columns
        where table_schema = 'identity' and column_name = 'id'`,
    );
    expect(rows).toHaveLength(8);
    for (const r of rows) expect(r.data_type, r.table_name).toBe('uuid');
  });

  it('rows Better Auth writes carry UUID version 7 ids (user, account, session, verification)', async () => {
    const email = uniqueEmail('v7');
    const c = await verifiedUser(stack, email, strongPassword());
    await c.post('/api/auth/request-password-reset', { email, redirectTo: '/r' });
    for (const table of ['user', 'account', 'session', 'verification']) {
      const { rows } = await stack.pool.query<{ version: string; n: number }>(
        `select substring(id::text from 15 for 1) as version, count(*)::int as n
           from identity."${table}" group by 1`,
      );
      expect(rows.length, table).toBeGreaterThan(0);
      for (const r of rows) expect(r.version, `${table} id version`).toBe('7');
    }
  });

  it('ids are time-ordered: sorting by id equals sorting by creation', async () => {
    for (let i = 0; i < 3; i += 1)
      await verifiedUser(stack, uniqueEmail(`ord${i}`), strongPassword());
    const { rows } = await stack.pool.query<{ by_id: string; by_time: string }>(
      `select (select string_agg(email, ',' order by id) from identity."user") as by_id,
              (select string_agg(email, ',' order by created_at, id) from identity."user") as by_time`,
    );
    expect(rows[0]!.by_id).toBe(rows[0]!.by_time);
  });

  it('Better Auth validates the Drizzle schema on first use and rejects every request while it is wrong', async () => {
    const { verification: _omit, ...withoutVerification } = schema;
    void _omit;
    const auth = createIdentity({
      product: 'spike',
      db: stack.db,
      schema: withoutVerification,
      cache: new CacheService({ mode: 'optional' }),
      baseURL: 'http://127.0.0.1',
      secret: 'x'.repeat(32),
      trustedOrigins: ['http://127.0.0.1'],
      presets: ['public'],
      email: { sendVerification: async () => undefined, sendPasswordReset: async () => undefined },
    });
    // Not a log and not a boot failure: the check runs lazily on first use and then REJECTS every
    // request, naming the table. A drifted schema therefore fails the first health probe / request
    // loudly instead of corrupting data quietly.
    await expect(auth.api.getSession({ headers: new Headers() })).rejects.toThrow(/verification/);
    await expect(auth.api.getSession({ headers: new Headers() })).rejects.toThrow(/verification/);
  });
});
