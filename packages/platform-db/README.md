# @quynhonsemiconductor/platform-db

The one PostgreSQL connection layer for QNSC product backends: **password auth from the
CloudNativePG-generated Secret, TLS verified against the cluster CA, a sized pool, a readiness ping,
a Postgres leader lock, and the transaction contract** (`DbExecutor`, `withTransaction`).

| in this package                                                 | in your product                        |
| --------------------------------------------------------------- | -------------------------------------- |
| pool from `DATABASE_*`, verified TLS, named connection errors   | your Drizzle schema and migrations     |
| `pingDatabase` for `/readyz`                                    | the repositories and queries           |
| `withAdvisoryLock` (leader lock without a cache)                | which jobs need a lock, and their keys |
| `DbExecutor` + `withTransaction` (the one transaction contract) | your units of work                     |
| optional read pool and `withReplicas()` routing                 | which reads may be stale               |

Built from `rova`'s proven `libs/platform/src/database` and `db/pg-*.ts`, with every AWS path removed:
no IAM mode, no `@aws-sdk/rds-signer`, no RDS CA bundle, no `DATABASE_URL`. There are **no
configuration options** besides the environment — see [Environment](#environment).

## Install

```ini
# .npmrc
@quynhonsemiconductor:registry=https://npm.pkg.github.com
```

```bash
pnpm add @quynhonsemiconductor/platform-db pg
pnpm add drizzle-orm                          # for /drizzle and /nest
pnpm add @quynhonsemiconductor/observability  # for /nest (pool saturation metrics)
```

Peer dependencies, by entry point (all but `pg` are marked optional because no single one is needed
by every entry point):

| entry point | needs                                                                                          |
| ----------- | ---------------------------------------------------------------------------------------------- |
| core        | `pg`                                                                                           |
| `/drizzle`  | `pg`, `drizzle-orm` (`>=0.45 <1`)                                                              |
| `/nest`     | `pg`, `drizzle-orm`, `@nestjs/common`, **`@quynhonsemiconductor/observability`** (pool gauges) |

Importing `/nest` without one of them throws a message naming the missing package.

## Subpaths

| import                                      | what                                                        | framework |
| ------------------------------------------- | ----------------------------------------------------------- | --------- |
| `@quynhonsemiconductor/platform-db`         | pools, config, `pingDatabase`, `withAdvisoryLock`, errors   | none      |
| `@quynhonsemiconductor/platform-db/drizzle` | `createDatabase`, `DbExecutor`, `withTransaction`           | Drizzle   |
| `@quynhonsemiconductor/platform-db/nest`    | `DatabaseModule.forRootAsync({ schema })`, injection tokens | NestJS    |

The core imports neither Drizzle nor Nest, so a script or a worker can use it alone.

## Environment

Names are the contract with the `qnsc-service` chart and `APP-PLATFORM-KUBERNETES-READINESS-PLAN.md`
Appendix A; a rename on either side is a cross-repo break.

| variable                     | required | default    | notes                                                                                    |
| ---------------------------- | -------- | ---------- | ---------------------------------------------------------------------------------------- |
| `DATABASE_HOST`              | yes      |            | the CloudNativePG `<cluster>-rw` service                                                 |
| `DATABASE_PORT`              |          | `5432`     |                                                                                          |
| `DATABASE_NAME`              | yes      |            |                                                                                          |
| `DATABASE_USER`              | yes      |            | from the CNPG Secret. The migration Job sets the **migrator** role here                  |
| `DATABASE_PASSWORD`          | yes      |            | from the CNPG Secret                                                                     |
| `DATABASE_AUTH`              |          | `password` | only `password` is accepted; the chart sets it. Anything else (`iam`) is refused         |
| `DATABASE_SSL_CA`            | yes¹     |            | **path** of the CA file mounted from the CNPG `<cluster>-ca` Secret (`ca.crt`)           |
| `DATABASE_SSL`               |          |            | only `disable`, and **only when `NODE_ENV !== 'production'`** (local plaintext Postgres) |
| `DATABASE_READ_HOST`         |          |            | CNPG `<cluster>-ro` service. Unset until a replica exists                                |
| `DB_POOL_MAX`                |          | `10`       | keep `replicas × DB_POOL_MAX` under the role's `CONNECTION LIMIT`                        |
| `DB_POOL_IDLE_TIMEOUT_MS`    |          | `30000`    |                                                                                          |
| `DB_POOL_CONNECT_TIMEOUT_MS` |          | `5000`     |                                                                                          |

¹ Not needed when `DATABASE_SSL=disable`.

### TLS is verified, always

`ssl: { ca, rejectUnauthorized: true }`. A server that presents a certificate from another CA, or a
certificate for another name, is refused; a server that does not offer TLS is refused rather than
downgraded. There is no `rejectUnauthorized: false` anywhere in this package. The certificate is
checked against `DATABASE_HOST`, so use the cluster service name that CNPG puts on its certificate
(`<cluster>-rw`), not a pod IP.

`DATABASE_SSL=disable` exists for `docker compose` Postgres on a laptop. With `NODE_ENV=production`
the process **refuses to start** instead of connecting in the clear.

## Usage

### NestJS

```ts
// app.module.ts
import { DatabaseModule } from '@quynhonsemiconductor/platform-db/nest';
import * as schema from './db/schema';

@Module({ imports: [DatabaseModule.forRootAsync({ schema })] })
export class AppModule {}
```

```ts
import { InjectDatabase } from '@quynhonsemiconductor/platform-db/nest';
import type { Database } from '@quynhonsemiconductor/platform-db/drizzle';

@Injectable()
export class OrdersRepository {
  constructor(@InjectDatabase() private readonly db: Database<typeof schema>) {}
}
```

The module is global and provides `DATABASE_TOKEN` (Drizzle), `DATABASE_POOL_TOKEN` (`pg.Pool`) and
`DATABASE_READ_POOL_TOKEN` (`Pool | null`). It pings the database once at boot and **logs the named
cause** of a failure without crashing — `/readyz` is what gates traffic — while a configuration error
(missing secret, unreadable CA, `DATABASE_SSL=disable` in production) **fails the boot** with the
variable's name. It registers pool saturation gauges (`inUse`, `waiting`) and ends the pools in
`onApplicationShutdown` (see below).

**Why `onApplicationShutdown`.** Nest's `close()` runs destroy hooks, then closes the HTTP server
(waiting for in-flight requests), then runs shutdown hooks. Ending the pool in a destroy hook would pull
it out from under requests still running queries; in a shutdown hook the server has already drained.

`/readyz` (see `platform-runtime`) finds the pool by `DATABASE_POOL_TOKEN`, which is a
`Symbol.for(...)` registry symbol, so it works even when two copies of this package are installed.

### Without Nest

```ts
import { createPool, pingDatabase } from '@quynhonsemiconductor/platform-db';
import { createDatabase } from '@quynhonsemiconductor/platform-db/drizzle';

const pool = createPool(); // reads process.env
const db = createDatabase(pool, { schema });
await pingDatabase(pool);
// … on shutdown: await pool.end();
```

### Migrations

```ts
import { createMigratorPool } from '@quynhonsemiconductor/platform-db';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';

const pool = createMigratorPool(); // same variables; the Job sets the migrator role's Secret
await migrate(drizzle(pool), { migrationsFolder: './db/migrations' });
await pool.end();
```

One code path for both roles. It defaults to a pool of 2 (migrations are sequential, and the migrator
role has its own `CONNECTION LIMIT`); `DB_POOL_MAX` overrides it.

## The transaction contract: `DbExecutor` and `withTransaction`

`platform-jobs` (transactional enqueue) and `identity` v8 depend on these two exports. Treat them as
public API.

```ts
import type { DbExecutor } from '@quynhonsemiconductor/platform-db/drizzle';
import { withTransaction } from '@quynhonsemiconductor/platform-db/drizzle';
```

- **`DbExecutor<TSchema>`** — either the root database or an open transaction. Accept it wherever a
  function may or may not run inside a caller's transaction, defaulting to the injected root database:

  ```ts
  async save(order: Order, db: DbExecutor<typeof schema> = this.db) {
    await db.insert(orders).values(order);
  }
  ```

- **`withTransaction(db, fn, config?)`** — COMMIT when `fn` resolves, ROLLBACK when it throws (and
  rethrow).
  - Given the **root** database it opens a transaction.
  - Given a **transaction** it **joins** it: `fn` runs in the caller's transaction, with no savepoint
    and no commit of its own, so its writes live or die with the outer one. A service can therefore
    call `withTransaction` without knowing whether its caller already opened one.
  - `config` (`isolationLevel`, `accessMode`, …) can only be applied when **opening**. Passing it while
    joining **throws**, because running at a weaker isolation than requested must not happen silently.

  ```ts
  // Roll back ⇒ no row AND no job. Nothing external happens inside the transaction.
  await withTransaction(db, async (tx) => {
    await orders.save(order, tx);
    await jobs.send('mail.send', message, { tx });
  });
  ```

**Never call an external provider (mail, HTTP, an LLM) inside `fn`.** Enqueue a job; it commits with
the business write and runs after.

`DbExecutor` names no Drizzle internals beyond `NodePgDatabase` and its transaction type, so it stays
assignable when a consumer's tree holds a second copy of `drizzle-orm`.

## `withAdvisoryLock(pool, key, fn)`

Runs `fn` only if no other session holds the lock named `key`; otherwise returns
`{ acquired: false }` immediately (`pg_try_advisory_lock`, never the blocking call).

```ts
const result = await withAdvisoryLock(pool, 'cron:audit-cleanup', () => sweep());
if (!result.acquired) return; // another replica has this tick
```

- The lock is **session-scoped** and held on one pooled client for the whole of `fn`, so keep
  `DB_POOL_MAX` at 2 or more where it is used.
- A crashed pod or dropped connection **frees the lock on the server**; there is no TTL to tune.
- If the unlock fails the connection is destroyed rather than returned to the pool.
- It is the fallback for `platform-runtime`'s `ExclusiveJob` when there is no cache, until
  `platform-jobs` schedules replace it.

## Errors name the cause

Every connection failure surfaced by `pingDatabase`, `withAdvisoryLock` and the module's boot log is a
`DatabaseConnectionError` with a `code`, instead of a bare `28P01`:

| `code`             | meaning                                         | look at                                         |
| ------------------ | ----------------------------------------------- | ----------------------------------------------- |
| `AUTH_FAILED`      | `28P01` / `28000`                               | the CNPG Secret; after a rotation, restart pods |
| `TLS_UNTRUSTED_CA` | certificate does not chain to `DATABASE_SSL_CA` | the mounted `<cluster>-ca` Secret               |
| `TLS_CERT_INVALID` | wrong name on the certificate, or expired       | `DATABASE_HOST` (use `<cluster>-rw`)            |
| `TLS_NOT_OFFERED`  | server does not offer TLS                       | the target; never downgraded                    |
| `CONNECTION_LIMIT` | `53300`                                         | `replicas × DB_POOL_MAX` vs the role's limit    |
| `CONNECT_TIMEOUT`  | pool gave up waiting                            | `DB_POOL_CONNECT_TIMEOUT_MS`, `DB_POOL_MAX`     |
| `UNREACHABLE`      | DNS / refused / timed out                       | `DATABASE_HOST`, NetworkPolicy                  |

Configuration problems found before connecting are `DatabaseConfigError`. `classifyDatabaseError()`
walks the whole `cause` chain, because Drizzle wraps driver errors.

## A dropped connection does not kill the process

Every client `createPool` makes gets a permanent `'error'` listener that logs a warning (host, port and
the driver's message; never credentials). Without it, ending a connection that is **in use** (a
failover, a node drain, a CNPG switchover: `57P01`) raised an uncaught exception, because pg-pool
removes its own listener while a client is checked out and Drizzle's `transaction()` adds none. The
query or transaction on that connection still **rejects** normally and the pool discards the dead
client. Pass pools from `createPool()` to `withAdvisoryLock` and Drizzle; a pool built by hand does not
carry the listener.

## Read replica (unused until needed)

Set `DATABASE_READ_HOST` and `DatabaseModule` builds a second pool (same role, TLS and sizing) and
Drizzle's `withReplicas()` routes plain reads to it; writes and transactions go to the primary. Use
`db.$primary` for a read that must see your own write.

## Pooling

| Environment                                      | Pooling                                                           |
| ------------------------------------------------ | ----------------------------------------------------------------- |
| Dev, and prod at current scale                   | none — the role's `CONNECTION LIMIT` is the backstop              |
| If `replicas × DB_POOL_MAX` approaches the limit | the CNPG-managed PgBouncer `Pooler` (password auth works with it) |

## Testing your own code

`@quynhonsemiconductor/testing` is a private workspace package of this repository (never published). A
product tests against its own Postgres; `createPool(env)` accepts any environment bag, so tests pass
theirs instead of mutating `process.env`.

## Known limits

- PostgreSQL only, through `node-postgres`. No other driver.
- No IAM or token auth: credentials come from the CNPG Secret, which pods read at start, so a rotation
  needs a rolling restart.
- A single node has no HA until the second node exists (`HYBRID-INFRA-PLAN.md`).
- `withAdvisoryLock` holds one pooled client per held lock.
