import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dockerTestsEnabled } from './docker';
import { startPostgres, type PostgresHarness } from './postgres';

const enabled = await dockerTestsEnabled();

describe.skipIf(!enabled)('startPostgres (plain)', () => {
  let pg: PostgresHarness;

  beforeAll(async () => {
    pg = await startPostgres();
  }, 180_000);

  afterAll(async () => {
    await pg?.stop();
  }, 60_000);

  it('runs PostgreSQL 18', async () => {
    const { rows } = await pg.createPool().query('SHOW server_version_num');
    expect(Number(rows[0].server_version_num)).toBeGreaterThanOrEqual(180000);
  });

  it('is the glibc (Debian) build, the family CloudNativePG runs, not musl', async () => {
    const { rows } = await pg.createPool().query('SELECT version() AS v');
    expect(rows[0].v).toMatch(/Debian/);
    expect(rows[0].v).toMatch(/linux-gnu/);
    expect(rows[0].v).not.toMatch(/musl/);
  });

  it('generates its own credentials', () => {
    expect(pg.password.length).toBeGreaterThanOrEqual(32);
  });

  it('exposes the platform-db env contract', () => {
    expect(pg.env()).toEqual({
      DATABASE_HOST: pg.host,
      DATABASE_PORT: String(pg.port),
      DATABASE_NAME: 'app',
      DATABASE_USER: 'app',
      DATABASE_PASSWORD: pg.password,
    });
    expect(pg.ssl).toBe(false);
  });

  it('truncate() empties tables, restarts identity, and keeps the excepted ones', async () => {
    const pool = pg.createPool();
    await pool.query('CREATE TABLE t_items (id serial PRIMARY KEY, n int)');
    await pool.query('CREATE TABLE t_journal (id serial PRIMARY KEY)');
    await pool.query('INSERT INTO t_items (n) VALUES (1), (2)');
    await pool.query('INSERT INTO t_journal DEFAULT VALUES');

    await pg.truncate({ except: ['t_journal'] });

    expect((await pool.query('SELECT count(*)::int AS c FROM t_items')).rows[0].c).toBe(0);
    expect((await pool.query('SELECT count(*)::int AS c FROM t_journal')).rows[0].c).toBe(1);
    const next = await pool.query('INSERT INTO t_items (n) VALUES (3) RETURNING id');
    expect(next.rows[0].id).toBe(1);
  });

  it('reset() drops every non-system schema and recreates an empty public', async () => {
    const pool = pg.createPool();
    await pool.query('CREATE SCHEMA "odd""name"');
    await pool.query('CREATE TABLE "odd""name".x (id int)');
    await pool.query('CREATE TABLE IF NOT EXISTS public.leftover (id int)');

    await pg.reset();

    const schemas = await pool.query(
      `SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'`,
    );
    expect(schemas.rows.map((r) => r.nspname)).toEqual(['public']);
    const tables = await pool.query(
      `SELECT count(*)::int AS c FROM pg_tables WHERE schemaname = 'public'`,
    );
    expect(tables.rows[0].c).toBe(0);
  });
});
