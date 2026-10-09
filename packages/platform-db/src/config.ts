import { readFileSync } from 'node:fs';
import { DatabaseConfigError } from './errors';

/**
 * The environment contract of this package. Names match
 * `APP-PLATFORM-KUBERNETES-READINESS-PLAN.md` Appendix A and the `qnsc-service` chart:
 * the chart sets them, this package reads them, and a rename on either side is a cross-repo
 * contract break.
 *
 * Every field is optional here because a bag of env vars is. {@link readDatabaseConfig} is
 * what turns it into something usable, or refuses.
 */
export interface DatabaseEnv {
  /** CloudNativePG `-rw` service. */
  DATABASE_HOST?: string;
  /** Default 5432. */
  DATABASE_PORT?: string;
  DATABASE_NAME?: string;
  /** From the CNPG-generated Secret. The migrator Job sets this to the migrator role. */
  DATABASE_USER?: string;
  /** From the CNPG-generated Secret. */
  DATABASE_PASSWORD?: string;
  /** Only `password` (or unset). There is no IAM mode. */
  DATABASE_AUTH?: string;
  /** PATH of the CA file mounted from the CNPG CA Secret. Required unless DATABASE_SSL=disable. */
  DATABASE_SSL_CA?: string;
  /** Only `disable`, and only when NODE_ENV is not `production`. */
  DATABASE_SSL?: string;
  /** CNPG `-ro` service. When set, a second pool is created for it. */
  DATABASE_READ_HOST?: string;
  /** Default 10. */
  DB_POOL_MAX?: string;
  /** Default 30000. */
  DB_POOL_IDLE_TIMEOUT_MS?: string;
  /** Default 5000. */
  DB_POOL_CONNECT_TIMEOUT_MS?: string;
  NODE_ENV?: string;
}

export interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  /** PEM of the trust anchor, or `undefined` when TLS is disabled (non-production only). */
  caPem: string | undefined;
  /** Path the PEM was read from. */
  caPath: string | undefined;
  readHost: string | undefined;
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
}

export const DEFAULTS = {
  port: 5432,
  /**
   * Sized to stay well under a role's CONNECTION LIMIT with a few replicas. Raise it through
   * DB_POOL_MAX deliberately, after doing the replicas × max arithmetic.
   */
  poolMax: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
} as const;

function required(env: DatabaseEnv, name: keyof DatabaseEnv, hint: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new DatabaseConfigError(`${name} is required. ${hint}`);
  }
  return value;
}

function integer(
  env: DatabaseEnv,
  name: keyof DatabaseEnv,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new DatabaseConfigError(
      `${name} must be an integer between ${min} and ${max}, received "${raw}".`,
    );
  }
  return value;
}

/**
 * Read and validate the environment. Throws {@link DatabaseConfigError} naming the variable;
 * nothing here opens a connection.
 *
 * TLS is verified by default. The only way to turn it off is `DATABASE_SSL=disable`, which is
 * refused when `NODE_ENV=production`: a production pod must never talk to Postgres in the
 * clear because someone copied a local `.env`.
 */
export function readDatabaseConfig(env: DatabaseEnv = process.env): DatabaseConfig {
  const auth = env.DATABASE_AUTH?.trim().toLowerCase();
  if (auth && auth !== 'password') {
    throw new DatabaseConfigError(
      `DATABASE_AUTH must be "password" or unset, received "${env.DATABASE_AUTH}". ` +
        'IAM database authentication is not supported: credentials come from the ' +
        'CloudNativePG-generated Secret.',
    );
  }

  const host = required(env, 'DATABASE_HOST', 'Use the CloudNativePG <cluster>-rw service.');
  const database = required(env, 'DATABASE_NAME', 'The chart sets it from data.postgres.name.');
  const user = required(env, 'DATABASE_USER', 'It comes from the CloudNativePG-generated Secret.');
  // Not `.trim()`med: a password is opaque and may legitimately end in whitespace.
  const password = env.DATABASE_PASSWORD;
  if (!password) {
    throw new DatabaseConfigError(
      'DATABASE_PASSWORD is required. It comes from the CloudNativePG-generated Secret; an ' +
        'empty value means the Secret was not mounted or the key name is wrong.',
    );
  }

  const ssl = env.DATABASE_SSL?.trim().toLowerCase();
  if (ssl && ssl !== 'disable') {
    throw new DatabaseConfigError(
      `DATABASE_SSL must be unset (TLS verified against DATABASE_SSL_CA) or "disable", received "${env.DATABASE_SSL}".`,
    );
  }

  let caPem: string | undefined;
  let caPath: string | undefined;
  if (ssl === 'disable') {
    if (env.NODE_ENV === 'production') {
      throw new DatabaseConfigError(
        'DATABASE_SSL=disable is refused when NODE_ENV=production. It exists only for local ' +
          'development against a plaintext Postgres; unset it and mount DATABASE_SSL_CA.',
      );
    }
  } else {
    caPath = required(
      env,
      'DATABASE_SSL_CA',
      'It is the path of the CA file mounted from the CloudNativePG <cluster>-ca Secret. ' +
        'For local development without TLS set DATABASE_SSL=disable (not allowed in production).',
    );
    try {
      caPem = readFileSync(caPath, 'utf8');
    } catch (err) {
      throw new DatabaseConfigError(
        `DATABASE_SSL_CA points to "${caPath}", which cannot be read (${(err as NodeJS.ErrnoException).code ?? 'error'}). ` +
          'Check that the CA Secret is mounted at that path.',
      );
    }
    if (!caPem.includes('-----BEGIN CERTIFICATE-----')) {
      throw new DatabaseConfigError(
        `DATABASE_SSL_CA ("${caPath}") does not contain a PEM certificate. Mount the CA ` +
          'certificate (ca.crt), not the private key or an empty file.',
      );
    }
  }

  return {
    host,
    port: integer(env, 'DATABASE_PORT', DEFAULTS.port, 1, 65_535),
    database,
    user,
    password,
    caPem,
    caPath,
    readHost: env.DATABASE_READ_HOST?.trim() || undefined,
    max: integer(env, 'DB_POOL_MAX', DEFAULTS.poolMax, 1, 1_000),
    idleTimeoutMillis: integer(
      env,
      'DB_POOL_IDLE_TIMEOUT_MS',
      DEFAULTS.idleTimeoutMillis,
      0,
      3_600_000,
    ),
    connectionTimeoutMillis: integer(
      env,
      'DB_POOL_CONNECT_TIMEOUT_MS',
      DEFAULTS.connectionTimeoutMillis,
      0,
      600_000,
    ),
  };
}
