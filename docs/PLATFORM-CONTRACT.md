# QNSC platform runtime contract

**Status:** v1.0 · derived from the packages **as merged on `main`** (2026-10-09):
`platform-db` 0.1.1 · `platform-runtime` 0.1.3 · `platform-http` 4.1.x · `platform-cache` 3.1.x ·
`observability` 0.2.x · `identity` 7.1.0 (8.0.0 pending) — plus [ADR 0001](adr/0001-job-queue.md),
[ADR 0002](adr/0002-identity-v8-better-auth.md) and [PLAN.md](PLAN.md) §4 for what is decided but not yet built.

This is the contract every QNSC service honours, whatever its language. TypeScript services get most
of it from the `@quynhonsemiconductor/*` packages; a Python (or any other) service implements the same
behaviour itself and is checked against [§17](#17-conformance-checklist). **The contract is the
behaviour, not the library**: where this document and a package disagree, that is a bug in one of them
and is fixed in the same change.

> **Reading the requirement words.** MUST / MUST NOT are conformance requirements. SHOULD is a
> requirement with a documented reason to deviate. "Reference" names where the TypeScript behaviour is
> implemented.

## Contents

1. [Process model](#1-process-model)
2. [Health](#2-health)
3. [Shutdown](#3-shutdown)
4. [Logs](#4-logs)
5. [Telemetry](#5-telemetry)
6. [Environment names](#6-environment-names)
7. [Errors and HTTP behaviour](#7-errors-and-http-behaviour)
8. [Client IP](#8-client-ip)
9. [Rate limiting and idempotency](#9-rate-limiting-and-idempotency)
10. [Database](#10-database)
11. [Cache](#11-cache)
12. [Authentication](#12-authentication)
13. [Async work](#13-async-work)
14. [Email](#14-email)
15. [AI](#15-ai)
16. [Not part of the contract](#16-not-part-of-the-contract)
17. [Conformance checklist](#17-conformance-checklist)
18. [Changing this contract](#18-changing-this-contract)

Items still waiting on a work package are marked **Pending WP-n** with what is already decided, so a
service written today does not have to guess.

---

## 1. Process model

- One image per service. The same image runs as the API and as the worker; **`ROLE=worker`** selects the
  worker. Anything else is the API. (Reference: `platform-jobs`, pending WP-7 — [§13](#13-async-work).)
- The API process MUST NOT run background handlers. It MAY enqueue work.
- One worker deployment per product, running all of that product's queues.
- Containers are `linux/amd64` and read configuration **from the environment**, plus files the
  environment points at (such as `DATABASE_SSL_CA`).

## 2. Health

| Route         | Meaning                                                                                    | Status                                                           |
| ------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `GET /livez`  | The process is running.                                                                    | `200 {"status":"ok"}`                                            |
| `GET /readyz` | The process can serve traffic: its dependencies are reachable and it is not shutting down. | `200` when every check is up, `503` when any is down or draining |

Rules:

- **`/livez` MUST NOT touch any dependency.** Liveness that checks the database restarts every replica at
  once when the database slows down. The platform's admission policy
  (`gitops/platform/policy/admission.yaml`) **rejects** a Deployment whose liveness path is anything other
  than exactly `/livez`.
- `/livez` and `/readyz` MUST be served **unprefixed** (`/livez`, never `/v1/livez`), **without
  authentication**, outside the rate limiter, and outside the OpenAPI document.
- `/readyz` MUST return `503` for the whole of the shutdown sequence ([§3](#3-shutdown)).
- Response body of `/readyz`: `{ "status": "ok"|"error", "shuttingDown": boolean, "checks": { "<name>": "up"|"down" } }`
  (while draining: `status: "error"`, `shuttingDown: true`, `checks: {}`). The cause of a failed check MUST be **logged, never returned**: the endpoint is unauthenticated and
  host or role names do not belong in it.
- All checks together MUST answer within **800 ms**. The chart leaves the readiness probe at
  Kubernetes' default 1 s `timeoutSeconds`; a hung dependency reads as that check being `down`, not as a
  probe timeout. Checks are cheap — they run every few seconds on every replica.
- Built-in checks (TypeScript): `database` (when a pool exists) and `cache` (when a cache is
  configured; `optional` mode without a URL is not checked).
- Compatibility aliases `GET /v1/healthz` (= `/livez`) and `GET /v1/readyz` (= `/readyz`) exist while
  the ECS/ALB estate does. New services SHOULD NOT add them.
- Probe, health and favicon requests MUST NOT create trace spans and MUST NOT appear in access logs
  ([§5](#5-telemetry), [§4](#4-logs)). The one list is `PROBE_PATHS`: `/livez`, `/readyz`, `/v1/readyz`,
  `/healthz`, `/v1/healthz` (plus `/favicon.ico`), matched on the whole path with the query string
  removed, never as a prefix.

Reference: `platform-runtime` `enableHealth(app, { checks? })`; `observability` `PROBE_PATHS`,
`isIgnoredRequestPath`.

## 3. Shutdown

On `SIGTERM` (and `SIGINT`) a service MUST, in this order:

1. start answering `/readyz` with `503` (the pod leaves its Service);
2. keep serving for the **endpoint-removal delay**, so requests already routed to it still land
   (`/livez` stays `200` throughout);
3. stop accepting connections and wait for in-flight requests; close idle keep-alive connections;
4. **stop work before releasing the resources the work uses**: job runners and consumers stop first,
   then database pools and cache clients are closed;
5. flush telemetry, then exit `0`.

The whole sequence is bounded. Past the deadline the process MUST exit `1` rather than wait for the
kubelet's `SIGKILL`.

| Variable                     | Default                   | Meaning                                                                                                                       |
| ---------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `SHUTDOWN_TIMEOUT_MS`        | `25000`                   | Hard deadline. MUST stay below the chart's `terminationGracePeriodSeconds` (default 30 s); raise them together.               |
| `SHUTDOWN_ENDPOINT_DELAY_MS` | `5000` in a pod, else `0` | How long to keep serving after going not-ready. "In a pod" means `KUBERNETES_SERVICE_HOST` is set. MUST be below the timeout. |

Both are integers; a malformed value or a delay at or above the deadline is a startup error.

- A service MUST NOT install its own `SIGTERM` handler alongside the shared one (a second handler runs
  `close()` immediately, with no readiness flip, no delay and no drain).
- A shutdown hook that throws MUST NOT prevent the hooks after it from running; catch and log inside
  hooks. (In NestJS a throwing hook ends the whole close sequence.)
- A job interrupted by a drain past the grace period costs that job one retry ([§13](#13-async-work)).

Reference: `platform-runtime` `enableGracefulShutdown(app)`. Resource release belongs in
`onApplicationShutdown` (pools: `platform-db`; cache: `platform-cache` ≥ 3.1.1).

## 4. Logs

- **JSON lines on stdout.** One object per line. No log files, no shipping from inside the service —
  the platform collects stdout.
- Every line MUST carry: `time`, `level`, `msg`, `service`, `env`, `version`.
  - `service` — the service name (`rova-api`, `rova-worker`); `env` — `NODE_ENV`/deployment
    environment; `version` — `SERVICE_VERSION` (the release tag, set by CI; `dev` if unset).
  - The TypeScript reference (pino) writes `time` as epoch milliseconds and `level` on pino's numeric
    scale (10 trace … 60 fatal). Another implementation SHOULD use the same representation so one
    collector pipeline parses both.
- When a span is active a line MUST carry **`trace.id`** and **`span.id`** (W3C hex ids, the dotted
  names as shown) so a log links to its trace. _(The plan drafted `trace_id`/`span_id`; the packages
  emit the dotted names and the contract follows the packages.)_
- When known, a line SHOULD carry `correlationId`, `userId`, `workspaceId`. **Background work MUST seed
  its own correlation id** (job name + random suffix, for example `daily-cleanup:8f3a…`), or its lines
  carry none. Work that started in a request carries the request's id through its payload.
- **No secrets and no personal data.** The redaction list is part of the contract and applies in every
  environment: `req.headers.authorization`, `req.headers.cookie`, `res.headers["set-cookie"]`,
  `req.headers["x-api-key"]`, `req.headers["x-csrf-token"]`, and the same headers nested inside SDK
  error objects (`err.config.headers.authorization`, `err.request.headers.authorization`), replaced by
  `[REDACTED]`. A worker has no inbound request, so its SDK errors are the realistic leak path; it uses
  the same factory as the API.
- One request-summary line per request, emitted by the application (the framework's automatic request
  logging is off, to avoid a duplicate). It carries method, URL, status code, duration, `userId`,
  `correlationId` and the client IP ([§8](#8-client-ip)). Probe paths are skipped ([§2](#2-health)).
- **Security fail-open events** carry the literal field **`securityFailOpen`** with one of `denylist`,
  `rate_limit`, `authz_epoch`, `authz_epoch_bump`. Alerts match that literal; renaming it silently
  disarms them. It is paired with the `security.fail_open` metric ([§5](#5-telemetry)).

Reference: `observability` `createLoggerOptions`, `failOpenLog`, `FAIL_OPEN_FIELD`, `withJobContext`.

## 5. Telemetry

OpenTelemetry, OTLP over HTTP, to the collector (Alloy) — usually a sidecar or node agent.

| Variable                                         | Default                 | Meaning                                                                                                     |
| ------------------------------------------------ | ----------------------- | ----------------------------------------------------------------------------------------------------------- |
| `OTEL_ENABLED`                                   | `false`                 | Must be exactly `true` to start. Off means no SDK, not a broken one.                                        |
| `OTEL_EXPORTER_OTLP_ENDPOINT`                    | `http://localhost:4318` | Base URL; traces go to `/v1/traces`.                                                                        |
| `OTEL_SERVICE_NAME`                              | the service's own name  | Worker processes use their own name (`OTEL_WORKER_SERVICE_NAME` in the reference).                          |
| `OTEL_SERVICE_NAMESPACE`                         | `qnsc`                  | Groups every product under one label for cross-product queries.                                             |
| `OTEL_SAMPLING_PROBABILITY`                      | `1.0` dev / `0.1` prod  | Head sampling, `parentbased_traceidratio`. Not a number → default plus a warning (never "drop everything"). |
| `DEPLOYMENT_ENV`                                 | `NODE_ENV`              | `deployment.environment`; `production` selects the `0.1` default.                                           |
| `SERVICE_VERSION`                                | `dev`                   | `service.version`. Set from the release tag in CI, or telemetry is unattributable.                          |
| `K8S_POD_NAME`, `K8S_NAMESPACE`, `K8S_NODE_NAME` | —                       | Downward API → `k8s.pod.name`, `k8s.namespace.name`, `k8s.node.name`; added only when non-blank.            |

- Resource attributes: `service.name`, `service.version`, `deployment.environment.name`,
  `service.namespace`, `service.instance.id` (unique per container), and the `k8s.*` above.
- The standard sampler variables (`OTEL_TRACES_SAMPLER`, `…_ARG`) are **ignored**; the table above is
  the interface. Head sampling below `1.0` drops most error traces — prefer collector-side tail
  sampling (100 % of errors and slow traces) and leave this at `1.0` where the collector does it.
- Instrumentation is on for HTTP, PostgreSQL and the cache client, **off** for filesystem, DNS, raw
  sockets and the AWS SDK (object storage is plain HTTP and is already traced).
- Telemetry MUST NOT break the request: recording a metric or span can cost a data point, never a
  response. (`observability`'s recorders catch and log once.)

**Metrics** (names are part of the contract: dashboards and alerts are built on them).

| Instrument                                                           | Kind                | Notes                                                                                          |
| -------------------------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------- |
| `http.server.requests`, `http.server.errors`, `http.server.duration` | counter / histogram | RED per route. Duration in ms; see the bucket warning in the `observability` README.           |
| `job.runs`, `job.failures`, `job.duration`, `job.unlocked_runs`      | counter / histogram | `job.unlocked_runs > 0` with more than one replica means a scheduled job ran on every replica. |
| `queue.processed`, `queue.failures`, `queue.lag_seconds`             | counter / gauge     | Lag, not throughput, reveals a consumer falling behind.                                        |
| `db.pool.in_use`, `db.pool.waiting`                                  | gauge               | Registered once; pulled on collection.                                                         |
| `security.fail_open`, `auth.login`, `authz.stale_token`              | counter             | Pairs with the `securityFailOpen` log field.                                                   |

**Labels are bounded.** Status collapses to `2xx/3xx/4xx/5xx`; method to a fixed set plus `OTHER`;
ids never appear as labels (they belong on spans and logs). Where the type system cannot enforce it,
distinct values per label are capped — `route` 500, `error_code` 200, `job` and `queue` 100 — and
further values are recorded as `__other__`. A request that matches **no route** (a scanner, a typo)
MUST be labelled with the constant **`unmatched`**, never its raw URL, or scanner traffic alone spends
the route budget. The caps are tripwires, not settings; there is deliberately no per-product override.

Reference: `observability` `startOtel` (import from the `/otel` subpath, first in `main`), `PROBE_PATHS`,
`LabelCardinalityGuard`.

---

## 6. Environment names

Names are a contract with the `qnsc-service` chart. **A rename on either side is a cross-repo break**:
change the chart and the package in the same release window. Unset means "use the default"; a
required variable that is missing is a **startup error that names the variable**.

| Group      | Variable                                                                                        | Default                  | Notes                                                                                                                                       |
| ---------- | ----------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Database   | `DATABASE_HOST`                                                                                 | — (required)             | CloudNativePG `<cluster>-rw` service                                                                                                        |
|            | `DATABASE_PORT`                                                                                 | `5432`                   |                                                                                                                                             |
|            | `DATABASE_NAME`, `DATABASE_USER`, `DATABASE_PASSWORD`                                           | — (required)             | user and password from the CNPG-generated Secret                                                                                            |
|            | `DATABASE_AUTH`                                                                                 | `password`               | only `password`; anything else (`iam`) is refused                                                                                           |
|            | `DATABASE_SSL_CA`                                                                               | — (required¹)            | **path** of the mounted CA file (`ca.crt` of the `<cluster>-ca` Secret)                                                                     |
|            | `DATABASE_SSL`                                                                                  | —                        | only `disable`, and only when `NODE_ENV` is not `production`                                                                                |
|            | `DATABASE_READ_HOST`                                                                            | —                        | CNPG `-ro` service; unset until a replica exists                                                                                            |
|            | `DB_POOL_MAX`                                                                                   | `10`                     | keep `replicas × DB_POOL_MAX` under the role's `CONNECTION LIMIT`                                                                           |
|            | `DB_POOL_IDLE_TIMEOUT_MS`, `DB_POOL_CONNECT_TIMEOUT_MS`                                         | `30000`, `5000`          |                                                                                                                                             |
| Cache      | `VALKEY_URL`                                                                                    | —                        | **Open: see [Q1](#open-questions).** Products read `REDIS_URL` today; no package reads either, the product passes the URL to `CacheModule`. |
| HTTP       | `RATE_LIMIT_MODE`                                                                               | `cache`                  | `cache` \| `edge-only` \| `disabled` ([§9](#9-rate-limiting-and-idempotency)). Unknown value = startup error                                |
|            | `IDEMPOTENCY_MODE`                                                                              | `cache`                  | `cache` \| `disabled`                                                                                                                       |
|            | `DISABLE_RATE_LIMIT`                                                                            | —                        | **deprecated** alias of `RATE_LIMIT_MODE=disabled`; ignored when `RATE_LIMIT_MODE` is set                                                   |
| Lifecycle  | `SHUTDOWN_TIMEOUT_MS`, `SHUTDOWN_ENDPOINT_DELAY_MS`                                             | `25000`, `5000` in a pod | [§3](#3-shutdown)                                                                                                                           |
|            | `ROLE`                                                                                          | —                        | `worker` runs handlers and schedules; anything else only enqueues                                                                           |
|            | `NODE_ENV`                                                                                      | `development`            | `production` turns the production guards on                                                                                                 |
| Telemetry  | `OTEL_*`, `SERVICE_VERSION`, `DEPLOYMENT_ENV`, `K8S_POD_NAME`, `K8S_NAMESPACE`, `K8S_NODE_NAME` |                          | [§5](#5-telemetry)                                                                                                                          |
| Kubernetes | `KUBERNETES_SERVICE_HOST`                                                                       | set by the kubelet       | how a process knows it is in a pod                                                                                                          |
| Mail       | `MAIL_TRANSPORT`, `MAIL_GRAPH_SENDER`, …                                                        |                          | **Pending WP-8** — [§14](#14-email)                                                                                                         |
| Storage    | `S3_*`                                                                                          |                          | Product-owned today (R2 through the S3 API); not yet a shared package. Names follow the product's existing `S3_<PURPOSE>_BUCKET` convention |
| AI         | `LITELLM_BASE_URL`, `LITELLM_API_KEY`                                                           | —                        | [§15](#15-ai)                                                                                                                               |

¹ Not needed when `DATABASE_SSL=disable`.

Rules for names a service adds:

- A product's own variables are its vocabulary and stay in its `env.schema`; this table is only what
  the **platform** reads or injects.
- Validate at startup with a multi-error message (all problems at once), not at first use.
- Load `.env` for local development **before** the telemetry bootstrap, and let a real environment
  variable always win over the file. (`platform-runtime/load-env`; a file read after the bootstrap made
  `OTEL_ENABLED=true` read as unset in production-like runs.)

## 7. Errors and HTTP behaviour

Every error response is one envelope. **Frontends branch on `code`, never on `message`.**

```json
{ "error": { "code": "VALIDATION_FAILED", "message": "…", "details": [], "correlationId": "…" } }
```

- `details` is always an array (empty when there is nothing to add). `correlationId` is the request's
  correlation id, `unknown` if none was seeded.
- Internal detail (stack traces, SQL, host names) MUST NOT reach the wire. An unhandled error is
  `500 INTERNAL_ERROR` with the message `An unexpected error occurred`; the detail is logged.
- Categories map to a fixed status, so the same condition is the same status in every product:

| Category            | Status |     | Category              | Status |
| ------------------- | ------ | --- | --------------------- | ------ |
| `NOT_FOUND`         | 404    |     | `PRECONDITION_FAILED` | 412    |
| `CONFLICT`          | 409    |     | `RATE_LIMITED`        | 429    |
| `VALIDATION_FAILED` | 422    |     | `UNAUTHORIZED`        | 401    |
| `PERMISSION_DENIED` | 403    |     | `INTERNAL`            | 500    |

- **Transport-level codes** emitted by the platform itself (a product adds its own domain codes on top,
  append-only; a code is never renamed or reused):
  `INTERNAL_ERROR`, `VALIDATION_FAILED`, `RATE_LIMITED`, `INVALID_CURSOR`, `UNAUTHORIZED`, `FORBIDDEN`,
  `NOT_FOUND`, `BAD_REQUEST`, `METHOD_NOT_ALLOWED`, `CONFLICT`, `PRECONDITION_FAILED`,
  `PAYLOAD_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE`, `SERVICE_UNAVAILABLE`.
- A status raised by the framework maps to the code of the same name above; any other status is
  `INTERNAL_ERROR`. `503` is `SERVICE_UNAVAILABLE`, which means "a dependency or optional integration is
  not available, including not configured" — it MUST NOT be reported as `INTERNAL_ERROR`, which says the
  service is broken when it is only switched off.
- Validation failures are `422` with the field-level issues in `details`.
- **Security-relevant statuses (401, 403, 429) are logged at warn** with the code and, when known, the
  user id, so anomaly detection can alert on them.
- **Pagination:** cursor pagination takes `limit` (1..100, default 50), `cursor`
  (opaque, base64url) and `sort`, and returns `{ data: [...], pageInfo: { nextCursor, hasNextPage, limit } }`.
  A malformed cursor is `422 INVALID_CURSOR`.
- **Correlation id:** a request carries one id. The request log reads `X-Correlation-Id` from the
  caller; the id is held in the request context and appears in every log line and error body for that
  request. _Seeding the context from the header, or generating an id when it is absent, is done by the
  product's middleware today — no package does it. A service SHOULD generate one when the header is
  missing; making that shared is an open question ([Q2](#open-questions))._ Background work seeds its
  own ([§4](#4-logs)).
- **Retry-safe writes:** `Idempotency-Key` on `POST`/`PUT` ([§9](#9-rate-limiting-and-idempotency)).

Reference: `platform-http` `DomainException` and subclasses, `GlobalExceptionFilter`, `HttpErrorCodes`,
`CATEGORY_HTTP_STATUS`.

## 8. Client IP

The client address is, in order:

1. `cf-connecting-ip`, if present and a literal IP address;
2. the first `x-forwarded-for` entry that is a literal IP address;
3. the socket address.

A header value that is not a literal IP is skipped, not trusted. Behind Cloudflare Tunnel the socket
address is `cloudflared`'s, and the first `x-forwarded-for` entry is whatever the client sent;
Cloudflare overwrites `cf-connecting-ip`, so a forged `x-forwarded-for` is ignored whenever it is
present.

> **Assumption.** This is authoritative only if the pods are reachable **only** through the Cloudflare
> Tunnel and the gateway behind it: no public listener, no `NodePort`. Otherwise a caller chooses its
> own address, and with it its own rate-limit bucket. The platform (not the service) guarantees this.

The same address MUST be used for the request log, rate-limit keys, the anonymous idempotency key and
authentication-library rate limits (identity v8: Better Auth is configured to read `cf-connecting-ip`).
Do not read `x-real-ip`.

Reference: `platform-http` `clientIp(req)`.

## 9. Rate limiting and idempotency

Both store their state in the cache, and both are **only as good as it**.

- **In production, a service that registers the rate-limit guard or the idempotency interceptor MUST
  fail at startup when no cache is configured**, unless it says on purpose that it does not need one:
  - `RATE_LIMIT_MODE=edge-only` — limits are enforced by Cloudflare rules only; the guard allows every
    request without touching the cache and logs a warning at startup;
  - `RATE_LIMIT_MODE=disabled` / `IDEMPOTENCY_MODE=disabled` — development and CI. In production a
    disabled limiter is a security control switched off, so it is reported as a fail-open: a startup
    warning carrying `securityFailOpen: "rate_limit"` and `security.fail_open` recorded at startup and on
    every request it lets through.
  - An unknown mode value is a startup error — a typo never silently means the default.
  - Outside production nothing changes (local development and CI run without a cache).
- A cache that exists but is **unreachable at request time fails open** (the request is allowed) and is
  reported the same two ways (`securityFailOpen: "rate_limit"`, `security.fail_open`). Recording that can
  never fail the request.
- **Algorithm:** atomic sliding-window log (server-side script), not a fixed window, so there is no burst
  at the boundary. Response headers: `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` (Unix
  seconds), and `Retry-After` (seconds) on `429`.
- **Tiers are named by intent.** The platform ships the mechanism and these defaults; which route gets
  which tier is the product's policy.

| Tier                        | Limit                                                                        |
| --------------------------- | ---------------------------------------------------------------------------- |
| `DEFAULT`                   | 100 / minute                                                                 |
| `STRICT` (sensitive writes) | 20 / minute                                                                  |
| `AUTH_LOGIN`                | 5 / 15 minutes, per IP                                                       |
| `AUTH_REFRESH`              | 30 / minute, per session (SHA-256 of the refresh cookie), falling back to IP |

- **Idempotency:** `Idempotency-Key` on `POST`/`PUT`. The first call runs and its response is stored;
  a repeat with the same key returns the stored response (it is not re-executed). The stored entry is
  scoped to user, method, URL and key; an anonymous caller is identified by a hash of client IP and
  user agent. A cache failure never fails the request.

Reference: `platform-http` `RateLimitGuard`, `IdempotencyInterceptor`, `RATE_LIMIT_TIERS`.

## 10. Database

PostgreSQL, one CloudNativePG cluster per product in production (one shared cluster with a database per
product in dev). Roles `<product>_app` and `<product>_migrator`.

- **Password auth only**, with the credentials CloudNativePG generates inside the cluster. No IAM and
  no cloud token. A rotation needs a rolling restart.
- **TLS is verified, always:** the server certificate is checked against `DATABASE_SSL_CA` **and** the
  name in `DATABASE_HOST`, so connect by the cluster service name, not a pod IP. A server presenting
  another CA or name is refused; a server that offers no TLS is refused, never downgraded. There is no
  "skip verification" setting. The one exception, `DATABASE_SSL=disable`, exists for a laptop and makes
  the process **refuse to start** under `NODE_ENV=production`.
- **Pool:** sized by `DB_POOL_MAX` (default 10). Total connections `replicas × DB_POOL_MAX` stay under
  the role's `CONNECTION LIMIT`. A dropped connection (failover, drain, switchover) MUST NOT crash the
  process: it logs a warning, the query on it fails normally, and the pool discards the client.
- **Connection failures name their cause** instead of a bare driver code: `AUTH_FAILED`,
  `TLS_UNTRUSTED_CA`, `TLS_CERT_INVALID`, `TLS_NOT_OFFERED`, `CONNECTION_LIMIT`, `CONNECT_TIMEOUT`,
  `UNREACHABLE`; a configuration problem found before connecting is a startup error naming the variable.
- **Boot:** a configuration error fails the boot; an unreachable database at boot is **logged, not
  fatal** — `/readyz` is what gates traffic.
- **Transactions:** one contract. A unit of work takes either the root database or an open transaction
  (`DbExecutor`); `withTransaction` opens one from the root and **joins** an open one (no savepoint, no
  commit of its own), and refuses transaction options when joining rather than silently running at a
  weaker isolation. **Never call an external provider (mail, HTTP, an LLM) inside a transaction.**
- **Leader locks without a cache** use a session-scoped Postgres advisory lock, taken with the
  non-blocking call; a crashed holder frees it on the server.
- **Migrations** run as a separate Job under the migrator role, never from the serving process.
- **Read replica** (`DATABASE_READ_HOST`) is optional; plain reads route to it, writes and transactions
  to the primary.
- Pooling beyond the role limit is the CNPG-managed PgBouncer `Pooler`, added only when
  `replicas × DB_POOL_MAX` approaches the limit.

Reference: `platform-db` (`createPool`, `pingDatabase`, `withAdvisoryLock`, `DbExecutor`,
`withTransaction`; Drizzle at `/drizzle`, NestJS at `/nest`).

## 11. Cache

Valkey, **one per product** in production, one shared in dev. The product's own instance: sessions and
rate-limit state are never shared across products. Keys carry a per-product prefix.

- Mode `required` (default): a missing URL is a startup error. Mode `optional`: a missing URL disables
  the cache and every operation no-ops — which is exactly why [§9](#9-rate-limiting-and-idempotency)
  refuses `optional`-without-URL in production for rate limiting and idempotency.
- The client connects eagerly and auto-pipelines commands issued in the same tick.
- **The cache is never the source of truth.** Anything in it can be lost; the database is authoritative.
  Cache invalidation is synchronous after commit and best-effort, with a TTL as the backstop.
- **Locks** are `SET NX PX` with an expiry, so a crashed holder cannot deadlock a job.
- The client is released **after** work that uses it has stopped ([§3](#3-shutdown)).
- Pub/sub is for ephemeral realtime signals only ([§13](#13-async-work)).

Reference: `platform-cache` `CacheService`.

## 12. Authentication

The platform shares the **mechanism**; **authorization** (roles, permissions, scopes, guards) is product
vocabulary and stays in the product.

- **Staff** sign in with Microsoft Entra ID (OIDC, authorization code with PKCE and single-use `state`).
  The tenant is checked (`tid` equals the configured tenant). Whether B2B guests of that tenant may sign
  in is product policy (default: no).
- **Service-to-service** calls use the internal network plus a **per-service token**. Never the staff
  login, never a shared token between services.
- Sessions for browsers are **opaque and server-side** (BFF); tokens are not handed to JavaScript.
  Refresh tokens rotate on every use with family-level theft detection: reuse of a rotated token
  revokes the family.
- Logout and offboarding are effective immediately through a denylist in the cache. **The denylist is
  a fail-open control** and is reported as such (`securityFailOpen: "denylist"`, [§4](#4-logs)).
- Login failures collapse to one response to the browser (no IdP or internal detail); the
  `auth.login` metric is where "is login itself working" is answered ([§5](#5-telemetry)).
- Passwords (where a product has them): argon2id; a login for an account that does not exist costs the
  same time as one that does.

### Current state and what is pending

|                                             | State                                                                                                                                                                                                           |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `identity` 7.1.0 (Passport/JWT, BFF, Entra) | Shipped; the products run it.                                                                                                                                                                                   |
| `identity` 8.0.0 on Better Auth             | **Pending WP-10.** ADR 0002 passed all ten spike criteria; manual checks **M1–M4** against the real QNSC tenant must pass before release, and **M6** re-runs the email-callback criterion once WP-7/WP-8 exist. |

Already decided for 8.0.0 ([ADR 0002](adr/0002-identity-v8-better-auth.md), decisions 1–6), so a
service written now can rely on them:

- SSO provider client secrets are **encrypted in the column** (AES-256-GCM, `enc:v1:` prefix = key
  version), key from `IDENTITY_ENCRYPTION_KEY`; plain text is never logged or returned.
- **Squatting:** password sign-up is refused for the staff domain(s) and any domain an organisation has
  verified for SSO; an unverified password account is replaced when a provider asserting a verified
  email signs in for the same address; unverified accounts are purged after **72 hours** by a scheduled
  job.
- Only an organisation owner/admin can register an SSO provider, and only for a verified domain.
- Reset and verification links are bearer tokens in clear in the `mail.send` job row: completed jobs are
  deleted at once, failed ones kept at most **24 hours**, reset tokens live **15 minutes**.
- Auth emails are **enqueued and never awaited**, so response time does not reveal whether an account
  exists. Enqueue is inside the sign-up transaction (the one place Better Auth runs a callback inside
  its transaction); every other email callback runs outside any transaction.
- Rate-limit counters live in the cache; the client address is [§8](#8-client-ip).

## 13. Async work

**Two mechanisms only.** Durable work goes through Postgres; ephemeral signals go through the cache.

| Mechanism              | For                                                                                                               | Guarantee                                                                                                                 |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Postgres job queue** | Anything that **must** happen: email, SMS, outbound webhooks, AI/OCR/transcode, fan-out, calls to another product | Durable; enqueued **in the business transaction** (rollback ⇒ no job); at-least-once; retries with backoff; dead-letter   |
| **Valkey pub/sub**     | Ephemeral realtime signals to browsers (SSE)                                                                      | Best-effort. The database is the source of truth; a client that reconnects resumes from `Last-Event-ID` or "unread since" |

The job table lives in the **product's own database** and is written in the same transaction, so it is
the outbox: **no `*_outbox` tables, no relay loops, no relay wake channels in new code.** No Kafka,
RabbitMQ or SQS.

**Rules (every service):**

1. **Handlers are idempotent.** Delivery is at-least-once. Check the idempotency key before the side
   effect.
2. **Never call an external provider inside an open database transaction.** Enqueue instead.
3. **The API process only enqueues.** Handlers and schedules run only when `ROLE=worker`.
4. **A drain costs the interrupted job one attempt**, so every queue allows at least one retry. A queue
   that must not retry declares it and accepts dead-lettering on a drain.
5. A user who is waiting (OTP, email verification, password reset) is still served by a job, picked up
   within about **1 s** (per-queue polling interval); the UI says "sent" and offers "resend" after 60 s.
6. Do synchronously only what the user needs **and** touches only the product's own database:

| Work                                 | Pattern                                                                                                  |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| In-app notification, few recipients  | Insert in the business transaction; publish on pub/sub after commit                                      |
| In-app notification, many recipients | One fan-out job enqueued in the transaction; the worker writes in batches                                |
| Email, SMS                           | A job, always, with an idempotency key per message                                                       |
| Outbound webhook                     | A job with retries, backoff and an HMAC signature                                                        |
| Call to another product              | A job calling its internal API                                                                           |
| LLM, OCR, embeddings, transcoding    | A job; a separate worker deployment only when resource needs differ                                      |
| PDF                                  | Synchronous only if it finishes in under ~3 s with the user waiting; otherwise a job plus a notification |
| Audit log                            | **Synchronous, in the same transaction** — it must never be lost                                         |
| Cache invalidation                   | Synchronous after commit, best-effort                                                                    |

7. **"This notification must be synchronous"** has two readings. If the user is merely waiting, see rule 5. If the business step is valid only once delivery succeeded (rare): commit state `pending_notify`,
   call the sender directly in the request with a ~5 s timeout, set `notified` on success, and on failure
   return a clear error **and** leave a retry job; the business step proceeds only from `notified`.
8. SSE routes send a heartbeat every **30 s** and the route MUST disable the gateway's request timeout.

### Pending WP-7 — `platform-jobs`

Decided in [ADR 0001](adr/0001-job-queue.md) (pg-boss; verdict PASS), not yet released:

- API: `jobs.send(queue, data, { tx, idempotencyKey, startAfter, priority })`, `jobs.handle(queue, handler, options)`,
  `jobs.schedule(name, cron, data, { tz })`. Products never import the queue library.
- **Idempotency key → job id** (not a singleton key); a duplicate key inserts nothing.
- Schedules default to `Asia/Ho_Chi_Minh`. One execution per tick across any number of workers.
- Per-queue **retention** is mandatory: defaults completed 7 days, failed 30 days, dead-letter until
  handled. `mail.send`: completed deleted immediately, failed at most 24 h — and because deleting a
  completed job also drops the job-id dedupe, its handler keeps its own idempotency store.
- Fetching is batched with burst; long jobs use a 30 s heartbeat. `retryLimit` minimum is 1.
- The app role never owns the queue schema (the migrator does); queue statistics come from telemetry
  (`queue.*`, [§5](#5-telemetry)), not from the queue's own stats table.
- One worker replica per product; alert on queue depth and oldest-job age. **No KEDA.**
- `platform-runtime`'s `ExclusiveJob` is **deprecated** in favour of schedules and is removed in the
  next major, after every product has converged.

## 14. Email

**All product email goes through Microsoft 365 (Graph `sendMail`), from one mailbox per product.** One
Entra app per product (its existing login app), limited to that mailbox by **Exchange Online RBAC for
Applications**; no tenant-wide `Mail.Send`.

- A product sends as `noreply-<product>@qnsc.vn`. Exchange limits are **per mailbox** (about 30 messages
  a minute, 10,000 recipients a day, 2,000 external recipients per 24 hours), so one mailbox per product
  gives each its own quota and isolates a sending block.
- Email is a **job**, always ([§13](#13-async-work)), with an idempotency key per message, rate-limited to
  about **20 messages a minute per sending mailbox**; a `429` is retried honouring `Retry-After`, and a
  `5xx` with backoff.
- **In-app first.** Email only for important events, with per-user preferences. **Digest batching**
  instead of one email per event (especially rova).
- **Never marketing or newsletters through M365** (Microsoft's terms; domain reputation). Marketing, if a
  product ever needs it, uses a separate transport and domain.
- **System alerts** (Proxmox, PBS, Grafana, Healthchecks) do not use product mailboxes.
- **Transports** are chosen by `MAIL_TRANSPORT`: `graph` (the only production transport) and `smtp`
  (non-production only; the process refuses to load it when `NODE_ENV=production`). Cloudflare Email
  Service and Resend are _future_ transports behind the same contract, built per product only on a
  trigger (about 1,000 external emails a day, a Microsoft sending restriction, or a marketing need).
- Templates and rendering are the product's. The platform receives finished HTML and text.
- No bounce or complaint processing yet; non-delivery reports land in each product mailbox.

### Pending WP-8 — `platform-mail`

Not yet released. Decided: an `EmailSender` contract (`send(message) → result`, message =
`to, cc?, bcc?, from?, replyTo?, subject, html, text, headers?, category, idempotencyKey`), the `graph`
and `smtp` transports, a `mail.send` queue handler on `platform-jobs`, and an in-memory sender plus a
conformance suite at `/testing`. Env names (`MAIL_TRANSPORT`, `MAIL_GRAPH_SENDER`, workload-identity
federation for the pod's service account, no stored secret) are fixed when the package lands; this
section is updated from the merged code, not from the plan. The manual check — one product's mailbox
succeeds and another product's mailbox returns `403` — is run by the owner with real credentials.

## 15. AI

Every LLM, embedding and transcription call goes through **LiteLLM**, with the **product's virtual
key**. There is no AI client library: policy is enforced at the gateway, so it covers every language.

- `LITELLM_BASE_URL` and `LITELLM_API_KEY` (the product's virtual key). Budgets, tier routing and the
  hosted-model data rule are enforced by LiteLLM per key, not by client code.
- **Model aliases** (stable names; a model behind an alias can change, the alias cannot):
  `tier-l`, `tier-s`, `tier-m`, `tier-xl` (chat tiers), `embed-e5-v1` (embeddings), `whisper-v1`
  (transcription).
- Send **`metadata.feature`** on every call, so spend is attributed to a feature.
- **Restricted data** goes only to keys and models flagged local. Never to a hosted model.
- **Changing the embedding model means a new alias** (`embed-…-v2`) **and a re-embedding plan** — never a
  silent swap, because vectors from two models are not comparable.
- TEI, Whisper, clamd and Gotenberg are plain HTTP from the product (TEI and Whisper through LiteLLM);
  there is nothing to share.

## 16. Not part of the contract

Stated so nobody looks for them here:

- Email templates, notification templates and tables, permission codes, roles, routes, DTOs, Drizzle
  tables, policy values (limits per route, schedules, TTLs). Product vocabulary — never shared
  ([ADMISSION-TEST.md](ADMISSION-TEST.md)).
- **Object storage.** Products keep their S3-API code against R2; a shared package is a P2 evaluation
  (WP-17) and storage is not part of this contract until it is measured.
- **Realtime push** implementation (pub/sub + SSE) and **resilience** helpers (retry, circuit breaker).
  Product code; WP-16 evaluates the first.
- **Python libraries.** A Python service follows this document directly; a shared Python package is
  written only when two Python services need the same code.

## 17. Conformance checklist

A service conforms when every line is true. For TypeScript services most are given by the packages;
for any other language each is the service's own to implement and demonstrate.

| #   | Requirement                                                                                                                     | How to check                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 1   | `GET /livez` is `200`, unprefixed, unauthenticated, touches no dependency                                                       | `curl` with the database stopped: still `200`                    |
| 2   | `GET /readyz` is `503` when a dependency is down, and from the first moment of shutdown                                         | stop the database; send `SIGTERM` and poll                       |
| 3   | Shutdown order: not-ready, delay, drain, stop work, release resources, flush, exit; bounded by a timeout below the grace period | `SIGTERM` under load: no dropped request; exit `0`               |
| 4   | Logs are JSON lines on stdout with `time level msg service env version`, plus `trace.id`/`span.id` under a span                 | read the stream                                                  |
| 5   | The redaction list is applied in the API **and** the worker                                                                     | log an error object holding an `Authorization` header            |
| 6   | Probe paths create no spans and no access-log lines                                                                             | tail the logs during a probe                                     |
| 7   | Telemetry via OTLP; resource attributes include `service.*`, `deployment.environment.name`, `k8s.*`                             | collector view                                                   |
| 8   | Metric labels are bounded; unmatched routes are labelled `unmatched`                                                            | request 1,000 random URLs: label count does not move             |
| 9   | Error body is the envelope; statuses follow the category table; no internal detail                                              | provoke 404, 422, 500                                            |
| 10  | Client IP follows `cf-connecting-ip` → `x-forwarded-for` → socket, literal IPs only                                             | forge `x-forwarded-for`                                          |
| 11  | In production, no cache and neither `RATE_LIMIT_MODE=edge-only` nor `disabled` ⇒ startup error                                  | boot with `NODE_ENV=production` and no URL                       |
| 12  | Database: password auth, TLS verified against the CA **and** the host name; `DATABASE_SSL=disable` refused in production        | point `DATABASE_HOST` at an IP                                   |
| 13  | A dropped database connection does not kill the process                                                                         | `pg_terminate_backend` under load                                |
| 14  | Jobs are enqueued in the business transaction; handlers are idempotent; no provider call in a transaction                       | roll back a transaction: no job; deliver a job twice: one effect |
| 15  | Email only as a job, from the product's own mailbox, within ~20 messages a minute                                               | send a burst                                                     |
| 16  | AI calls go to LiteLLM with the product's key and `metadata.feature`; restricted data only to local models                      | check the gateway's spend log                                    |

`qnsc-kb-backend` (Python) is the first non-TypeScript service measured against this list; its gaps are
tracked in an issue in that repository.

## 18. Changing this contract

- It is derived from the code. When a package changes behaviour this document describes, the same pull
  request updates this document; when the document is wrong, the fix is in whichever of the two is
  wrong.
- A **rename or removal** of an environment variable, a log field, a metric name, an error code or a
  route is a cross-repo break: it needs the chart, the dashboards and the alerts changed in the same
  release window, and a deprecation period when a running product would otherwise break.
- Additions are free. Error codes and metric names are append-only.

## Open questions

Found while deriving this document; each needs a decision from the platform lead.

- **Q1 — the cache variable.** [PLAN.md §6.14](PLAN.md) names `VALKEY_URL`; rova and opshub read
  `REDIS_URL` today; no package reads either (the product passes the URL to `CacheModule`). One name
  has to be chosen and put in the chart. This contract lists `VALKEY_URL` as _open_ until then.
- **Q2 — correlation id.** No package seeds the request context from `X-Correlation-Id` or generates an id
  when it is absent; each product does it in middleware. Worth a shared helper under the admission test
  (divergence here breaks log joining across products).
- **Q3 — `trace_id` vs `trace.id`.** The plan drafted underscores; the logger emits `trace.id` and
  `span.id`. This contract follows the code. A Python service needs the dotted names to join in one
  pipeline.
- **Q4 — `S3_*`.** The plan lists `S3_*` as a platform variable; storage is product-owned and the names
  are per product (`S3_ATTACHMENTS_BUCKET`, …). Left out of the contract until WP-17.
