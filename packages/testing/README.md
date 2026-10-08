# @quynhonsemiconductor/testing

Workspace-internal testcontainers harness for PostgreSQL 18 and Valkey. **`"private": true` — never
published, never in `release-please-config.json`.** Other packages use it as a `devDependency`:

```jsonc
"devDependencies": { "@quynhonsemiconductor/testing": "workspace:*" }
```

It exports TypeScript source directly (`main` is `src/index.ts`); vitest runs it as is, so there is
no build step.

## PostgreSQL

```ts
import {
  dockerTestsEnabled,
  startPostgres,
  type PostgresHarness,
} from '@quynhonsemiconductor/testing';

const enabled = await dockerTestsEnabled();

describe.skipIf(!enabled)('my repository', () => {
  let pg: PostgresHarness;
  beforeAll(async () => {
    pg = await startPostgres();
  }, 180_000);
  afterAll(async () => {
    await pg?.stop();
  });
  beforeEach(() => pg.truncate()); // fast: keeps the schema
  // pg.reset() drops every schema and recreates public — slow, between files

  it('…', async () => {
    const pool = pg.createPool(); // node-postgres Pool, ended by pg.stop()
    // pg.uri · pg.env() → DATABASE_HOST/PORT/NAME/USER/PASSWORD
  });
});
```

### TLS

`startPostgres({ tls: true })` makes the server present a certificate signed by a **CA generated for
that call** (in-process, no `openssl`, nothing committed). A client that does not trust the CA is
refused, which is what `platform-db` has to be tested against.

- `pg.ssl` — a `pg` `ssl` option that **verifies** the server (never `rejectUnauthorized: false`).
- `pg.caCertPem` / `pg.caCertPath` — the trust anchor; the path is what `DATABASE_SSL_CA` expects and
  is deleted by `stop()`.
- The certificate is valid for `localhost`, `127.0.0.1` and `::1`. node-postgres checks the name
  against `host` unless `host` is an IP literal, in which case it checks `ssl.servername`
  (`pg.ssl` sets it to `localhost`).

## Valkey

```ts
const valkey = await startValkey();
valkey.url; // redis://host:port — hand to ioredis
await valkey.flush(); // FLUSHALL, between tests
await valkey.command('GET', 'k'); // valkey-cli inside the container
```

No client is bundled, so this package pins no ioredis version on the code under test.

## Docker on CI

`dockerTestsEnabled()` runs the suite when Docker is reachable and skips it on a developer machine
without Docker. When `CI` is set it **throws** instead of skipping: a skipped suite counts as green,
and a runner that lost Docker must not turn the database layer into "passed, tested nothing".
GitHub-hosted `ubuntu-latest` runners ship Docker, so `pnpm test` in `ci.yml` runs these suites
as is.

Credentials are generated per start; nothing here is a fixed secret.
