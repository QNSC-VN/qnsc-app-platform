import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateTls } from '@quynhonsemiconductor/testing';
import { DEFAULTS, readDatabaseConfig, type DatabaseEnv } from './config';
import { DatabaseConfigError } from './errors';

let dir: string;
let caPath: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'platform-db-config-'));
  caPath = join(dir, 'ca.crt');
  writeFileSync(caPath, (await generateTls()).caCertPem);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A complete, valid environment; each test breaks one thing. */
function env(overrides: DatabaseEnv = {}): DatabaseEnv {
  return {
    DATABASE_HOST: 'pg-rova-rw',
    DATABASE_NAME: 'rova',
    DATABASE_USER: 'rova_app',
    DATABASE_PASSWORD: 'generated-by-the-test',
    DATABASE_SSL_CA: caPath,
    ...overrides,
  };
}

describe('readDatabaseConfig', () => {
  it('reads the chart env contract and applies the documented defaults', () => {
    const config = readDatabaseConfig(env());
    expect(config).toMatchObject({
      host: 'pg-rova-rw',
      port: DEFAULTS.port,
      database: 'rova',
      user: 'rova_app',
      max: DEFAULTS.poolMax,
      idleTimeoutMillis: DEFAULTS.idleTimeoutMillis,
      connectionTimeoutMillis: DEFAULTS.connectionTimeoutMillis,
      readHost: undefined,
    });
    expect(config.caPem).toContain('BEGIN CERTIFICATE');
  });

  it('reads pool sizing, port and the read host from env', () => {
    const config = readDatabaseConfig(
      env({
        DATABASE_PORT: '6432',
        DB_POOL_MAX: '4',
        DB_POOL_IDLE_TIMEOUT_MS: '1000',
        DB_POOL_CONNECT_TIMEOUT_MS: '250',
        DATABASE_READ_HOST: 'pg-rova-ro',
      }),
    );
    expect(config).toMatchObject({
      port: 6432,
      max: 4,
      idleTimeoutMillis: 1000,
      connectionTimeoutMillis: 250,
      readHost: 'pg-rova-ro',
    });
  });

  it.each(['DATABASE_HOST', 'DATABASE_NAME', 'DATABASE_USER', 'DATABASE_PASSWORD'] as const)(
    'names %s when it is missing',
    (name) => {
      expect(() => readDatabaseConfig(env({ [name]: undefined }))).toThrow(
        expect.objectContaining({
          name: 'DatabaseConfigError',
          message: expect.stringContaining(name),
        }),
      );
    },
  );

  it('does not trim the password: it is opaque', () => {
    expect(readDatabaseConfig(env({ DATABASE_PASSWORD: ' p w ' })).password).toBe(' p w ');
  });

  it.each(['0', '65536', 'abc', '5432.5'])('rejects DATABASE_PORT=%s', (value) => {
    expect(() => readDatabaseConfig(env({ DATABASE_PORT: value }))).toThrow(/DATABASE_PORT/);
  });

  it('rejects a pool size that is not a positive integer', () => {
    expect(() => readDatabaseConfig(env({ DB_POOL_MAX: '0' }))).toThrow(/DB_POOL_MAX/);
  });

  describe('there is no IAM mode', () => {
    it('refuses DATABASE_AUTH=iam and says why', () => {
      expect(() => readDatabaseConfig(env({ DATABASE_AUTH: 'iam' }))).toThrow(
        /IAM database authentication is not supported/,
      );
    });
    it('accepts DATABASE_AUTH=password, which the chart still sets', () => {
      expect(() => readDatabaseConfig(env({ DATABASE_AUTH: 'password' }))).not.toThrow();
    });
  });

  describe('TLS', () => {
    it('requires the CA path: verification has nothing to verify against without it', () => {
      expect(() => readDatabaseConfig(env({ DATABASE_SSL_CA: undefined }))).toThrow(
        /DATABASE_SSL_CA is required/,
      );
    });

    it('names the path when the CA file cannot be read', () => {
      expect(() => readDatabaseConfig(env({ DATABASE_SSL_CA: join(dir, 'missing.crt') }))).toThrow(
        /missing\.crt.*cannot be read/,
      );
    });

    it('refuses a CA file that is not a certificate', () => {
      const bad = join(dir, 'empty.crt');
      writeFileSync(bad, '');
      expect(() => readDatabaseConfig(env({ DATABASE_SSL_CA: bad }))).toThrow(
        /does not contain a PEM certificate/,
      );
    });

    it('allows DATABASE_SSL=disable outside production, with no CA', () => {
      const config = readDatabaseConfig(
        env({ DATABASE_SSL: 'disable', DATABASE_SSL_CA: undefined, NODE_ENV: 'development' }),
      );
      expect(config.caPem).toBeUndefined();
      expect(() =>
        readDatabaseConfig(env({ DATABASE_SSL: 'disable', DATABASE_SSL_CA: undefined })),
      ).not.toThrow();
    });

    it('REFUSES DATABASE_SSL=disable when NODE_ENV=production', () => {
      expect(() =>
        readDatabaseConfig(env({ DATABASE_SSL: 'disable', NODE_ENV: 'production' })),
      ).toThrow(DatabaseConfigError);
      expect(() =>
        readDatabaseConfig(env({ DATABASE_SSL: 'disable', NODE_ENV: 'production' })),
      ).toThrow(/refused when NODE_ENV=production/);
    });

    it('refuses any other DATABASE_SSL value instead of guessing what it meant', () => {
      for (const value of ['require', 'false', 'off', 'verify-full']) {
        expect(() => readDatabaseConfig(env({ DATABASE_SSL: value }))).toThrow(
          /DATABASE_SSL must be/,
        );
      }
    });
  });
});

describe('environment contract', () => {
  /**
   * The names the `qnsc-service` chart sets and `APP-PLATFORM-KUBERNETES-READINESS-PLAN.md`
   * Appendix A lists. A rename on either side is a cross-repo break, so this fails loudly if
   * the package stops reading one of them.
   */
  it.each([
    [
      'DATABASE_HOST',
      { DATABASE_HOST: 'a-different-host' },
      (c: ReturnType<typeof readDatabaseConfig>) => c.host,
      'a-different-host',
    ],
    [
      'DATABASE_PORT',
      { DATABASE_PORT: '5999' },
      (c: ReturnType<typeof readDatabaseConfig>) => c.port,
      5999,
    ],
    [
      'DATABASE_NAME',
      { DATABASE_NAME: 'other' },
      (c: ReturnType<typeof readDatabaseConfig>) => c.database,
      'other',
    ],
    [
      'DATABASE_USER',
      { DATABASE_USER: 'someone' },
      (c: ReturnType<typeof readDatabaseConfig>) => c.user,
      'someone',
    ],
    [
      'DATABASE_PASSWORD',
      { DATABASE_PASSWORD: 'secret-x' },
      (c: ReturnType<typeof readDatabaseConfig>) => c.password,
      'secret-x',
    ],
    [
      'DATABASE_READ_HOST',
      { DATABASE_READ_HOST: 'ro' },
      (c: ReturnType<typeof readDatabaseConfig>) => c.readHost,
      'ro',
    ],
    ['DB_POOL_MAX', { DB_POOL_MAX: '7' }, (c: ReturnType<typeof readDatabaseConfig>) => c.max, 7],
  ] as const)('%s is read', (_name, overrides, pick, expected) => {
    expect(pick(readDatabaseConfig(env(overrides)))).toBe(expected);
  });

  it('DATABASE_SSL_CA is the PATH of the CA, not its content', () => {
    expect(readDatabaseConfig(env()).caPath).toBe(caPath);
  });
});
