# 0001. Use pg-boss as the job queue behind `platform-jobs`

- **Status:** **Accepted** (2026-10-09, platform lead) — verdict **PASS**. WP-7 builds `platform-jobs` on pg-boss with the decisions below. **Amended 2026-10-10** (see _Amendment 2026-10-10_, which supersedes the earlier text where they differ).
- **Date:** 2026-10-09
- **Work package:** WP-6 (builds WP-7; informs WP-8 and WP-9)
- **Deciders:** platform lead (`@quynhonsemiconductor/platform-infra`)

## Context

`APP-PLATFORM-PLAN.md` §4 makes Postgres + pg-boss the only mechanism for work that must happen
(email, webhooks, AI/OCR/transcode, fan-out, calls to other products): enqueued in the business
transaction, at-least-once, retried with backoff, dead-lettered. `PORTFOLIO-TECH-REVIEW.md` §2A.6
made that adoption conditional on a two-day spike over seven scenarios; WP-6 adds two more:

- a per-queue polling interval of ≤ 1 s, measured end to end (the plan promises a user who is
  waiting for an OTP "picked up within ~1 s", and WP-7 accepts p95 ≤ 1.5 s);
- enqueue inside a Drizzle transaction through the `DbExecutor` of `platform-db` (0.1.1, on `main`).

The fallback if it fails is BullMQ on a persistent Valkey plus a Postgres outbox, behind the same
`platform-jobs` API (R1).

**What was run.** `spikes/pg-boss/` (private, never published, not in the root `pnpm test`). It
uses pg-boss **12.37.0** — pinned exactly; 12.37.1 was published 2026-10-08 and the repo's pnpm
`minimumReleaseAge` refuses it until it has aged a day, so WP-7 starts from 12.37.0 or from
12.37.1 once that gate opens. The database is PostgreSQL 18 over **verified TLS** (a CA generated
per run) through `platform-db`'s `createPool`; pg-boss never opens a connection of its own.
Workers that are killed or drained are real OS processes, and "killed" means SIGKILL. Every
number below is in `spikes/pg-boss/results/*.json`, written by the runs themselves.

**Environment and its limits.** One developer machine (macOS, Docker Desktop VM, 12 CPUs), Node
24.11.1, Grafana 13.0.2. The load test's database was capped at 2 CPUs / 2 GiB. Nothing here ran
against CloudNativePG, Cloudflare Tunnel, Grafana Cloud, or a Kubernetes pod; those are listed
under _Not verified_.

## Decision

We will build `platform-jobs` (WP-7) on pg-boss, through the public API sketched below. All nine
checks passed; none needed a workaround that changes the architecture. They did surface findings (F1–F11)
that WP-7 must build in, because some pg-boss defaults are wrong for this platform (each is in
_Findings_ with the evidence). The most consequential three:

1. **A worker with pg-boss's defaults moves one job per second per queue**, whatever the polling
   interval: at 100 jobs/s the backlog grew by 99 jobs/s. Throughput is
   `batchSize × workers ÷ polling interval`, so `platform-jobs` must fetch in batches and burst.
2. **`persistQueueStats` cannot be used by a non-owner app role.** It works for two days, then
   every supervise pass fails (job expiry, retries and retention with it). Default it off; take
   metrics from OpenTelemetry.
3. **Draining a pod spends one retry.** A job interrupted by SIGTERM past the grace period is
   failed and re-queued; on a queue with `retryLimit: 0` it goes to the dead-letter queue instead.

### Results

| #   | Scenario (PASS condition)                                                                           | Result   | Evidence                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | --------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Email job enqueued in a business transaction, rolled back (no job after rollback, job after commit) | **PASS** | `01-transactional-enqueue` — 8 tests; a mutant that bypasses the transaction fails the rollback test                                                                                                                                                                                                                                                                                     |
| 2   | 30-minute transcode, worker killed (re-leased after expiry, completed once)                         | **PASS** | `02-crash-recovery` (compressed) and `bench/transcode.run.ts` (full length): 30-minute job, 45-minute lease, killed at 10 minutes: re-leased 46.0 minutes after it started (36 minutes after the kill) and completed once; with `heartbeatSeconds: 30` re-leased 56.5 s after the kill and completed once; a control job with an idle peer for its whole 30 minutes was never taken over |
| 3   | Failing job (retries with backoff, then dead-letter)                                                | **PASS** | `03-retry-dead-letter`: 4 attempts, gaps 1.5 / 2.5 / 5.5 s, dead-lettered after 10.3 s, payload and error kept, redrive works                                                                                                                                                                                                                                                            |
| 4   | Daily schedule, two replicas (exactly once per tick)                                                | **PASS** | `04-schedule-two-replicas`: 10 ticks, one job and one execution each, consecutive minutes, none skipped across a join and a SIGKILL                                                                                                                                                                                                                                                      |
| 5   | 100 jobs/s for 10 minutes (no backlog growth, database CPU comfortable)                             | **PASS** | `bench/load.run.ts`: 60 000 / 60 000 completed, backlog steady at ≈ 49 (max 98), final 0; database CPU mean 22 %, p95 27 % of one core (cap 200 %); pickup p95 938 ms                                                                                                                                                                                                                    |
| 6   | Grafana panel (depth, age, failures, dead-letter visible)                                           | **PASS** | `06-grafana-dashboard`: a real Grafana 13, read-only role, verified TLS; every panel queried through `/api/ds/query` against live queues and compared with SQL. `06b-otel-metrics` for the OpenTelemetry path                                                                                                                                                                            |
| 7   | Graceful shutdown during a pod drain (short jobs finish; long jobs resume elsewhere)                | **PASS** | `07-graceful-shutdown`: 3 of 3 short jobs finished on the draining worker; the 45 s job was handed to another worker 16.0 s after SIGTERM; the worker exited 0 within its 15 s budget                                                                                                                                                                                                    |
| A   | Polling interval ≤ 1 s, end to end (WP-6 addition)                                                  | **PASS** | `A-pickup-latency`: p95 989 ms in-process and 967 ms in a separate process at a 1 s interval; 508 ms at 0.5 s                                                                                                                                                                                                                                                                            |
| B   | Enqueue through a Drizzle transaction via `DbExecutor` (WP-6 addition)                              | **PASS** | scenario 1 uses `withTransaction` and `DbExecutor` from `platform-db/drizzle`; joins an outer transaction; accepts the root database too                                                                                                                                                                                                                                                 |

Also checked, because WP-7 promises them: enqueue idempotency (`B-enqueue-idempotency`), least
privilege (`C-least-privilege`), packaging in a CommonJS package (`D-packaging`), and the cost of
the oldest-job-age metric (`E-oldest-age-query`).

## Findings

Each finding is what the platform has to do about something, with the evidence for it.

### Throughput, polling and latency

**F1 — Pickup latency meets the promise.** On an idle queue with a 1 s polling interval, in a
separate worker process, p50 / p95 / p99 pickup was 501 / 967 / 998 ms (n = 100, `created_on` → handler first line, both stamped by the database); the in-process figure is
535 / 989 / 1 018 ms (n = 150, producer clock). The theoretical floor is a uniform wait over the interval, so p95 ≈ 0.95 × interval
and p50 ≈ 0.5 ×. At the minimum interval (0.5 s) p95 was 508 ms. WP-7's "p95 ≤ 1.5 s with a 1 s
interval" holds with 0.5 s to spare. Six polling queues cost the database about 10 transactions
per second at idle.

**F2 — The default worker is a 1-job-per-second worker.** `batchSize` defaults to 1 and a worker
sleeps the polling interval between fetches, so one worker drains one job a second. With the
defaults and 100 jobs/s offered for 30 s, 31 jobs completed and 2 969 were still waiting
(`results/scenario-5.json`, `naiveDefaults`). With `batchSize: 25`, `localConcurrency: 2`,
`burstWhenBatchFull: true` on two workers, 60 000 of 60 000 completed. `platform-jobs` must
therefore fetch `batchSize = concurrency` and enable `burstWhenBatchFull`, so that a full batch is
followed immediately by another fetch. `burstWhenReadyExceeds` is not an alternative: it reads the
cached queue count, which is as stale as the supervise interval (F5).

**F3 — Load.** At 100 jobs/s for 600 s (30 % of enqueues inside a Drizzle transaction with a
business insert, 70 % direct), the producer kept its schedule to within 114 ms, the backlog stayed
between 0 and 98 (mean 50 in the middle third, 49 in the last), and the queue drained in 0.8 s
after the producer stopped. The database used a mean 22 % of one core (p95 27 %; one 5 s sample
reached 108 %), 110 MiB, and 18 MB for the job table and its indexes after 60 000 jobs. Autovacuum
ran 11 times and left 799 dead tuples. A worker process used about 1 % of a core. 100 jobs/s is
ten times the portfolio's peak (§2A.2), so this is a margin, not a sizing.

### Reliability

**F4 — Crash recovery depends on how the lease is configured, and the cost is in the lease.** A
killed worker's job is recovered only when its lease ends. With `expireInSeconds` alone the job is
re-leased when the lease expires, counted from the start of the attempt: in the 30-minute run (lease 45 min) the job came back 46.0 minutes after it started, 36 minutes after the kill — the lease plus up to one supervise pass (default 60 s). In the compressed run (40 s job, 60 s lease) it came back 93 s after it started.
With `heartbeatSeconds` the worker proves it is alive and the job is recovered within about one to
two heartbeats of the kill: with `heartbeatSeconds: 30` the job was re-leased 56.5 s after the kill and finished 30 minutes later (full run); with `heartbeatSeconds: 10` it took 63 s (compressed run). Both are dominated by the 60 s supervise interval the runs used, so F10's 15 s setting should shorten it to roughly a heartbeat plus 15 s (an expectation; not measured). For jobs longer than a few minutes `platform-jobs`
should set `heartbeatSeconds` (30 s) and a generous `expireInSeconds`; `expireInSeconds` is a
ceiling on a job's run time, not a recovery time. Neither variant ever ran a job twice
concurrently or completed it twice (checked by a side-effect row guarded by `ON CONFLICT`).

**F5 — Shutdown spends a retry.** On SIGTERM the worker stops fetching, waits for in-flight jobs up
to the `stop({ timeout })` budget, then fails what is left with `pg-boss shut down while active`.
The three 6 s jobs finished on the draining worker. The 45 s job was failed at 15.03 s (the budget
was 15 s) and started on another worker 16.0 s after SIGTERM with `retry_count = 1`. A job that
arrived after SIGTERM went to the other worker. On a queue with `retryLimit: 0` the same
interruption **fails the job terminally and dead-letters it**, and no other worker runs it
(`retryLimit0Drain`). WP-7 must (a) give every queue a `retryLimit` of at least 1, (b) set the
`stop` timeout to the pod grace period minus the endpoint-removal delay, and (c) say in the README
that a deploy can consume one retry of a long job.

**F6 — Idempotency is not what the plan assumed.** APP-PLATFORM-PLAN §6.7 says the idempotency key
"maps to pg-boss singleton/dedup key". Measured: `singletonKey` alone does **not** dedupe on a
standard queue (two sends, two jobs); with `singletonSeconds` it dedupes only inside the time slot.
What does dedupe is the job **id**: pg-boss lets the caller choose it, `(name, id)` is the primary
key, and a second `send` with the same id returns `null` and inserts nothing — also from inside a
transaction, also while the first job is `completed` and still retained, and a concurrent
duplicate **blocks until the first transaction commits or rolls back** (it waited 1.0 s in the
test) rather than both succeeding. So `idempotencyKey` maps to a deterministic UUIDv5 of
`(queue, key)` used as the job id. The guarantee lasts as long as the row does (`deleteAfterSeconds`,
7 days by default); a handler that must never act twice (email) still needs the handler-side
guard, and the spike's `runOnce` shows the shape: a marker row written in the same transaction as
the effect, or the provider's own idempotency key.

**F7 — Schedules.** Ten consecutive one-minute ticks with two worker processes, a third joining
after tick 3 and the oldest SIGKILLed after tick 6: every tick produced exactly one job and exactly one execution (10 of 10), ticks were consecutive minutes with none skipped, and the work was shared between replicas (7 executions on one, 3 on another). A job is created by a cron pass
(every 30 s, one instance per pass) _after_ its tick, with `start_after = created_on`, so a tick's
job is created up to 30 s late, and the tick it belongs to is the minute it was created in. A
`0 2 * * *` schedule with `tz: 'Asia/Ho_Chi_Minh'` previews as 19:00 UTC the day before, as
expected. Do not use a tick's job as a precise clock.

### Operations

**F8 — Least privilege: the app role needs less than assumed, and one option breaks it.** The
migrator installs the schema by running the SQL that pg-boss exports (`getConstructionPlans`) — no
pg-boss process is needed in the migration Job — and owns it. The app role then needs, and the
whole workload (send, work, retry, dead-letter, schedule, supervise, monitor, redrive, cancel,
`createQueue` for a shared-table queue) runs with, only:

```sql
GRANT USAGE ON SCHEMA pgboss TO app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pgboss TO app;
ALTER DEFAULT PRIVILEGES FOR ROLE migrator IN SCHEMA pgboss
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app;      -- tables a later release adds
ALTER DEFAULT PRIVILEGES FOR ROLE migrator IN SCHEMA pgboss
  GRANT USAGE, SELECT ON SEQUENCES TO app;
```

with `migrate: false, createSchema: false`. Without grants `start()` rejects with `permission
denied`. Against a schema older than the code, `start()` rejects with `pg-boss database requires
migrations` instead of running DDL. The app role cannot `DROP`, `ALTER`, `TRUNCATE` or `CREATE` in
the schema. Two options need more, and must not be used by `platform-jobs`:

- `createQueue(..., { partition: true })` needs `CREATE` on the schema (`permission denied for
schema pgboss`).
- `persistQueueStats: true` **works for two days and then breaks supervision.** The install plan
  creates the `queue_stats` partitions for today and tomorrow; after that each supervise pass runs
  `CREATE TABLE … PARTITION OF` (and `DROP TABLE` for retention) as the app role. Simulating the
  day after: `permission denied for schema pgboss`; with `CREATE ON SCHEMA` granted it becomes
  `must be owner of table queue_stats`. The failure is thrown before the pass reaches job expiry,
  retries or deletion, so it is not confined to statistics. Ownership through a shared NOLOGIN owner
  role makes it work, but the partitions are then owned by whichever role created them, so a later
  migration by the migrator would fail on them. WP-7 leaves `persistQueueStats` off.

**F9 — Without `persistQueueStats` the age of the oldest job is not available — but is cheap to
compute.** `pgboss.queue.ready_oldest_seconds` stays `NULL` and the built-in gauge has no age. The
query `SELECT name, now() - min(start_after) … WHERE name = ANY($1) AND state < 'active' AND NOT
blocked AND start_after <= now() GROUP BY name` uses pg-boss's own partial index
(`job_common_i11`): an index-only scan, 0.09 ms of execution and 0.6 ms round trip on a table of
1 000 000 completed rows plus 500 waiting. Without `NOT blocked` it is a sequential scan of 35 ms
that also launches parallel workers. `observability` registers it as an observable gauge.

**F10 — Metrics are fresh only as often as the supervise pass.** The queue counts behind the
`pgboss.queue.jobs` gauge and `pgboss.queue` are refreshed by the supervise pass, whose default
interval is 60 s; setting `monitorIntervalSeconds` or `queueCacheIntervalSeconds` smaller changes
nothing (the first run of the OpenTelemetry check read 0 for seven waiting jobs). Setting
`superviseIntervalSeconds` to 2–5 s made the gauge correct within one interval. `platform-jobs`
should use 15 s: the alerts it feeds (depth and age) are minutes-scale.

**F11 — Packaging.** pg-boss is ESM-only; this repo's packages are CommonJS compiled with
`moduleResolution: node`. `require('pg-boss')` works on Node 24.11.1 with nothing on stderr. A CJS
package compiled with the repo settings emits `require("pg-boss")` and pg-boss's types resolve
(they are real types, not `any`). **Without `skipLibCheck`, pg-boss's own `.d.ts` fails to compile
under node10 resolution (5 errors)**, so `platform-jobs` must not put pg-boss types in its public
declarations — which the "products never import `pg-boss`" rule already requires. Under
`node16` resolution a CJS file importing an ESM-only package is refused by the compiler (TS1479),
so a future move to `node16` in this repo needs the packages to go ESM or dual.

### Observability

**Scenario 6, SQL path.** `grafana/pgboss-queues.dashboard.json` has six panels, each one SQL
query: ready depth, oldest ready age, terminal failures per minute, active jobs, jobs retrying now,
dead-letter queues waiting. With a PostgreSQL data source over verified TLS (`verify-ca`) as a
read-only role (which can `SELECT` but is refused `DELETE` and `UPDATE`), against live queues:
12 jobs on a queue with no worker showed as depth 12, an empty queue as 0; the oldest age read 40 s
then 50 s as time passed; five jobs that exhausted their retries showed as five terminal failures
and five waiting in the dead-letter queue; three jobs sitting between attempts showed as three
retrying. Each was compared with the same fact read from SQL. The time-series panels read
`pgboss.queue_stats`, which needs `persistQueueStats` — see F8; they are therefore usable only
where the role that runs pg-boss owns the schema (local development, or a product that accepts
that), and the table panels (retrying, dead-letter) are usable everywhere.

**Scenario 6, OpenTelemetry path — the one products use.** Grafana Cloud cannot open a connection
into a private CloudNativePG cluster, and the platform already ships telemetry as OTLP through
Alloy. pg-boss emits, with no code from us, `pgboss.queue.jobs` (a gauge per queue and per state:
deferred, ready, blocked, active, failed), `messaging.client.sent.messages`,
`messaging.client.consumed.messages`, `messaging.client.operation.duration` and
`messaging.process.duration` (with an `error.type` attribute on failures). The gauge read 7 for
seven waiting jobs; the sent counter read exactly the 14 jobs sent. What it lacks is the age (F9)
and the dead-letter count, which is `ready` on the dead-letter queue, so an alert on
`pgboss.queue.jobs{state="ready"}` for queues named `*.dlq` covers it.

## Not verified

- **Grafana Cloud panels over the OTLP metrics.** Verified: the instruments and their values at
  the SDK. Not verified: Alloy, Mimir, or a panel/alert built on them.
- **CloudNativePG, PgBouncer, a real pod drain.** The drain is a SIGTERM to a process, not a
  kubelet. `useListenNotify` (needs a session-pinned connection) was not tried and is not needed.
- **`ROLE=worker` gating, the Nest module, the shared shutdown hook** — WP-7 and WP-3 scope.
- **Full-length behaviour of scenario 4** (a real daily tick). The tick was shortened to one
  minute; timezone arithmetic was checked by preview, not by waiting a day.
- **Table bloat over weeks.** 10 minutes of load is not a month of retention.
- **pg-boss 12.37.1.** All runs used 12.37.0.

## Decisions by the platform lead (2026-10-09)

1. **`persistQueueStats`: always off.** The app role never owns the `pgboss` schema (the migrator
   role does), and one supervision mechanism is enough: queue depth, oldest-job age, failures,
   retries and dead-letter counts come from the OpenTelemetry metrics. No per-product exception.
2. **Idempotency key → job id**, not `singletonKey` (finding F6). `APP-PLATFORM-PLAN.md` §6.7 is
   updated accordingly.
3. **Per-queue retention is required.** Queues declare `retention` (completed / failed /
   dead-letter). `mail.send` deletes completed jobs immediately and keeps failed or dead-lettered jobs
   at most 24 h (identity ADR 0002 decision 4). Because deleting a completed job also removes the
   job-id dedupe, the `mail.send` handler checks its own idempotency store (key
   `purpose:userId:sha256(token)` from identity) before sending.
4. **Drain-safe retries:** the minimum `retryLimit` is 1 for every queue, because a pod drain costs
   the interrupted job one attempt (finding). A queue that truly must not retry declares it
   explicitly and accepts dead-lettering on drain.
5. **Fetching is batched with burst on** (pg-boss moves one job per second per queue by default);
   long jobs use a heartbeat (30 s) rather than relying on the lease alone.
6. **Defaults for `retryLimit`, `retryDelay`/backoff and `concurrency`** are chosen by the WP-7
   author from the findings, documented with their rationale in the package README, and overridable
   per queue. They are starting points, re-tuned after the first month on the server.
7. pg-boss types are not re-exported from `platform-jobs` (they need `skipLibCheck`).
8. Not verified here, to verify on the server before the first product depends on it: CloudNativePG
   (and a PgBouncer Pooler if one is ever added), a real kubelet drain, table growth over weeks, and
   the Grafana Cloud dashboards over the OTLP metrics.

## Amendment 2026-10-10 (WP-7 implementation and review; platform lead)

Building `platform-jobs` against pg-boss 12.37.0 showed four things the spike could not, and the
platform lead decided each. Where this section and an earlier one differ, this one governs.

1. **Retention is one clock per queue.** pg-boss deletes every _finished_ job of a queue
   (completed, and failed after its retries) on a single `deleteAfterSeconds`. So `retention.completed`
   and `retention.failed` cannot differ by number; `failed` follows `completed` (7 days by default).
   A queue that needs to keep failures longer than successes uses `completed: 'immediate'` (the row is
   deleted the moment the handler succeeds) and sets `failed`; `mail.send` does exactly that
   (`failed` 24 h). The "failures kept 30 days" intent is carried by the **dead-letter copy**, whose
   default retention is **30 days** (was 365 days in the first implementation). That also bounds how
   long a failed payload (personal data) lingers. A waiting dead-letter job is deleted at its
   `keep_until`, so "until handled" is not literal: the alert on the dead-letter queue's depth is the
   real control. This amends decision 3 and the plan's "failed 30 days".
2. **Deletion interval.** pg-boss deletes finished jobs past their retention only every
   `maintenanceIntervalSeconds`, whose default is **24 hours** ("at most 24 h" would mean up to 48).
   `platform-jobs` sets **15 minutes**. Accepted.
3. **Detecting a dead worker takes about 75 seconds plus the expiry.** Lease expiry and heartbeat
   failure are checked by the monitor pass, which pg-boss claims per queue every
   `monitorIntervalSeconds` (default 60 s); the supervise interval of F10 does not change it. A killed
   worker's job therefore comes back after its lease (or, with a heartbeat, about one heartbeat of
   silence) **plus up to ~75 s** (monitor 60 s plus a supervise pass). Measured with the monitor
   shortened: 7 s for a 4 s lease and 12 s for a 10 s heartbeat. **Accepted by the platform lead; the
   monitor interval stays at pg-boss's default**, because the same pass runs a whole-table statistics
   aggregate whose cost at a shorter interval has not been measured. This amends F4 and F10.
4. **A batch must not fail a job that already succeeded.** pg-boss settles a batch only when every
   handler in it has returned, and on a drain past the budget, or when one job outlives the batch's
   lease, it fails every job it still holds. A job that had succeeded would be retried and its side
   effect run again on every deploy that catches a long job. `platform-jobs` therefore **completes
   (or, for `'immediate'`, deletes) each job, fenced to the attempt fetched, as soon as its handler
   returns**; the later batch settle finds it settled. This amends F5.

Also decided:

- **`PermanentJobError`.** A handler that throws it sends the job straight to the dead-letter queue
  with no retries (`perJobResults: 'deadletter'`). `drainQueue` honours it.
- **Concurrency model accepted:** `batchSize = concurrency`, `localConcurrency = 1`, so at most
  `concurrency` jobs are in flight. One slow job holds its batch's other slots; long jobs get their
  own queue.
- **API additions to the sketch:** `defineQueue()` (a process that only enqueues must define the queue;
  awaited when called after `start()`), `acceptDeadLetterOnDrain` (how a queue declares it will not
  retry), `jobs.once()` and `pgboss.platform_effect` (the handler-side guard, in the one schema this
  package owns; its effect runs inside a savepoint, and it must never hold an external call),
  `installJobsSchema()` (the migration Job's step, using pg-boss's own install path under one advisory
  lock, rather than running the `getConstructionPlans` SQL).
- **Metrics** are emitted on the platform-contract names (`queue.processed`, `queue.failures`,
  `queue.lag_seconds` = age of the oldest ready job) through `observability`'s `QueueMetrics`, with
  pg-boss's own `pgboss.*` instruments and `pgboss.queue.oldest_ready_age` as extras.

## Alternatives considered

| Option                                                  | Why it was not chosen                                                                                                                                                                                   |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BullMQ on Valkey + Postgres outbox                      | The named fallback (R1). Not needed: no scenario failed. It would add a second Valkey with AOF and `noeviction` per product and a relay loop, to rebuild what pg-boss does in the business transaction. |
| Writing the queue on `FOR UPDATE SKIP LOCKED` ourselves | Retries, backoff, dead-letter, cron across replicas, heartbeats, retention and a migration path are what the spike exercised; they are the cost, not the SQL.                                           |
| graphile-worker                                         | Not evaluated. Same family; pg-boss was the decision in the review and passed.                                                                                                                          |

## Consequences

- **Good:** WP-7 proceeds as planned. The business write and its job commit or roll back together;
  there is no broker to run, back up or secure. The platform needs no new infrastructure.
- **Bad / costs:** a smaller community than BullMQ and no official dashboard (the SQL dashboard and
  OTel gauges cover it); three pg-boss defaults are wrong for us (F2, F8, F10) and WP-7 owns that;
  a deploy can cost a long job one retry (F5).
- **Follow-ups:**
  - WP-7 owner: build the API below; update APP-PLATFORM-PLAN §6.7 (idempotency maps to the job
    id, not `singletonKey`; no KEDA is already there) and §6.2 (migration Job also runs the pg-boss
    install SQL and the grants above).
  - WP-3 owner: the shutdown hook passes `stop({ graceful: true, timeout })` a budget derived from
    the pod grace period.
  - WP-8 owner: the `mail.send` handler uses the idempotency pattern in F6.
  - Platform lead: decide whether a product whose app role owns the pgboss schema may turn
    `persistQueueStats` on (F8); the default says no.

## API sketch for WP-7

Core is framework-agnostic; `/nest` adds the module. Products never import `pg-boss` (F11).

```ts
// @quynhonsemiconductor/platform-jobs
export interface JobsOptions {
  /** Pool from platform-db, dedicated and small (max 5). pg-boss never opens its own. */
  pool: Pool;
  /** From env, not an option: ROLE=worker registers handlers and runs supervise + schedules;
   *  anything else only enqueues (start() with supervise:false, schedule:false). */
}

export interface Jobs {
  /** Fails fast if the pgboss schema is missing or older than this code (migrate:false). */
  start(): Promise<void>;
  /** Graceful: stop fetching, wait up to `timeoutMs`, fail the rest. Called by the shutdown hook. */
  stop(timeoutMs: number): Promise<void>;

  send<T extends object>(
    queue: string,
    data: T,
    options?: {
      tx?: DbExecutor; // platform-db: root database or an open transaction
      idempotencyKey?: string; // → deterministic UUIDv5(queue, key) used as the job id (F6)
      startAfter?: Date | number; // seconds from now, or a date
      priority?: number;
    },
  ): Promise<string | null>; // null = duplicate key, nothing inserted

  schedule(
    name: string,
    cron: string,
    data?: object,
    options?: { tz?: string }, // default 'Asia/Ho_Chi_Minh'
  ): Promise<void>;

  /** Registers a handler. No-op unless ROLE=worker. */
  handle<T extends object>(
    queue: string,
    handler: (job: { id: string; data: T; attempt: number; signal: AbortSignal }) => Promise<void>,
    options?: {
      concurrency?: number; // default 4  → localConcurrency
      pollingIntervalSeconds?: number; // default 1, minimum 0.5
      expireInSeconds?: number; // ceiling on run time, default 900
      heartbeatSeconds?: number; // default 30 when expireInSeconds > 300 (F4)
      retryLimit?: number; // default 3, minimum 1 (F5)
      retryDelaySeconds?: number; // default 5, with backoff
      deadLetter?: string; // default `${queue}.dlq`, created for you
    },
  ): Promise<void>;
}

// Behaviour fixed by the spike, not options:
//  - fetch batchSize = concurrency, burstWhenBatchFull: true                       (F2)
//  - migrate:false, createSchema:false; persistQueueStats:false; no partition:true  (F8)
//  - superviseIntervalSeconds: 15                                                   (F10)
//  - queues are created idempotently at start, shared table, with the retention
//    defaults of §6.7: completed 7 days, failed 30 days, dead-letter kept until handled
//  - observability registers the oldest-ready-age gauge (F9) next to pgboss.queue.jobs

// @quynhonsemiconductor/platform-jobs/testing
export function drainQueue(jobs: Jobs, queue: string): Promise<void>;
export function runInline<T extends object>(jobs: Jobs, queue: string, data: T): Promise<void>;
```

The migrator step of `platform-db`/WP-2 installs the schema with `getConstructionPlans('pgboss')`
and runs the grants in F8. `platform-jobs` has no schema of its own (P6).

Open choices WP-7 must make that this spike does not settle: the exact default of `retryLimit`,
`concurrency` and `retryDelaySeconds` (above are starting points, chosen from F2 and F5, not
measured optima), and whether `handle` accepts a batch for high-throughput queues.
