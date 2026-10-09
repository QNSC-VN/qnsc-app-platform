# @quynhonsemiconductor/platform-jobs

Durable background work for QNSC product backends, on **Postgres and [pg-boss](https://github.com/timgit/pg-boss)**:
the job is written in the business transaction (roll back and there is no job), delivered at least
once, retried with backoff, dead-lettered, and run by a worker process only.

| in this package                                                      | in your product                                |
| -------------------------------------------------------------------- | ---------------------------------------------- |
| `send` in the caller's transaction, idempotency keys                 | what the job does, and the payload shape       |
| handlers that run only when `ROLE=worker`                            | the handlers themselves, and their queues      |
| retries, dead letters, per-queue retention, heartbeat, graceful stop | the numbers that differ for a queue (override) |
| schedules (once per tick across replicas, `Asia/Ho_Chi_Minh`)        | which schedules exist                          |
| the `pgboss` schema install and the grants (`installJobsSchema`)     | running it in the migration Job                |
| `jobs.once`, the at-least-once guard for a handler                   | which effects need it                          |
| `/testing`: `drainQueue`, `runInline`                                | your tests                                     |

**Products never import `pg-boss`.** Nothing in this package's published types names it (its own
declarations need `skipLibCheck`, ADR 0001 F11). The queue is a swap point: this API is what a future
engine would also implement. Decision record: [`docs/adr/0001-job-queue.md`](../../docs/adr/0001-job-queue.md).

## Install

```ini
# .npmrc
@quynhonsemiconductor:registry=https://npm.pkg.github.com
```

```bash
pnpm add @quynhonsemiconductor/platform-jobs pg
```

Peer dependencies, by entry point:

| entry point                           | needs                                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------------------------ |
| core                                  | `pg`, `@quynhonsemiconductor/platform-db` (>=0.1.1), `@quynhonsemiconductor/observability` |
| enqueue in a transaction, `jobs.once` | `drizzle-orm` (`>=0.45 <1`), imported only when you pass `tx` / call `once`                |
| `/nest`                               | `@nestjs/common`, `@nestjs/core`                                                           |

Needs Node 24: pg-boss is ESM-only and this package loads it with `require`.

## Quick start (NestJS)

```ts
// app.module.ts
@Module({
  imports: [DatabaseModule.forRootAsync({ schema }), JobsModule.forRoot()],
})
export class AppModule {}
```

```ts
import { InjectJobs, JobHandler } from '@quynhonsemiconductor/platform-jobs/nest';
import type { JobContext, Jobs } from '@quynhonsemiconductor/platform-jobs';

@Injectable()
export class Invoices {
  constructor(
    @InjectDatabase() private readonly db: Database<typeof schema>,
    @InjectJobs() private readonly jobs: Jobs,
  ) {}

  // In the API: the order and its email job commit together, or neither exists.
  async place(order: NewOrder) {
    await withTransaction(this.db, async (tx) => {
      await tx.insert(orders).values(order);
      await this.jobs.send(
        'invoice.render',
        { orderId: order.id },
        { tx, idempotencyKey: `order:${order.id}` },
      );
    });
  }

  // In the worker: runs only when ROLE=worker. The method must be idempotent.
  @JobHandler('invoice.render', { concurrency: 4 })
  async render(job: JobContext<{ orderId: string }>): Promise<void> {
    /* … */
  }
}
```

This example is compiled by the test suite (`readme-example.test.ts`).

Without Nest: `createJobs({ pool: createJobsPool() })`, then `jobs.handle(…)`, `await jobs.start()`,
and `await jobs.stop(stopBudgetMs())` from your shutdown hook.

## Roles: `ROLE=worker`

One image, two deployments (plan §4.4). **Only `ROLE=worker` runs handlers, the supervisor and the
schedules.** Any other value, including unset or a typo, is an API process: it records queues so
`send` works and does nothing else, so a mis-spelled worker fails safe instead of an API pod quietly
running handlers.

| `ROLE=worker`                                                            | anything else                     |
| ------------------------------------------------------------------------ | --------------------------------- |
| fetches and runs handlers, supervises (expiry, retries, retention), cron | `send` only                       |
| registers schedules, publishes the oldest-ready-age gauge                | `schedule()` is recorded, not run |

## Environment

All configuration is the environment; there are no per-product knobs.

| variable                                            | meaning                                                                                                |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `ROLE`                                              | `worker` to run handlers (above)                                                                       |
| `DATABASE_*`                                        | the **application** role, exactly as `platform-db`; the jobs pool is a second, fixed-size (max 5) pool |
| `SHUTDOWN_TIMEOUT_MS`, `SHUTDOWN_ENDPOINT_DELAY_MS` | the same variables as `platform-runtime`; the stop budget is derived from them (see Shutdown)          |
| `OTEL_SERVICE_NAME`                                 | names this instance in pg-boss's instance registry                                                     |

## `send`

```ts
await jobs.send(queue, data, { tx, idempotencyKey, startAfter, priority });
```

- **`tx`** is a `platform-db` `DbExecutor`: the root database or an open transaction (including one you
  joined with `withTransaction`). The job commits and rolls back with it. Never call a provider
  (mail, HTTP) inside that transaction: enqueue, and let the job do it.
- **`idempotencyKey`** is mapped to a deterministic **UUIDv5 of `(queue, key)` used as the job id**.
  A second `send` with the same key inserts nothing and returns `null`; a concurrent duplicate waits
  for the first transaction to commit or roll back. It is _not_ `singletonKey`, which does not
  dedupe on a standard queue (ADR 0001 F6). The guarantee lasts as long as the row does: with
  `retention.completed: 'immediate'` it ends the moment the job succeeds.
- **`startAfter`**: seconds from now, or a `Date`. **`priority`**: integer, higher first.
- Resolves to the job id, or `null` for a duplicate.
- **Without `tx`, `send` commits on the jobs pool's own connection**, at once and independently of any
  transaction you have open: a business write you roll back afterwards does not take the job with it.
  Pass `tx` whenever the job belongs to a business write.
- The queue must be defined in the sending process (`handle()` or `defineQueue()` before `start()`),
  or `send` throws saying so.
- **Job data is stored in the database in clear.** Do not put secrets in it, and keep personal data
  to what the handler needs. A failing job's error (name and the first 500 characters of its
  message) is stored too.

## `handle` and the queue configuration

```ts
await jobs.handle('mail.send', handler, {
  concurrency: 4,
  retention: { completed: 'immediate', failed: 86_400, deadLetter: 86_400 },
});
```

Each queue has **one** configuration. Defining it twice with different options throws.
**During a rolling deploy the stored options are last-writer-wins**: the old and the new version each
converge the queue to their own code as they start. A change to a queue's options must therefore be
compatible with the version it replaces (a retention or a retry count is; renaming a dead-letter queue
is not). On every
start the queue's stored options are converged to what the code says (pg-boss's `createQueue` alone
leaves an existing queue untouched, so a changed retention would never take effect), by the API and
the worker alike.

### Defaults, and why

These are **starting points** chosen from the WP-6 findings, not measured optima. Re-tune after the
first month on the server; each is overridable per queue.

| option                   | default                                              | why                                                                                                                                                                                    |
| ------------------------ | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `concurrency`            | `4`                                                  | Jobs this process runs at once. Fetched as one batch of this size, with a fetch straight after a full batch. A worker with pg-boss's defaults moves **one job per second** (F2).       |
| `pollingIntervalSeconds` | `1` (min `0.5`)                                      | A user waiting for an OTP is picked up within about a second: p95 968 ms at 1 s in the tests here (F1). Below 0.5 s the polling cost buys nothing.                                     |
| `expireInSeconds`        | `900`                                                | **A ceiling on a job's run time**, not a recovery time (F4). Raise it for a long job.                                                                                                  |
| `heartbeatSeconds`       | `30` if `expireInSeconds` > 300, else off (min `10`) | With a heartbeat a dead worker is noticed in about a heartbeat instead of at the end of the lease. Without one a killed 30-minute job waits out its lease.                             |
| `retryLimit`             | `3`, **minimum `1`**                                 | A pod drain spends one attempt (F5): with none left the interrupted job goes straight to the dead-letter queue and no other worker runs it. `0` needs `acceptDeadLetterOnDrain: true`. |
| `retryDelaySeconds`      | `5`, exponential backoff                             | Covers a short provider blip without hammering it.                                                                                                                                     |
| `retryDelayMaxSeconds`   | `300`                                                | The backoff reaches the cap after about six retries.                                                                                                                                   |
| `deadLetter`             | `${queue}.dlq`, created for you                      | A terminally failed job's payload and error are copied there, for 30 days. Alert on the dead-letter queue's depth.                                                                     |

**A batch runs together** and the next fetch waits for the whole batch (this is what makes fetching
cheap). One slow job in a batch of four therefore holds the other three slots idle. Give long jobs
their own queue with a small `concurrency`.

### Retention

```ts
retention: {
  completed?: number | 'immediate', // default 7 days
  failed?: number,                  // default: follows `completed`
  deadLetter?: number,              // default 30 days
}
```

| queue                      | configuration                                                    |
| -------------------------- | ---------------------------------------------------------------- |
| most queues                | nothing: finished jobs stay 7 days, dead letters 30 days         |
| `mail.send` (ADR 0002 d.4) | `{ completed: 'immediate', failed: 86_400, deadLetter: 86_400 }` |

- **`completed: 'immediate'`** deletes the job's row the moment its handler succeeds (nothing of the
  payload remains). Because that also removes the job-id dedupe, such a handler must check its own
  idempotency store before acting (`jobs.once`, below).
- **pg-boss deletes every _finished_ job of a queue on one clock** (completed, and failed after its
  retries), so a number for `completed` and a different number for `failed` is refused with that
  explanation. Either give one (the other follows), give the same, or use `'immediate'` and set
  `failed`. The plan's "failures kept 30 days" is therefore carried by the **dead-letter copy**
  (`deadLetter`, 30 days by default), not by the original row (ADR 0001, amendment 2026-10-10).
- **`deadLetter`** is how long an unhandled dead-letter copy waits before pg-boss deletes it, and so how
  long a failed payload (possibly personal data) lingers. "Until handled" cannot be literal; **alert on
  the dead-letter queue's depth**, do not rely on this number.
- Deletion runs every **15 minutes** (pg-boss's own default is 24 hours, which would turn "at most
  24 h" into up to 48), so a retention below that is a lower bound, not a promise.

### Heartbeat, expiry, and how soon a dead worker's job comes back

Two clocks decide when a job whose worker was killed is noticed, and **both are checked by the
supervisor's monitor pass, which pg-boss claims per queue every 60 seconds**:

- without a heartbeat: after `expireInSeconds` (the lease);
- with a heartbeat (default above 300 s): after about `heartbeatSeconds` of silence.

**Add up to ~75 seconds to either** (the 60 s monitor interval plus a supervise pass). The platform
lead accepted this bound (ADR 0001, amendment 2026-10-10) and the monitor interval stays at pg-boss's
default: the same pass runs a whole-table statistics aggregate whose cost at a shorter interval is
unmeasured. In the tests here (monitor shortened to 2 s) a SIGKILLed worker's job came back in 7 s for a
4 s lease and 12 s for a 10 s heartbeat on a 20-minute lease. Neither variant ever ran a job twice
concurrently or completed it twice.

**A job is completed the moment its handler returns**, fenced to the attempt that was fetched, not when
its whole batch is done. So a deploy or a lease expiry that cuts off a slow job in a batch never
re-runs the fast jobs that had already succeeded.

### `PermanentJobError`

```ts
import { PermanentJobError } from '@quynhonsemiconductor/platform-jobs';

if (!user) throw new PermanentJobError(`user ${job.data.userId} no longer exists`);
```

Anything else a handler throws is retried (up to `retryLimit`, with backoff). A `PermanentJobError`
dead-letters the job at once: no retries to spend, no backoff to wait out. Use it for what retrying
cannot fix. `drainQueue` honours it too.

## Handlers must be idempotent: `jobs.once`

Delivery is at least once. A handler that must not repeat a **database** effect guards it:

```ts
const result = await jobs.once(db, `invoice.render:${job.id}`, async (tx) => {
  await tx.insert(invoices).values({ orderId: job.data.orderId });
});
// result.ran === false: a previous delivery already did it
```

The marker and the effect share one transaction (yours, if `db` is a transaction), inside a
**savepoint**: if the effect throws, its partial writes **and** the marker roll back even when you catch
the error and commit, so a later delivery runs it again.

> **`once` is NEVER for an external call** (an email, an HTTP request, an LLM). It holds a database
> transaction and the marker's row lock for as long as the effect runs, which PLAN §4.3 forbids, and an
> external effect cannot be made atomic with the marker anyway. An external effect needs its own claim
> ledger (claim, call with the provider's idempotency key, record the outcome), as `platform-mail` does.

`key` is global to the database: **prefix it with the queue or the domain** (`invoice.render:${job.id}`),
or two features that both use `job.id` skip each other. Markers live in `pgboss.platform_effect` for 30
days.

## Schedules

```ts
await jobs.schedule('reports.nightly', '0 2 * * *', { full: true }); // 02:00 Asia/Ho_Chi_Minh
await jobs.schedule('cleanup', '*/15 * * * *', {}, { tz: 'UTC' });
await jobs.handle('reports.nightly', handler);
```

- Registered by a **worker** only; every replica may call it, and pg-boss runs one job per tick.
- The queue is the schedule's name; give it a `handle()`.
- A tick's job is created up to ~30 s after the tick (pg-boss's cron pass runs every 30 s). Do not use
  it as a precise clock.
- A schedule you delete from code **stays registered** in `pgboss.schedule`; remove the row by hand.
- This replaces `platform-runtime`'s `ExclusiveJob` (deprecated).

## Shutdown

`JobsModule` stops the jobs in **`beforeApplicationShutdown`** and ends its pool in
`onApplicationShutdown`: work stops before the resources it uses are released (the order
`platform-runtime`'s `enableGracefulShutdown` documents, and the reason `platform-cache` quits there too).

`stop(timeoutMs)` stops fetching, waits for active jobs, then **fails what is left** (aborting each
job's `signal`). The budget is `SHUTDOWN_TIMEOUT_MS - SHUTDOWN_ENDPOINT_DELAY_MS - 3 s` in an HTTP process (17 s in a
pod with the defaults: the pod grace period minus the endpoint-removal delay, and a reserve for closing
the pool) and `SHUTDOWN_TIMEOUT_MS - 3 s` in a **worker**, which has no HTTP server and waits out no
endpoint delay (22 s). **A deploy can therefore cost a long job one retry**: it starts again on another worker (the
test "a job still running when the budget ends…"). A handler should watch `job.signal` and stop.

## Installing the schema (the migration Job)

The application role never runs DDL: `start()` as that role rejects against a missing or older schema
instead of migrating, with a message naming the fix. The **migrator** installs and upgrades it:

```ts
import { createMigratorPool } from '@quynhonsemiconductor/platform-db';
import { installJobsSchema } from '@quynhonsemiconductor/platform-jobs';

const pool = createMigratorPool(); // DATABASE_USER / DATABASE_PASSWORD of the migrator role
await installJobsSchema(pool, { appRole: 'rova_app' });
await pool.end();
```

Idempotent; run it on every release, after your own migrations. It installs or migrates the `pgboss`
schema with pg-boss's own path (no supervisor, no schedule, no queue is started), creates
`pgboss.platform_effect` for `jobs.once`, and grants the application role what it needs and no more:

```sql
GRANT USAGE ON SCHEMA pgboss TO app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pgboss TO app;
ALTER DEFAULT PRIVILEGES FOR ROLE migrator IN SCHEMA pgboss GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app;
ALTER DEFAULT PRIVILEGES FOR ROLE migrator IN SCHEMA pgboss GRANT USAGE, SELECT ON SEQUENCES TO app;
```

The test suite runs every scenario as an application role with **only** these grants, so a missing
one fails a test.

## What is fixed, and why

Not options (ADR 0001):

- `migrate: false`, `createSchema: false`: no DDL as the application role.
- **`persistQueueStats` is off, always.** It works for two days and then breaks supervision for a role
  that does not own the schema (expiry, retries and retention fail with it). Depth, failures, retries
  and dead letters come from OpenTelemetry (below).
- No `partition: true` queues (needs `CREATE` on the schema).
- `superviseIntervalSeconds: 15`: queue counts behind the depth gauge are only as fresh as this pass.
- `maintenanceIntervalSeconds: 900`: see Retention.
- pg-boss borrows `platform-db`'s pool and opens no connection of its own: verified TLS, the permanent
  per-client error listener, named errors.

## Metrics

On the platform-contract names, through `observability`'s `QueueMetrics`: **`queue.processed`**,
**`queue.failures`** (per queue, as each handler returns) and **`queue.lag_seconds`** (the age of the
oldest job that is ready to run, read at most every 10 s by a worker; `0` when nothing is ready). Handler
logs carry `queue:jobId` as the correlation id (`withJobContext`).

pg-boss adds, through OpenTelemetry and with no code from us: `pgboss.queue.jobs` (a gauge per queue and
state), `messaging.client.sent.messages`, `messaging.client.consumed.messages`,
`messaging.client.operation.duration`, `messaging.process.duration` (with `error.type` on failure). A
worker also publishes `pgboss.queue.oldest_ready_age` (seconds), which pg-boss cannot give without
`persistQueueStats` (F9). Suggested alerts: `queue.lag_seconds` above a queue's tolerance;
`pgboss.queue.jobs{state="ready"}` on any `*.dlq` queue above 0.

## Testing your code: `/testing`

```ts
import { drainQueue, runInline } from '@quynhonsemiconductor/platform-jobs/testing';

await runInline(jobs, 'invoice.render', { orderId: 'o1' }); // the handler, now, no database
await jobs.send('invoice.render', { orderId: 'o1' }, { tx });
await drainQueue(jobs, 'invoice.render'); // every READY job, through the real path
```

`runInline` needs no database and runs the registered handler once with a fresh id, `attempt: 1` and a
signal. `drainQueue` needs `jobs.start()` and a database, and runs a **real pg-boss worker** on the queue
until nothing is ready or active: the handler gets a real `AbortSignal`, a failure is stored as a worker
stores it, a `PermanentJobError` dead-letters at once, and retention and retries behave as in
production. `ROLE` does not matter for either. Jobs scheduled for later (`startAfter`, a retry's
backoff) are not ready and are left alone. It rejects with the first handler error, after the batch has
settled.

## Known limits, and not yet verified

- A batch runs together (above); a job is completed when its own handler returns, but the next fetch
  waits for the whole batch. `handle` does not take a batch handler yet.
- A deploy can consume one retry of a long job; a queue that must never retry says so and accepts
  dead-lettering on a drain.
- Dead-worker recovery adds up to ~75 s (above), accepted by the platform lead.
- pg-boss's index rebuilds (`reindex`) need ownership of the schema. As a non-owner the application role
  cannot run them; a follow-up ([#181](https://github.com/quynhonsemiconductor/app-platform/issues/181)) covers doing it from the migration Job.
- `LISTEN/NOTIFY` is off (pg-boss's pool-based transport only; unneeded at a 1 s poll).
- **Not verified here** (ADR 0001 decision 8), to check on the server before the first product depends
  on it: CloudNativePG (and a PgBouncer `Pooler` if one is ever added), a real kubelet drain, table
  growth over weeks, the Grafana Cloud dashboards over the OTLP metrics, and pg-boss's index
  rebuilds for a role that does not own the schema.
