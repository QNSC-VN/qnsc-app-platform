import { existsSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dockerTestsEnabled } from './docker';
import { startPostgres, type PostgresHarness } from './postgres';
import { generateTls } from './tls';

const enabled = await dockerTestsEnabled();

describe.skipIf(!enabled)('startPostgres({ tls: true })', () => {
  let pg: PostgresHarness;

  beforeAll(async () => {
    pg = await startPostgres({ tls: true });
  }, 180_000);

  afterAll(async () => {
    await pg?.stop();
  }, 60_000);

  it('serves TLS, and a client that verifies against the generated CA connects over it', async () => {
    const pool = pg.createPool({ max: 1 });
    expect((await pool.query('SHOW ssl')).rows[0].ssl).toBe('on');
    const session = await pool.query('SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()');
    expect(session.rows[0].ssl).toBe(true);
  });

  it('connects by IP when the expected name is the certificate name', async () => {
    const pool = pg.createPool({ host: '127.0.0.1', max: 1 });
    expect((await pool.query('SELECT 1 AS ok')).rows[0].ok).toBe(1);
  });

  it('REFUSES a client that does not trust the CA', async () => {
    const pool = pg.createPool({ ssl: { rejectUnauthorized: true, servername: 'localhost' } });
    await expect(pool.query('SELECT 1')).rejects.toThrow(
      /self[- ]signed|unable to verify|certificate/i,
    );
  });

  it('REFUSES a client that trusts a different CA', async () => {
    const other = await generateTls();
    const pool = pg.createPool({
      ssl: { ca: other.caCertPem, rejectUnauthorized: true, servername: 'localhost' },
    });
    await expect(pool.query('SELECT 1')).rejects.toThrow(
      /self[- ]signed|unable to verify|certificate/i,
    );
  });

  it('REFUSES a verified client that expects a different server name', async () => {
    // node-postgres overwrites `servername` with `host` unless `host` is an IP literal, so
    // connect by IP for the override to be the name that is checked.
    const pool = pg.createPool({
      host: '127.0.0.1',
      ssl: { ca: pg.caCertPem, rejectUnauthorized: true, servername: 'not-the-server.example' },
    });
    await expect(pool.query('SELECT 1')).rejects.toThrow(/altnames|hostname|identity/i);
  });

  it('exposes DATABASE_SSL_CA as a path to the CA, matching platform-db', () => {
    const env = pg.env();
    expect(env['DATABASE_SSL_CA']).toBe(pg.caCertPath);
    expect(readFileSync(env['DATABASE_SSL_CA']!, 'utf8')).toBe(pg.caCertPem);
  });

  it('removes the CA file on stop()', async () => {
    const own = await startPostgres({ tls: true });
    const path = own.caCertPath!;
    expect(existsSync(path)).toBe(true);
    await own.stop();
    expect(existsSync(path)).toBe(false);
  }, 180_000);
});
