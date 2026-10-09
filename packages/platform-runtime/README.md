# @quynhonsemiconductor/platform-runtime

Runtime primitives every QNSC product backend needs, and none of them should own a
private copy of.

| in this package                                                                    | in your product                                               |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `.env` loading, ordered before the OTel bootstrap                                  | your `env.schema.ts` — the variable set is product vocabulary |
| environment validation with a multi-error message                                  | your `AppConfigService` subclass (one line)                   |
| typed `ConfigService` access                                                       | your own module, if you need providers beyond config          |
| `/livez` and `/readyz`, with the database and cache checked for you                | your own readiness checks (passed in)                         |
| graceful shutdown for pod drains (`enableGracefulShutdown`)                        | nothing: delete your `SIGTERM` handler                        |
| leader-elected scheduled jobs (`ExclusiveJob`, **deprecated** for `platform-jobs`) | the jobs themselves, and their TTLs                           |
| request-arrival timing (ALB → app → handler)                                       | your logging interceptor's field names                        |

`ExclusiveJob`, `request-timing` and `load-env` were extracted from `rova` and `opshub`, which carried byte-identical copies of
`exclusive-job.service.ts` (104 lines), `request-timing.ts` (108), `load-env.ts` (35)
and `app-config.service.ts` (16). See [REUSE-ROADMAP.md](../../docs/REUSE-ROADMAP.md)
for the measurements.

## Install

```ini
# .npmrc
@quynhonsemiconductor:registry=https://npm.pkg.github.com
```

```bash
pnpm add @quynhonsemiconductor/platform-runtime
```

Peer dependencies: `@nestjs/common`, `@nestjs/config`,
`@quynhonsemiconductor/platform-cache` (**`>=3.1.1`**: from that release the client quits in
`onApplicationShutdown`, which the shutdown order below depends on), `@quynhonsemiconductor/observability`, and
`fastify` (optional — `request-timing`, `enableHealth`);
`@quynhonsemiconductor/platform-db` (optional — the `database` readiness check and the
`ExclusiveJob` Postgres lock; both switch themselves on when platform-db's `DatabaseModule` is
present).

## `load-env` — import it FIRST, from the subpath

```ts
// apps/api/src/main.ts — line 1, above the OTel bootstrap
import '@quynhonsemiconductor/platform-runtime/load-env';
import './otel';
```

**It is not exported from the package root, deliberately.** It must run before OTel's
auto-instrumentation patches `http`, `pg` and `ioredis`, and importing it through the
barrel would first load Nest — the very modules still waiting to be patched. The
subpath keeps it a leaf module whose only import is `node:process`. Its own header
records the failure that proved this: `OTEL_ENABLED=true` in `.env` read as unset,
zero exported series against a live collector, 219 with the same value exported in
the shell.

A real environment variable always wins over the file, so this is safe in every
environment rather than only locally.

## Config

The `Env` type is yours — it is your service's own variable set, so it cannot come
from here. Subclass the generic base:

```ts
// config/app-config.service.ts
import { Injectable } from '@nestjs/common';
import { TypedConfigService } from '@quynhonsemiconductor/platform-runtime';
import type { Env } from './env.schema';

@Injectable()
export class AppConfigService extends TypedConfigService<Env> {}
```

```ts
// app.module.ts
import { AppConfigModule } from '@quynhonsemiconductor/platform-runtime';
import { EnvSchema } from './config/env.schema';
import { AppConfigService } from './config/app-config.service';

@Module({
  imports: [AppConfigModule.forRoot({ schema: EnvSchema, service: AppConfigService })],
})
export class AppModule {}
```

The module is `@Global()`, matching both products' existing modules.

Need providers beyond config? Skip `AppConfigModule` and compose the validator into
your own — that function is the part worth sharing:

```ts
ConfigModule.forRoot({ isGlobal: true, validate: createEnvValidator(EnvSchema) });
```

`createEnvValidator` is typed structurally (`safeParse` + `error.issues`) rather than
against `ZodSchema`, so this package carries no zod peer dependency and pins no
consumer to a zod major. `zod@4` satisfies it as-is.

## Health and shutdown — the contract with the chart

```ts
// apps/api/src/main.ts
const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());
enableHealth(app); // /livez, /readyz (+ /v1/healthz, /v1/readyz)
enableGracefulShutdown(app); // SIGTERM / SIGINT
await app.listen(port, '0.0.0.0');
```

Call both **before** `listen()`. A worker (`createApplicationContext`) calls only
`enableGracefulShutdown`.

### `enableHealth(app, { checks? })`

| route             | answers                                                                                                                                         |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /livez`      | `200 {"status":"ok"}` while the process runs. **Touches no dependency**, and stays 200 during the endpoint-removal delay after shutdown begins. |
| `GET /readyz`     | runs the checks: `200` when all are up, `503` when any is down, **always `503` once shutdown has begun**                                        |
| `GET /v1/healthz` | same as `/livez`. Kept for the ALB target group and the Dockerfile `HEALTHCHECK` until ECS/EKS is gone                                          |
| `GET /v1/readyz`  | same as `/readyz`. rova and opshub point the chart's readiness probe here                                                                       |

`/livez` is a contract with the kubelet: `gitops/platform/policy/admission.yaml` **denies** any
Deployment whose liveness path is not exactly `/livez`, and liveness that checks the database restarts
every replica at once when it slows down.

Built in, with nothing for the product to register:

- `database` — when `@quynhonsemiconductor/platform-db/nest` provides a pool (`pingDatabase`).
- `cache` — when a Valkey URL is configured. `optional` mode with no URL is not checked.

Add your own: `enableHealth(app, { checks: { search: () => pingSearch() } })`. A check resolves when up
and throws when down; keep it cheap, it runs every 5 s on every replica.

Responses are `{ status, shuttingDown, checks: { name: 'up' | 'down' } }`. **Causes are logged, never
returned**: the endpoint is unauthenticated, and host and role names do not belong in it. All checks
share an **800 ms deadline**, because the chart leaves the readiness probe at Kubernetes' default 1 s
`timeoutSeconds`; a hung dependency reads as `down` for that check, not as a probe timeout.

**These are raw Fastify routes, not a Nest controller**, on purpose. A controller would inherit your
global prefix (`/v1/livez` is a rejected manifest), your global auth guard (401 to the kubelet unless
your own `@Public()` is applied, a name this package cannot know), your rate limiter, and your OpenAPI
document. Routes on the Fastify instance sit outside all of that. The consequence: **delete your own
`/livez`, `/readyz`, `/v1/healthz` and `/v1/readyz` handlers** or Fastify refuses the duplicate route at
startup.

### `enableGracefulShutdown(app)`

On `SIGTERM` or `SIGINT`:

1. `/readyz` starts answering 503 (the pod leaves its Service);
2. keep serving for the **endpoint-removal delay**, so requests already routed here still land;
3. stop accepting connections and wait for in-flight requests (idle keep-alive sockets are closed);
4. `app.close()` runs the close hooks: database pool, cache, job runner;
5. flush OpenTelemetry (when `OTEL_ENABLED=true`), then exit `0`.

The whole sequence is bounded: past the deadline the process exits `1` instead of waiting for the
kubelet's `SIGKILL`. `/livez` keeps answering 200 through the endpoint-removal delay; once the server
stops listening to drain, nothing answers (the pod is Terminating and no longer probed).

**Two orders, both deliberate.**

1. **HTTP drains before `app.close()`.** Nest's own `close()` runs the destroy hooks first and closes the
   HTTP server afterwards, so a bare `app.close()` tears providers down while requests still use them.
2. **Inside `app.close()`, work stops before the resources it uses are released.** Nest runs, in order:
   `onModuleDestroy` -> `beforeApplicationShutdown` -> (HTTP server) -> `onApplicationShutdown`. So a
   job runner stops in `beforeApplicationShutdown`, and the database pool (`platform-db`) and the cache
   (`platform-cache`) are released in `onApplicationShutdown`. **Do the same in your own providers**:
   stop work in `beforeApplicationShutdown`, release connections in `onApplicationShutdown`. A client
   closed in `onModuleDestroy` is gone while jobs and requests still hold it.

**A hook that throws ends Nest's close sequence**: the hooks after it do not run, so a throwing
`onModuleDestroy` leaves the pool and cache open (the process still exits `1`). Catch and log inside
hooks.

**Do not call `app.enableShutdownHooks()`.** Nest would register its own `SIGTERM` handler that runs
`app.close()` at once (no readiness flip, no delay, no drain) and then re-signals the process.
`enableGracefulShutdown()` throws at startup if the hooks are already enabled, and logs an error at
shutdown if they were enabled afterwards. Remove the call when you adopt this (opshub's worker has one
today).

| variable                     | default                        | meaning                                                                                                                                                    |
| ---------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SHUTDOWN_TIMEOUT_MS`        | `25000`                        | hard deadline. Keep it below the chart's `terminationGracePeriodSeconds` (default 30)                                                                      |
| `SHUTDOWN_ENDPOINT_DELAY_MS` | `5000` in a pod, `0` elsewhere | how long to keep serving after going not-ready. "In a pod" is `KUBERNETES_SERVICE_HOST`, which the kubelet always sets, so Ctrl-C on a laptop is immediate |

Both must be integers; a delay at or above the deadline is refused at startup. If you raise the chart's
grace period, raise `SHUTDOWN_TIMEOUT_MS` with it.

Delete your hand-written `process.on('SIGTERM', …)` handler. Keep your `unhandledRejection` and
`uncaughtException` handlers, which are yours.

## `ExclusiveJob` — scheduled work on exactly one pod (deprecated)

> **Deprecated** in favour of `platform-jobs` schedules (`jobs.schedule(name, cron, data)`), which run
> once per tick in the product's own database with retries and dead-letter. Removal is planned for the
> next major, after every product has converged. Until then it keeps working, and gains the Postgres
> fallback below.

```ts
constructor(private readonly exclusiveJob: ExclusiveJob) {}

@Cron('0 */15 * * * *')
async sweep() {
  await this.exclusiveJob.run('audit-cleanup', 14 * 60_000, () => this.doSweep());
}
```

`@Cron` and `@Interval` fire on **every replica**. With one worker task that is
invisible; the moment a rolling deploy overlaps two tasks, every job runs twice
concurrently — and these jobs delete rows and objects.

Set `lockTtlMs` just under the schedule interval: long enough that a slow run keeps
its lock, short enough that a pod killed mid-run does not block the next tick. The
lock auto-expires, so a crash cannot deadlock a job permanently.

**Without a cache, the lock moves to Postgres.** `acquireLock` returns `false` both when another pod
holds the lock and when there is no cache client at all, so treating `false` as "someone else has it"
would let a Valkey outage silently stop every scheduled job. When the cache is not available and
`platform-db` provides a pool, the job takes `withAdvisoryLock(pool, 'cron:<name>')` instead: a tick
still runs once across replicas, and a crashed holder frees the lock the moment its connection drops. If
the lock is held elsewhere the tick is skipped.

Only with **neither** a cache **nor** a database pool does it fail OPEN and run unlocked. That is
logged at **ERROR** and counted in the `job.unlocked_runs` counter (label `job`); alert on
`rate(job.unlocked_runs) > 0` in any deployment with more than one replica, where it means every
replica is running the job.
Every job behind this helper is idempotent, so running a sweep twice costs less than losing SLA-breach
detection for the length of an incident. An in-process guard still prevents this pod overlapping itself.

Known limit: if the cache is down for _one_ pod only while another still holds a cache lock, the two use
different locks and may overlap. That is narrower than before, when every pod with a flapping cache ran
unlocked.

## `request-timing` — which part of "slow" was slow

```ts
import {
  registerRequestTiming,
  arrivalAtMs,
  albReceivedAtMs,
  albWaitMs,
} from '@quynhonsemiconductor/platform-runtime';

registerRequestTiming(app.getHttpAdapter().getInstance());
```

Splits latency into three intervals with three different owners: `albWaitMs`
(proxy/network), `bodyWaitMs` (body receipt), and the handler's own duration. The ALB
receive time is decoded from `X-Amzn-Trace-Id` — no log correlation, no X-Ray, no
extra call.

`albWaitMs` is reported only above `ALB_WAIT_REPORTING_FLOOR_MS` (1000). The trace id
carries whole seconds, so the value inherits up to 1000ms of truncation error; on
real traffic it sat at a median of ~500ms, which is exactly what a request with _no_
delay looks like. A field that invites misattribution defeats instrumentation whose
whole purpose was to stop latency being misattributed.

Field naming stays in the product — these are inputs to your logging interceptor, not
a log format.

## What is deliberately NOT here

`errors/`, `http/pagination`, `http/*.interceptor`, `rate-limit/*` and
`request-context` all live in
[`@quynhonsemiconductor/platform-http`](../platform-http) already. Check there before
proposing anything HTTP-shaped.

Rate-limit thresholds, job schedules and TTLs are policy: mechanism here, values in
the product.

## Environment

| variable                     | default                        | read by                                                                        |
| ---------------------------- | ------------------------------ | ------------------------------------------------------------------------------ |
| `SHUTDOWN_TIMEOUT_MS`        | `25000`                        | `enableGracefulShutdown` — hard deadline ([above](#enablegracefulshutdownapp)) |
| `SHUTDOWN_ENDPOINT_DELAY_MS` | `5000` in a pod, `0` elsewhere | `enableGracefulShutdown` — keep serving after going not-ready                  |
| `KUBERNETES_SERVICE_HOST`    | set by the kubelet             | decides "in a pod" for the delay default                                       |
| `OTEL_ENABLED`               | `false`                        | `enableGracefulShutdown` flushes telemetry on exit only when this is `true`    |

Everything else (the variable set your service validates with `AppConfigModule`) is yours. The names
shared with the chart are listed in [PLATFORM-CONTRACT.md](../../docs/PLATFORM-CONTRACT.md) §6.

## Subpaths

| import                                            | what                                                                           |
| ------------------------------------------------- | ------------------------------------------------------------------------------ |
| `@quynhonsemiconductor/platform-runtime`          | config, health, shutdown, `ExclusiveJob` (deprecated), request timing          |
| `@quynhonsemiconductor/platform-runtime/load-env` | `.env` loading — a leaf module, import it **first**, before the OTel bootstrap |

## Testing your code

There is no `/testing` subpath. `enableHealth(app, { checks })` takes plain async functions, so a check
is unit-testable on its own; to exercise `/livez` and `/readyz` build a Nest Fastify application in the
test and call `app.inject()`. This package's own tests do that against a throwaway application.

## Known limits

- **NestJS + Fastify.** `enableHealth`, `enableGracefulShutdown` and `registerRequestTiming` take the
  Nest Fastify application (or its Fastify instance).
- **`request-timing` decodes the AWS load balancer's `X-Amzn-Trace-Id`.** Behind Cloudflare Tunnel and
  Envoy there is no such header, so the ALB fields are simply absent; the rest of the timing split
  still works. It is retained until the ECS/ALB estate is gone.
- **`/v1/healthz` and `/v1/readyz` aliases** exist only for the ALB target group and the Dockerfile
  `HEALTHCHECK`; they are removed with ECS.
- **`ExclusiveJob` is deprecated** for `platform-jobs` schedules and goes in the next major. Without a
  cache **and** a database pool it still fails open and runs unlocked (logged at ERROR, counted in
  `job.unlocked_runs`).
- Shutdown handles `SIGTERM` and `SIGINT` only. A hook that throws ends Nest's close sequence.
