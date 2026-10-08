import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { Pool, type PoolConfig } from 'pg';
import { POSTGRES_IMAGE } from './docker';
import { resetDatabase, truncateTables, type TruncateOptions } from './reset';
import { generateTls, TLS_SERVER_NAME } from './tls';

export interface StartPostgresOptions {
  /** Serve TLS with a freshly generated self-signed CA. Default: false. */
  tls?: boolean;
  /** Override the image. Default: {@link POSTGRES_IMAGE} (PostgreSQL 18). */
  image?: string;
  /** Default: `app`. */
  database?: string;
  /** Default: `app`. */
  user?: string;
  /** Default: random per start. Tests must not depend on a fixed credential. */
  password?: string;
}

export interface PostgresHarness {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string;
  /** `postgres://…` URI. With TLS it carries no sslmode — pass {@link ssl} to the driver. */
  readonly uri: string;
  readonly tls: boolean;
  /** PEM of the CA that signed the server certificate; only when `tls` is true. */
  readonly caCertPem: string | undefined;
  /** Path to a file holding {@link caCertPem}, removed on `stop()`; only when `tls` is true. */
  readonly caCertPath: string | undefined;
  /**
   * `pg` `ssl` option that VERIFIES the server against the generated CA (never
   * `rejectUnauthorized: false`); `false` when TLS is off.
   */
  readonly ssl: PoolConfig['ssl'];
  /**
   * The env contract of `platform-db`, ready to merge into `process.env` or a config object:
   * DATABASE_HOST/PORT/NAME/USER/PASSWORD, plus DATABASE_SSL_CA (a path) when `tls` is true.
   */
  env(): Record<string, string>;
  /** A new `pg` Pool against this server. The caller owns it; `stop()` does not end it. */
  createPool(overrides?: PoolConfig): Pool;
  /** Drop every non-system schema and recreate `public`. Slow, total. */
  reset(): Promise<void>;
  /** Truncate tables, keeping the schema. Fast, for between tests. */
  truncate(options?: TruncateOptions): Promise<void>;
  stop(): Promise<void>;
}

const TLS_DIR = '/etc/postgresql-tls';

/**
 * Start a PostgreSQL 18 container.
 *
 * With `tls: true`, the server presents a certificate signed by a CA generated for this call, so
 * a client that does not trust that CA is REFUSED. That is the point: platform-db must verify the
 * server, and it can only be tested against a server that would fail an unverified client.
 */
export async function startPostgres(options: StartPostgresOptions = {}): Promise<PostgresHarness> {
  const database = options.database ?? 'app';
  const user = options.user ?? 'app';
  const password = options.password ?? randomBytes(18).toString('hex');
  const tls = options.tls ?? false;

  let container = new GenericContainer(options.image ?? POSTGRES_IMAGE)
    .withEnvironment({ POSTGRES_DB: database, POSTGRES_USER: user, POSTGRES_PASSWORD: password })
    .withExposedPorts(5432)
    // initdb logs the readiness line twice: once for the bootstrap server, once for the real one.
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(120_000);

  let caCertPem: string | undefined;
  if (tls) {
    const material = await generateTls();
    caCertPem = material.caCertPem;
    // The server refuses a key that is group/world readable or not owned by the postgres user,
    // and a copied-in file is owned by root. So stage the files and let the entrypoint install
    // them with the right owner and mode before handing over to the stock entrypoint.
    container = container
      .withCopyContentToContainer([
        { content: material.serverCertPem, target: '/tls-staging/server.crt', mode: 0o644 },
        { content: material.serverKeyPem, target: '/tls-staging/server.key', mode: 0o600 },
      ])
      .withEntrypoint([
        'sh',
        '-c',
        [
          `install -d -o postgres -g postgres -m 700 ${TLS_DIR}`,
          `install -o postgres -g postgres -m 644 /tls-staging/server.crt ${TLS_DIR}/server.crt`,
          `install -o postgres -g postgres -m 600 /tls-staging/server.key ${TLS_DIR}/server.key`,
          `exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=${TLS_DIR}/server.crt -c ssl_key_file=${TLS_DIR}/server.key`,
        ].join(' && '),
      ]);
  }

  const started: StartedTestContainer = await container.start();

  let caCertPath: string | undefined;
  let caDir: string | undefined;
  if (caCertPem) {
    caDir = mkdtempSync(join(tmpdir(), 'pg-testing-ca-'));
    caCertPath = join(caDir, 'ca.pem');
    writeFileSync(caCertPath, caCertPem, { mode: 0o600 });
  }

  const host = started.getHost();
  const port = started.getMappedPort(5432);
  // Verify against the name on the certificate, not the address Docker happens to hand out.
  const ssl: PoolConfig['ssl'] = caCertPem
    ? { ca: caCertPem, rejectUnauthorized: true, servername: TLS_SERVER_NAME }
    : false;
  const uri = `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}`;

  const pools = new Set<Pool>();
  const createPool = (overrides: PoolConfig = {}): Pool => {
    const pool = new Pool({ host, port, database, user, password, ssl, ...overrides });
    pools.add(pool);
    return pool;
  };

  let adminPool: Pool | undefined;
  const admin = (): Pool => (adminPool ??= createPool({ max: 2 }));

  return {
    host,
    port,
    database,
    user,
    password,
    uri,
    tls,
    caCertPem,
    caCertPath,
    ssl,
    env() {
      return {
        DATABASE_HOST: host,
        DATABASE_PORT: String(port),
        DATABASE_NAME: database,
        DATABASE_USER: user,
        DATABASE_PASSWORD: password,
        ...(caCertPath ? { DATABASE_SSL_CA: caCertPath } : {}),
      };
    },
    createPool,
    reset: () => resetDatabase(admin()),
    truncate: (opts) => truncateTables(admin(), opts),
    async stop() {
      // Pools first: stopping the container under a live pool turns teardown into noise.
      await Promise.allSettled([...pools].map((pool) => pool.end()));
      pools.clear();
      await started.stop();
      if (caDir) rmSync(caDir, { recursive: true, force: true });
    },
  };
}
