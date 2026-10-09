import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  dockerTestsEnabled,
  generateTls,
  quoteIdent,
  startPostgres,
  type PostgresHarness,
} from '@quynhonsemiconductor/testing';
import { DatabaseConfigError, DatabaseConnectionError } from './errors';
import { createMigratorPool, createPool, createReadPool } from './pool';
import { pingDatabase } from './ping';

const enabled = await dockerTestsEnabled();
const quiet = { warn: () => undefined, error: () => undefined };

describe.skipIf(!enabled)('createPool against PostgreSQL 18 with a self-signed CA', () => {
  let pg: PostgresHarness;
  let otherCaDir: string;
  let otherCaPath: string;

  beforeAll(async () => {
    pg = await startPostgres({ tls: true });
    otherCaDir = mkdtempSync(join(tmpdir(), 'platform-db-other-ca-'));
    otherCaPath = join(otherCaDir, 'ca.crt');
    writeFileSync(otherCaPath, (await generateTls()).caCertPem);
  }, 180_000);

  afterAll(async () => {
    await pg?.stop();
    rmSync(otherCaDir, { recursive: true, force: true });
  }, 60_000);

  it('connects over TLS verified against DATABASE_SSL_CA', async () => {
    const pool = createPool(pg.env(), { logger: quiet });
    try {
      await pingDatabase(pool);
      const session = await pool.query('SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()');
      expect(session.rows[0]).toEqual({ ssl: true });
    } finally {
      await pool.end();
    }
  });

  it('fails with TLS_UNTRUSTED_CA, naming DATABASE_SSL_CA, when the CA is the wrong one', async () => {
    const pool = createPool({ ...pg.env(), DATABASE_SSL_CA: otherCaPath }, { logger: quiet });
    try {
      const error = await pingDatabase(pool).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(DatabaseConnectionError);
      expect(error).toMatchObject({ code: 'TLS_UNTRUSTED_CA' });
      expect((error as Error).message).toContain('DATABASE_SSL_CA');
    } finally {
      await pool.end();
    }
  });

  it('fails with AUTH_FAILED, naming the Secret, when the password is wrong', async () => {
    const pool = createPool(
      { ...pg.env(), DATABASE_PASSWORD: randomBytes(12).toString('hex') },
      { logger: quiet },
    );
    try {
      const error = await pingDatabase(pool).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(DatabaseConnectionError);
      expect(error).toMatchObject({ code: 'AUTH_FAILED' });
      expect((error as Error).message).toMatch(/DATABASE_PASSWORD.*CloudNativePG/s);
      expect((error as Error).message).toContain(`"${pg.user}"`);
    } finally {
      await pool.end();
    }
  });

  it('fails with CONNECTION_LIMIT, naming DB_POOL_MAX, when the role has no free slot', async () => {
    const role = 'limited_ping_role';
    const password = randomBytes(12).toString('hex');
    const admin = pg.createPool({ max: 1 });
    await admin.query(
      `CREATE ROLE ${quoteIdent(role)} LOGIN PASSWORD '${password}' CONNECTION LIMIT 1`,
    );
    const holder = createPool(
      { ...pg.env(), DATABASE_USER: role, DATABASE_PASSWORD: password, DB_POOL_MAX: '1' },
      { logger: quiet },
    );
    const second = createPool(
      { ...pg.env(), DATABASE_USER: role, DATABASE_PASSWORD: password, DB_POOL_MAX: '1' },
      { logger: quiet },
    );
    try {
      const held = await holder.connect();
      try {
        const error = await pingDatabase(second).then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(error).toBeInstanceOf(DatabaseConnectionError);
        expect(error).toMatchObject({ code: 'CONNECTION_LIMIT' });
        expect((error as Error).message).toMatch(/replicas × DB_POOL_MAX/);
      } finally {
        held.release();
      }
    } finally {
      await Promise.all([holder.end(), second.end()]);
      await admin.query(`DROP ROLE ${quoteIdent(role)}`);
    }
  });

  it('createMigratorPool uses the same variables and defaults to a small pool', async () => {
    const pool = createMigratorPool(pg.env(), { logger: quiet });
    try {
      expect(pool.options.max).toBe(2);
      await pingDatabase(pool);
    } finally {
      await pool.end();
    }
    const sized = createMigratorPool({ ...pg.env(), DB_POOL_MAX: '5' }, { logger: quiet });
    expect(sized.options.max).toBe(5);
    await sized.end();
  });

  it('honours DB_POOL_MAX and the timeouts from env', async () => {
    const pool = createPool(
      {
        ...pg.env(),
        DB_POOL_MAX: '3',
        DB_POOL_IDLE_TIMEOUT_MS: '1234',
        DB_POOL_CONNECT_TIMEOUT_MS: '2345',
      },
      { logger: quiet },
    );
    try {
      expect(pool.options).toMatchObject({
        max: 3,
        idleTimeoutMillis: 1234,
        connectionTimeoutMillis: 2345,
      });
      expect(pool.options.ssl).toMatchObject({ rejectUnauthorized: true });
    } finally {
      await pool.end();
    }
  });

  it('does not kill the process when an idle client errors', async () => {
    const warnings: string[] = [];
    const pool = createPool(pg.env(), {
      logger: { warn: (message) => warnings.push(message), error: () => undefined },
    });
    try {
      const { rows } = await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      // Terminate exactly that idle backend from outside, as a failover or node drain would.
      await pg.createPool({ max: 1 }).query('SELECT pg_terminate_backend($1)', [rows[0]!.pid]);
      await vi.waitFor(() => expect(warnings).toHaveLength(1));
      expect(warnings[0]).toMatch(/Database client error on .*:\d+: terminating connection/);
      // Names the host and port, and carries no credential.
      expect(warnings[0]).not.toContain(pg.password);
      expect(warnings[0]).not.toContain(pg.user + ':');
      // The pool replaces the dead client instead of the process having crashed.
      await pingDatabase(pool);
    } finally {
      await pool.end();
    }
  });

  it('createReadPool targets DATABASE_READ_HOST with the same role and TLS', async () => {
    expect(createReadPool(pg.env(), { logger: quiet })).toBeUndefined();

    const read = createReadPool({ ...pg.env(), DATABASE_READ_HOST: pg.host }, { logger: quiet });
    expect(read).toBeDefined();
    try {
      await pingDatabase(read!);
      expect(read!.options).toMatchObject({ host: pg.host, user: pg.user });
      expect(read!.options.ssl).toMatchObject({ rejectUnauthorized: true });
    } finally {
      await read!.end();
    }
  });
});

describe.skipIf(!enabled)('TLS is never silently dropped', () => {
  let plain: PostgresHarness;

  beforeAll(async () => {
    plain = await startPostgres({ tls: false });
  }, 180_000);
  afterAll(async () => {
    await plain?.stop();
  }, 60_000);

  it('refuses a server that does not offer TLS when TLS is required (TLS_NOT_OFFERED)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'platform-db-plain-'));
    try {
      const ca = join(dir, 'ca.crt');
      writeFileSync(ca, (await generateTls()).caCertPem);
      const pool = createPool({ ...plain.env(), DATABASE_SSL_CA: ca }, { logger: quiet });
      try {
        await expect(pingDatabase(pool)).rejects.toMatchObject({ code: 'TLS_NOT_OFFERED' });
      } finally {
        await pool.end();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('connects in plaintext only with DATABASE_SSL=disable outside production', async () => {
    const pool = createPool({ ...plain.env(), DATABASE_SSL: 'disable' }, { logger: quiet });
    try {
      await pingDatabase(pool);
    } finally {
      await pool.end();
    }
  });

  it('refuses DATABASE_SSL=disable in production before connecting', () => {
    expect(() =>
      createPool(
        { ...plain.env(), DATABASE_SSL: 'disable', NODE_ENV: 'production' },
        { logger: quiet },
      ),
    ).toThrow(DatabaseConfigError);
  });
});

describe('createPool without Docker', () => {
  it('names an unreachable host (UNREACHABLE) instead of hanging on it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'platform-db-unreachable-'));
    try {
      const ca = join(dir, 'ca.crt');
      writeFileSync(ca, (await generateTls()).caCertPem);
      const pool = createPool(
        {
          DATABASE_HOST: '127.0.0.1',
          // Port 1 is never a Postgres; nothing listens there, so the connection is refused.
          DATABASE_PORT: '1',
          DATABASE_NAME: 'x',
          DATABASE_USER: 'x',
          DATABASE_PASSWORD: 'x',
          DATABASE_SSL_CA: ca,
        },
        { logger: quiet },
      );
      try {
        await expect(pingDatabase(pool)).rejects.toMatchObject({ code: 'UNREACHABLE' });
      } finally {
        await pool.end();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
