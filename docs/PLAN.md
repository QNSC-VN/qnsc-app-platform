# `app-platform` — Final Plan (design, work packages, rules for executing agents)

**Status:** v1.1 — final (email decision updated 2026-10-09: all email through M365 Graph, one mailbox per product). Hand-off document for the agents that implement it.
**Date:** 2026-10-08 · **Week 0:** Monday 2026-10-05 (same calendar as `MASTER-ROADMAP.md`)
**Repository:** `app-platform/` (GitHub `quynhonsemiconductor/app-platform`), packages published to
GitHub Packages under `@quynhonsemiconductor`.

## 0. Precedence and related documents

This file is the **single source of truth for `app-platform`**. Where another document disagrees
about `app-platform`, this file wins:

| Document | What this file overrides |
|---|---|
| `APP-PLATFORM-KUBERNETES-READINESS-PLAN.md` | C1 `iam` mode (dropped), C9 timing (deferred, §6.11), C10 KEDA scaling (dropped) |
| `PORTFOLIO-TECH-REVIEW.md` §2A.5, §3.6 | KEDA row; `platform-storage` and `platform-mail` scope |
| `APP-PLATFORM-IDENTITY-V8-PLAN.md` | Nothing in the design; §5.9 email delivery uses `platform-mail` + `platform-jobs` as described in §6.7 here |
| `app-platform/docs/REUSE-ROADMAP.md` | §4–§5 sequencing (WP-0…WP-6) for future work. Its **method** (§1), **classification** (§2) and the **WP-2/WP-3 lessons** (§0.0, §0.2) remain binding |

Still binding and **not** repeated here — read them before starting the relevant work package:
`app-platform/docs/ADMISSION-TEST.md` (admission rule and promotion checklist),
`APP-PLATFORM-IDENTITY-V8-PLAN.md` (the whole identity v8 design),
`PORTFOLIO-TECH-REVIEW.md` §2A.6 (pg-boss spike scenarios),
`APP-PLATFORM-KUBERNETES-READINESS-PLAN.md` §4 (C1–C7 detail) and Appendix A (env contract with the chart).

---

## 1. Goals and non-goals

**Goals**

1. Every TypeScript product (rova, opshub, solodesk, LMS) runs correctly on the on-prem k3s
   server using shared, tested code for the parts where divergence would be a security defect or a
   cross-repo contract break: database connection, health, shutdown, client IP, telemetry, jobs,
   email transport, authentication.
2. AWS-specific code leaves the packages.
3. A platform change can never break a product silently (canary + consumer CI).
4. A new product starts correct by default (starter template).
5. Non-TypeScript services (qnsc-kb, future Python AI) follow the same runtime contract without a
   shared library.

**Non-goals**

- Sharing product vocabulary: templates, permissions, routes, DTOs, Drizzle tables, policy values.
- Sharing code that would need configuration knobs to fit several products (REUSE-ROADMAP §0.0).
- A Python library. A framework. A runtime service run by `app-platform` (packages are build-time
  dependencies only).

---

## 2. Design principles

| # | Principle | Consequence |
|---|---|---|
| P1 | **Admission test** (`ADMISSION-TEST.md`): code enters only if divergence would be a security defect or a cross-repo contract break | Inconsistency alone is not a reason |
| P2 | **Three tiers** (REUSE-ROADMAP §0.0): same code everywhere → share code; implementations must differ but behaviour must agree → share a **contract** (interface + conformance suite); product vocabulary → never share | Prefer contracts + conformance tests over parameterised code |
| P3 | **Extraction** of existing product code follows the promotion checklist (byte-identical, same edit twice, no product schema), measured with `diff -w` | No promotion on "looks reusable" |
| P4 | **New capability rule** (new in this plan): a capability that **no product has implemented yet** and that is required by the platform change (CNPG, pg-boss, Graph mail, Better Auth) may be built directly in `app-platform` when **at least two consumers are scheduled** in `MASTER-ROADMAP.md` and it passes P1. Nothing is being extracted, so the checklist in P3 does not apply; the WP-2 smell still does — **zero product-specific configuration knobs**, configuration comes from the environment only. *Policy* a plan explicitly assigns to products (for identity: enabled providers, presets, guests, origins — identity plan §5.1) is passed as typed options and is not a knob | Applies to `platform-db`, `platform-jobs`, `platform-mail`, `identity` v8 |
| P5 | **Framework-agnostic core, NestJS adapter at a subpath** for every **new** package: core exports plain functions; `/nest` exports the module. Existing packages are not refactored for this | `platform-db`, `platform-jobs`, `platform-mail` |
| P6 | **No product schema in packages.** Packages own only their own schemas (pg-boss `pgboss` schema). Product tables are passed by the product or not used | `platform-mail` has no outbox table — pg-boss is the outbox |
| P7 | **Versioning stays independent per package** (release-please, tag `<package>-v<semver>`), unchanged. Products receive **one grouped Renovate PR** for all `@quynhonsemiconductor/*` updates; peer ranges are tested in CI | No lockstep version (rejected, §9 APD-7) |
| P8 | **Nothing ships without consumer proof**: every `app-platform` PR publishes a canary and runs rova, opshub and solodesk CI against it | §6.1 |
| P9 | **Cross-language sharing happens through services and the runtime contract**, not libraries | `docs/PLATFORM-CONTRACT.md`, LiteLLM, TEI, clamd, Gotenberg |
| P10 | **Policy is enforced at the gateway, not in client libraries**, when the gateway exists: LLM budgets, tier routing and the hosted-model data rule are enforced in LiteLLM per virtual key | No `platform-ai` package (§9 APD-5) |

---

## 3. Target package map

| Package | Today | Target | Consumers |
|---|---|---|---|
| `identity` | 7.1.0 (Passport/JWT, BFF, Entra, oidc broker) | **8.0.0 on Better Auth** (identity v8 plan) | LMS, solodesk, opshub, rova |
| `observability` | 0.2.0 | + k8s attributes, one probe-path list, AWS SDK instrumentation off, sampling defaults | all TS |
| `platform-cache` | 3.1.0 | unchanged API; documented `required` mode | all TS |
| `platform-http` | 4.0.1 | + `clientIp()` (Cloudflare), rate-limit/idempotency refuse to run without cache in production | all TS |
| `platform-runtime` | 0.1.1 | + `/livez` `/readyz`, graceful shutdown, ECS assumptions removed, `ExclusiveJob` advisory-lock fallback (deprecated after P2) | all TS |
| **`platform-db`** | — | **new**: CNPG password auth, verified TLS, pool, migrator, readiness ping, advisory lock, transaction runner, replica slot; Drizzle at `/drizzle` and Nest at `/nest` | all TS |
| **`platform-jobs`** | — | **new**: pg-boss wrapper; transactional enqueue; worker-only handlers; schedules | LMS, solodesk (P1); rova, opshub (P2) |
| **`platform-mail`** | — | **new**: email **transport** only — `EmailSender` contract + `graph` (all email, one mailbox per product) and `smtp` (non-production only) transports + a `mail.send` job handler rate-limited per mailbox. Cloudflare Email Service and Resend are **future transports** behind the same contract, built only when a product hits a trigger (APD-13) | identity v8, LMS, solodesk (P1); rova, opshub (P2) |
| `testing` (private) | — | **new, not published**: workspace-internal testcontainers harness (Postgres 18, Valkey) | tests inside this repo |

Dependency graph (arrows = depends on):

```
identity ──► platform-db, platform-cache, platform-http, observability, (port) EmailSender
platform-mail ──► (optional peer) platform-jobs
platform-jobs ──► platform-db, observability
platform-db ──► observability
platform-http ──► platform-cache
platform-runtime ──► observability, platform-cache, (optional peer) platform-db
```

### 3.1 Deliberately not in `app-platform`

| Thing | Where it lives instead | Why |
|---|---|---|
| Email templates, notification templates, in-app notification tables | Product | Product vocabulary |
| LLM access rules (tiers, budgets, hosted-data rule, embedding model alias) | **LiteLLM config** (gitops) + `PLATFORM-CONTRACT.md` | One enforcement point for every language |
| clamd, Gotenberg, TEI, Whisper clients | Plain HTTP from the product; TEI/Whisper through LiteLLM | One TS consumer or none; nothing to share |
| Object storage (R2 presign, multipart) | Product (rova/opshub keep their S3-SDK code with the R2 endpoint; LMS writes its own) | `storage.service.ts` diverges 588 lines on 314 (REUSE-ROADMAP §2.4); revisit in P2 (§6.11) |
| Realtime push (Valkey pub/sub + SSE) | Product | `notification-pubsub.service.ts` 97 differing lines on 223; revisit in P2 (§6.12) |
| Resilience (retry/circuit breaker) | Product | 389 differing lines on 245 |
| Authorization (roles, permissions, guards) | Product | Never promote |
| Python equivalents | Product, following `PLATFORM-CONTRACT.md` | Write `qnsc-platform-py` only when two Python services need the same code |

---

## 4. Async, jobs and notifications — the company model

This section is normative for every product; `platform-jobs` and the starter template implement it.

### 4.1 Two mechanisms only

| Mechanism | For | Guarantee |
|---|---|---|
| **Postgres + pg-boss** (`platform-jobs`) | Anything that **must** happen: email, SMS, outbound webhooks, AI/OCR/transcode, fan-out, calls to other products | Durable; enqueued **in the business transaction** (rollback ⇒ no job); at-least-once; retries with backoff; dead-letter |
| **Valkey pub/sub** | Ephemeral realtime signals: push to browsers over SSE | Best-effort; the database is the source of truth |

pg-boss **is** the outbox: its job table lives in the product's own database and is written in the
same transaction. No `*_outbox` tables, no relay loops, no `relay:wake` channels in new code. No
Kafka, RabbitMQ or SQS. NATS JetStream only on the trigger defined in `PORTFOLIO-TECH-REVIEW.md` §2.

### 4.2 Sync or async — by kind of work

Rule: do it synchronously only when the user needs the result to continue **and** it touches only
the product's own database. External, slow, failure-prone or many-recipient work is a job.

| Work | Pattern |
|---|---|
| In-app notification, few recipients | Insert into the product's notification table **in the business transaction**; after commit, publish on Valkey for SSE |
| In-app notification, many recipients | Enqueue one fan-out job in the transaction; the worker writes in batches and publishes |
| Realtime delivery to the browser | Valkey pub/sub → SSE, after commit, best-effort; on reconnect the client resumes with `Last-Event-ID` / "unread since" |
| Email, SMS (Zalo ZNS) | Job, always. Idempotency key per message |
| Outbound webhooks | Job with retries, backoff and HMAC signature |
| Call to another product | Job calling its internal API |
| LLM, OCR, embeddings, transcoding, captions | Job; separate worker deployment only when resource needs differ (LMS ffmpeg, kb OCR) |
| PDF (Gotenberg) | Synchronous only if it completes in under ~3 s and the user is waiting; otherwise a job + notification |
| Audit log | Synchronous, **in the same transaction** — must never be lost |
| Cache invalidation | Synchronous after commit, best-effort (TTL is the backstop) |

### 4.3 "This notification must be synchronous"

1. **The user is waiting** (OTP, email verification, password reset): still a job, picked up within
   ~1 s (per-queue polling interval). UI says "sent" and offers "resend" after 60 s. For auth emails
   this is also the safer choice: the response time does not reveal whether an account exists
   (Better Auth recommends not awaiting email sending).
2. **The business step is only valid once delivery succeeded** (rare): commit state
   `pending_notify` → call `platform-mail` `send()` directly inside the request with a ~5 s timeout
   → on success set `notified`; on failure return a clear error **and** leave a retry job; the
   business step proceeds only from `notified`.

**Never** call an external provider inside an open database transaction.

### 4.4 Operational rules

- Handlers are **idempotent** (at-least-once delivery): check the idempotency key before the side effect.
- Respect provider limits: Exchange Online limits are **per mailbox** (~30 messages/minute, 10,000
  recipients/day, 2,000 external recipients/24 h under the External Recipient Rate Limit, MC787382)
  → the `mail.send` queue is rate-limited to ~20 messages/minute per mailbox; honour 429 `Retry-After`.
- **Email rules (all products):** in-app first; email only for important events, with per-user
  preferences; digest batching instead of one email per event (especially rova); **never send
  marketing or newsletters through M365** (Microsoft's terms; domain reputation). System alerts
  (Proxmox, PBS, Grafana, Healthchecks) do not use product mailboxes.
- One worker deployment per product (same image as the API, `ROLE=worker`) running all queues.
- SSE through Cloudflare Tunnel and Envoy Gateway: heartbeat every 30 s; the SSE route **must**
  disable Envoy's request timeout (gitops, §7).

---

## 5. Timeline

Weeks follow `MASTER-ROADMAP.md`. Exit criteria per work package are in §6.

```
W1      WP-1 repo foundation (toolchain, consumer CI, governance)      WP-5 testing harness
W1–W3   WP-2 platform-db · WP-3 runtime · WP-4 http + observability   (readiness C1–C7)
W2      WP-6 pg-boss spike (2 days)
W3      WP-9 Better Auth spike (1 week, identity plan §8.1)
W3–W4   WP-7 platform-jobs · WP-8 platform-mail
W4–W6   WP-10 identity 8.0.0
W5–W8   WP-11 PLATFORM-CONTRACT.md · WP-12 docs · (WP-13 starter template deferred; LMS skeleton is the reference)
W7–W16  WP-14 identity adoption: solodesk W7–W8 → opshub W9–W10 → rova W11–W12 → retire v7 W13–W16
W8+     WP-15 product convergence (P2) · WP-16 realtime evaluation · WP-17 storage evaluation
```

Product cut-overs that depend on this: opshub W4, kb W5 (no TS packages), rova W6 — each needs
WP-2, WP-3, WP-4 released and adopted first.

---

## 6. Work packages

Each work package lists **scope**, **out of scope**, **acceptance** (all must hold) and
**depends on**. One work package = one PR or a short stack of PRs.

### 6.1 WP-1 — Repository foundation (W1)

Scope:
- Toolchain: root `engines` `node >=24`, `pnpm >=11`, `packageManager` pnpm 11.x, `typescript` 6.x;
  `.nvmrc` 24; CI matrix Node 24.
- **Canary publishing:** on every PR, publish each changed package as `<version>-pr.<number>.<sha7>`
  under the npm dist-tag `pr-<number>` to GitHub Packages.
- **Consumer CI:** a workflow that, for each canary, dispatches the test/typecheck/build jobs of
  `rova`, `opshub` and `solodesk` with the canary version installed (`repository_dispatch` or a
  reusable workflow in the `ci` repo). The `app-platform` PR's required check waits for them.
  Credentials: the **existing org GitHub App** (`vars.QNSC_AUTOMATION_APP_ID`,
  `secrets.QNSC_AUTOMATION_PRIVATE_KEY`, already used by `ci/.github/workflows/platform-conformance.yml`)
  through `actions/create-github-app-token`, scoped with `repositories: rova,opshub,solodesk`.
  No personal access token.
- Governance: keep `@quynhonsemiconductor/platform-infra` as code owner (existing `CODEOWNERS`);
  add the new package paths (`packages/platform-db/`, `platform-jobs/`, `platform-mail/`,
  `platform-runtime/`, `observability/`, `testing/`); `docs/adr/` with `0000-template.md`.
- README: replace "ECS tasks" wording; list all packages; document the grouped Renovate preset
  products must use (`groupName: "app-platform"`, matching `@quynhonsemiconductor/*`).

Out of scope: lockstep versioning; changing release-please's independent tags.

Acceptance:
- `pnpm build && pnpm typecheck && pnpm test && pnpm lint` green on Node 24 / pnpm 11 / TS 6.
- A test PR produces canaries and shows three consumer results as required checks.
- A deliberately breaking change in a test PR turns at least one consumer check red.

Depends on: the org owner installing the existing automation App on `rova`, `opshub`, `solodesk`
with **Contents: read** and **Actions: write**, and making its variable/secret available to
`app-platform`.

### 6.2 WP-2 — `platform-db` (W1–W3) — readiness C1

Scope (core, framework-agnostic):
- `createPool(env)` from `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_NAME`, `DATABASE_USER`,
  `DATABASE_PASSWORD`, `DATABASE_SSL_CA` (path), `DB_POOL_MAX`, idle/connect timeouts.
- **TLS verified** (`rejectUnauthorized: true`) against `DATABASE_SSL_CA` (CNPG cluster CA).
  `DATABASE_SSL=disable` accepted **only** when `NODE_ENV !== 'production'` (local Docker); refuse to
  start otherwise.
- **Password auth only.** No IAM mode, no `@aws-sdk/rds-signer`.
- Migrator: same factory with the migrator role's credentials.
- `pingDatabase(pool)` for `/readyz`.
- `withAdvisoryLock(pool, key, fn)` using `pg_try_advisory_lock`.
- `withTransaction(db, fn)` and an exported `DbExecutor` type — the one transaction contract that
  `platform-jobs` (transactional enqueue) and `identity` v8 use.
- Optional read pool from `DATABASE_READ_HOST` (CNPG `-ro`); unused until needed.
- Pool closed on the shared shutdown hook (WP-3).
- Error messages name the cause: missing/wrong secret, CA mismatch, role `CONNECTION LIMIT`.

Subpaths: `/drizzle` (Drizzle instance factory, `withReplicas()` when a read pool exists),
`/nest` (`DatabaseModule.forRootAsync({ schema })`, injection token).

Source: start from `rova/libs/platform/src/database/*` (proven), not from opshub's (216 differing
lines on 170 — they diverged); remove AWS-specific code.

Acceptance:
- Integration tests on the `testing` harness: connects with verified TLS to a Postgres using a
  self-signed CA; fails with a named error on a wrong CA, wrong password, and connection limit.
- `withAdvisoryLock` test: two concurrent callers, exactly one runs.
- `withTransaction` + rollback test.
- Env names match readiness plan Appendix A and the `qnsc-service` chart `onprem` profile.

Depends on: WP-5.

### 6.3 WP-3 — `platform-runtime` (W1–W3) — readiness C2, C5 (jobs part), C6, C7

Scope:
- `GET /livez` (unprefixed, no dependency, excluded from OpenAPI) and `GET /readyz` with
  registered checks (database via `platform-db` when installed, cache when configured, product
  checks); `/readyz` fails during shutdown. Keep `/v1/readyz` and `/v1/healthz` aliases until the
  last ECS/EKS deployment is retired, then remove in a major.
- `enableGracefulShutdown(app)`: SIGTERM → not-ready → wait endpoint-removal delay → stop
  accepting → drain in-flight → close pools/cache/jobs → exit within the chart's grace period.
- `ExclusiveJob`: when the cache is unavailable, fall back to `withAdvisoryLock` instead of running
  unlocked. Mark `@deprecated` in favour of `platform-jobs` schedules (removal after WP-15).
- `load-env.ts`: remove ECS-only assumptions and comments.

Acceptance:
- Admission policy compatibility: a chart-rendered Deployment using the defaults passes
  `gitops/platform/policy/admission.yaml` (`/livez` liveness).
- Shutdown test: in-flight request completes; `/readyz` returns 503 during drain; process exits
  before the grace period.
- ExclusiveJob test with no cache: two instances, one run per tick.

Depends on: WP-2 (optional peer).

### 6.4 WP-4 — `platform-http` + `observability` (W1–W3) — readiness C3, C4, C5, C7

Scope:
- `platform-http`: `clientIp(req)` = `cf-connecting-ip` → first `x-forwarded-for` → socket; used by
  request logging and rate-limit keys. Rate limiting and idempotency **fail at startup** in
  production when no cache is configured, unless the product opts into `rateLimit: 'edge-only'`.
- `observability`: one exported `PROBE_PATHS` list used by tracing ignore and request-log skip;
  `k8s.pod.name`, `k8s.namespace.name`, `k8s.node.name` from `K8S_*` env (downward API);
  **disable `@opentelemetry/instrumentation-aws-sdk`**; default trace sampling
  `parentbased_traceidratio` 0.1 in production (env-overridable) and a guard against
  high-cardinality metric labels — to fit the Grafana Cloud free tier.
- **`FAIL_OPEN_FIELD` contract moves from CloudWatch to Grafana:** the literal stays unchanged; add a
  Grafana alert rule (gitops) that matches it, replacing the CloudWatch metric filter.

Acceptance:
- Unit tests for `clientIp` (all three sources, spoofed `x-forwarded-for` ignored when
  `cf-connecting-ip` is present).
- Startup refuses in production without cache; starts with `edge-only`.
- No `aws` instrumentation in the default instrumentations list.

Follow-up, **done (2026-10-10, #178)**: `platform-http` seeds the request context from
`X-Correlation-Id` and generates an id when it is absent (`enableCorrelationId`), so the products' own
middleware can go (Q6). opshub first has to point its context at `observability`'s store.

Depends on: none.

### 6.5 WP-5 — internal `testing` package (W1)

Scope: private workspace package (`"private": true`, never published): testcontainers helpers for
PostgreSQL 18 (with a self-signed CA option for WP-2) and Valkey; database reset helpers.

Acceptance: used by WP-2 and WP-7 tests; CI runs them (Docker available on GitHub-hosted runners).

### 6.6 WP-6 — pg-boss spike (W2, 2 days)

Run the seven scenarios in `PORTFOLIO-TECH-REVIEW.md` §2A.6 plus: per-queue polling interval of
≤1 s measured end-to-end; enqueue through a Drizzle transaction via the `DbExecutor` from WP-2.
Pass → WP-7 builds on pg-boss. Fail → WP-7 builds the **same public API** on BullMQ + a Postgres
outbox. Record the result as an ADR.

### 6.7 WP-7 — `platform-jobs` (W3–W4)

Scope (core + `/nest`):
- One pg-boss instance per process on a small dedicated pool from `platform-db`; schema `pgboss`
  created by the migrator role; explicit grants for the app role.
- `jobs.send(queue, data, { tx, idempotencyKey, startAfter, priority })` — transactional enqueue
  through `DbExecutor`; idempotency key maps to the pg-boss **job id** (ADR 0001 decision 2; not `singletonKey`).
- `@JobHandler(queue, { concurrency, pollingIntervalSeconds, expireInSeconds, retryLimit, retryBackoff, deadLetter })`
  — handlers register **only when `ROLE=worker`**; the API process can only enqueue.
- `jobs.schedule(name, cron, data, { tz: 'Asia/Ho_Chi_Minh' })` — singleton schedules replacing
  `ExclusiveJob`.
- Retention defaults: completed 7 days, failed 30 days, dead-letter until handled — **overridable per queue** (ADR 0001 decision 3; `mail.send`: completed deleted immediately, failed ≤ 24 h).
- Metrics through `observability`: queue depth, oldest job age, failures, retries, dead-letter count.
  **No KEDA**: workers are one replica; alert on depth and age.
- Graceful stop on the shared shutdown hook.
- `/testing` subpath: drain-queue and run-handler-inline helpers for product tests.
- Swap point: products never import `pg-boss` directly (lint rule in the starter, §6.13).

Acceptance:
- Rollback test: enqueue inside a transaction that rolls back ⇒ no job.
- Crash test: worker killed mid-job ⇒ job retried after expiry; handler idempotency helper prevents
  a double side effect.
- Schedule test: two worker processes ⇒ one execution per tick.
- Latency test: p95 pickup ≤ 1.5 s with a 1 s polling interval.
- Consumer CI green; LMS dev environment uses it (S4).

Depends on: WP-2, WP-5, WP-6.

### 6.8 WP-8 — `platform-mail` (W3–W4)

Scope — **transport only** (P2 tier 2: shared contract, shared new transports):
- `EmailSender` interface: `send(message: EmailMessage): Promise<SendResult>`;
  `EmailMessage = { to, cc?, bcc?, from?, replyTo?, subject, html, text, headers?, category, idempotencyKey }`.
  Rendering is the product's job — the package receives finished HTML/text.
- Transports selected by `MAIL_TRANSPORT`:
  - `graph` — Microsoft Graph `sendMail` for **all** of a product's email (staff, vendors and
    public users). The sender is the product's own shared mailbox, taken from env
    (`MAIL_GRAPH_SENDER`, e.g. `noreply-academy@qnsc.vn`; §11 Q4); app-only token from Entra
    **workload identity federation** for the product's Kubernetes ServiceAccount (no stored secret;
    `@azure/identity`). Each product uses its **one existing Entra app** (the same app as its staff login), limited
    to its own mailbox with **Exchange Online RBAC for Applications** (management scope on that
    mailbox's PrimarySmtpAddress, role "Application Mail.Send"); no tenant-wide Graph `Mail.Send`
    grant. Handles 429 + `Retry-After`. One app per product covers staff login, mail and any
    other Graph calls (opshub's `GraphClientService`); the login flow may keep its client secret,
    while the pod's mail and Graph calls use the federated credential. A product without an Entra
    app (LMS) gets one, used for both its staff login and its mail.
  - `smtp` — **non-production only** (Mailpit locally); refuses to load when
    `NODE_ENV === 'production'`.
  - **Future transports, not built now:** `cloudflare` (Cloudflare Email Service on `mail.qnsc.vn`)
    and `resend`, behind the same `EmailSender` contract, built only when a product hits a trigger
    (APD-13) and switched for that product by `MAIL_TRANSPORT`.
- `registerMailJobs(jobs)` — optional: a `mail.send` queue handler (rate-limited to ~20
  messages/minute per sender mailbox, retry with backoff honouring 429 `Retry-After`, idempotency
  check) so products call `mail.enqueue(message, { tx })`.
- `send()` remains callable directly for the §4.3 case 2 pattern.
- `identity` v8 `EmailSender` port is satisfied by this package (WP-10).
- `/testing` subpath: in-memory sender + a conformance suite for any `EmailSender`.

Out of scope: templates; bounce/complaint processing (non-delivery reports land in each product
mailbox — later ADR); SES; the `cloudflare` and `resend` transports (built only on a per-product
trigger, §10 R8, APD-13).

Acceptance:
- Conformance suite passes for `graph` (against recorded/mocked HTTP, including 429
  `Retry-After`) and in-memory.
- `smtp` transport refuses to start in production.
- Enqueue-in-rollback ⇒ no email; duplicate idempotency key ⇒ one email.
- Manual check from the dev environment: with one product's app, sending from that product's
  mailbox succeeds and sending from another product's mailbox returns 403.

Depends on: WP-7 (optional peer), Entra federation spike (`MASTER-ROADMAP.md` W2, stream S1).

### 6.9 WP-9 — Better Auth spike (W3)

Exactly as `APP-PLATFORM-IDENTITY-V8-PLAN.md` §8.1, including criteria 9 (email callback inside
the transaction / idempotent enqueue — now through WP-7/WP-8) and 10 (`cf-connecting-ip` through
Better Auth's IP-header option — now `clientIp` from WP-4). Pass → WP-10. Fail → option C of that
plan. Record as an ADR.

### 6.10 WP-10 — `identity` 8.0.0 (W4–W6)

Exactly as the identity v8 plan §5 and §8.2, with these bindings to this plan:
- Database and transactions through `platform-db` (`DbExecutor`, `/drizzle`).
- Email through the `EmailSender` port satisfied by `platform-mail`; auth emails are **enqueued, not
  awaited** (§4.3 case 1).
- Client IP through `platform-http` `clientIp`.
- Conformance kit covers every secure default (identity plan §5.4).
- `MIGRATION-v7-to-v8.md`.

Acceptance: identity plan §9.1 security review done; conformance suite green; the reference
consumer boot test (`reference-consumer.spec.ts` pattern) passes; consumer CI green on LMS and
solodesk branches.

### 6.11 WP-17 (evaluation, P2) — object storage

P1 decision: **no package.** rova and opshub keep their storage code and switch the S3 endpoint to
R2 through env (`S3_ENDPOINT`, `S3_REGION=auto`, path-style). LMS writes its own presign
(PUT/GET and **multipart** for video) in its repo.

P2: measure LMS vs rova vs opshub with the REUSE-ROADMAP §1 method. Promote only the parts that
pass P1/P3 — expected candidate: a small presign primitive enforcing size, content type and key
prefix (a security property), with zero product knobs.

### 6.12 WP-16 (evaluation, P2) — realtime (Valkey pub/sub + SSE)

P1 decision: **no package.** Products keep their pub/sub + SSE code; new products copy the starter
template's version.

P2: measure the three implementations. Promote a `platform-realtime` package only for the parts
where divergence is a security defect — authenticated SSE endpoint, per-user/tenant channel
isolation, `Last-Event-ID` resume, heartbeat — and only if the result has zero product knobs.
Notification tables and templates stay in products regardless.

### 6.13 WP-13 — starter template `qnsc-service-starter` (deferred)

**Deferred.** The LMS is the only new product in the plan horizon, so a template would have one
consumer. Instead the **LMS backend skeleton is built to this specification first** and serves as the
reference. Create the template repository (owner approval needed) **when the next new product or
internal service is approved**, by extracting it from the LMS skeleton. Specification:
- NestJS 11 + Fastify 5 + Drizzle + Zod 4, Node 24, pnpm 11, TS 6; one image, `ROLE=api|worker`.
- All packages wired: `platform-runtime` (health, shutdown), `platform-http`, `observability`,
  `platform-cache`, `platform-db`, `platform-jobs` (worker + one example job enqueued in a
  transaction), `platform-mail`, `identity` v8.
- Example in-app notification (insert in transaction + Valkey publish + SSE endpoint with heartbeat).
- ESLint `no-restricted-imports` for `pg-boss`, `better-auth`, `pg`, `ioredis` outside `app-platform`.
- Dockerfile (amd64), GitHub Actions (build, test, GHCR push, `bump-gitops-tag`), Renovate preset
  with the `app-platform` group.
- `gitops/values/<product>/{base,dev,prod}.yaml` skeleton for the `onprem` profile (CNPG, Valkey,
  R2 bucket, Access app, SSE route timeout).
- `docker-compose.dev.yml` with Postgres 18, Valkey, Mailpit.

Acceptance (applies to the LMS skeleton now, to the template later): builds, passes tests, and
deploys to the dev namespace with `/livez`, `/readyz`, a job round-trip and an SSE message verified.

### 6.14 WP-11 — `docs/PLATFORM-CONTRACT.md` (W5–W6)

Language-neutral runtime contract, normative for TS and Python services:
- Health: `/livez` (no dependency), `/readyz` (dependencies; 503 while draining).
- Shutdown: SIGTERM → not-ready → drain → close → exit within the grace period.
- Logs: JSON lines to stdout; required fields (`time`, `level`, `msg`, `service`, `env`, `version`, and
  `trace.id` / `span.id` under an active span — dotted names, as the logger emits them; Q7); no secrets
  or personal data.
- Telemetry: OpenTelemetry OTLP to the Alloy endpoint; resource attributes including `k8s.*`.
- Environment names: `DATABASE_*`, `REDIS_URL` (the cache; the name the products and the chart already
  use — Q5), `MAIL_*`, `LITELLM_BASE_URL`, `LITELLM_API_KEY`, `K8S_*`. `S3_*` is product-owned and stays
  out of the contract until WP-17 (Q8).
- Errors: the `platform-http` error envelope and code taxonomy (frontends branch on codes).
- Client IP: `cf-connecting-ip` first.
- Auth: staff via Entra (OIDC); service-to-service via internal network + per-service token.
- Async: §4 of this plan (jobs vs pub/sub, idempotent handlers, no provider call inside a transaction).
- **Email:** all product email through `platform-mail` (Graph from the product's own mailbox); in-app
  first, email only for important events with per-user preferences; digest batching instead of one
  email per event; `mail.send` rate-limited to ~20 messages/minute per mailbox; never marketing or
  newsletters through M365.
- **AI:** every LLM/embedding/transcription call goes through LiteLLM with the product's virtual
  key; model aliases `tier-l`, `tier-s`, `tier-m`, `tier-xl`, `embed-e5-v1`, `whisper-v1`; send
  `metadata.feature` for spend attribution; restricted data only to keys/models flagged local.
  Changing the embedding model means a new alias (`embed-…-v2`) and a re-embedding plan — never a
  silent swap.

Acceptance: reviewed by the platform lead; qnsc-kb has an issue listing its gaps against it.

### 6.15 WP-12 — documentation updates (W5–W6)

- `ADMISSION-TEST.md`: add P4 (new capability rule) and P5/P6; replace the CloudWatch example with
  the Grafana alert; keep everything else.
- `REUSE-ROADMAP.md`: status banner "§4–§5 superseded by `APP-PLATFORM-PLAN.md` (2026-10-08)";
  keep §0–§2 as the method.
- Every package README: purpose, env contract, subpaths, testing helpers, known limits.
- Move this plan into `app-platform/docs/PLAN.md` once WP-1 lands, leaving a pointer here.

### 6.16 WP-14 — `identity` v8 adoption (W7–W16)

Order and windows from `MASTER-ROADMAP.md`: LMS from the start; solodesk W7–W8; opshub W9–W10;
rova W11–W12; 30-day window; retire v7 W13–W16 (remove 7.x from the release config, archive
`MIGRATION` notes).

### 6.17 WP-15 — product convergence (P2, W8+)

Per product (rova, opshub; solodesk is collapsed earlier per its own plan):

| Step | Detail |
|---|---|
| Database | `libs/platform/src/database` → `platform-db` |
| Health/shutdown/config | Delete copied health controllers, shutdown handlers, `load-env`/config copies (REUSE-ROADMAP §2.2 "promote now" list) |
| Jobs | Outbox relays (`AbstractOutboxRelay`, `notification_outbox`, email outbox, `relay:wake`) → `platform-jobs`; drain then drop the outbox tables; `ExclusiveJob` → schedules |
| Email | Providers (SES, Resend) → `platform-mail` `graph` from the product's own mailbox; templates stay |
| AWS | Delete `rova/libs/platform/src/aws` and every `@aws-sdk/*` dependency |
| HTTP | Converge forked rate-limit, idempotency and logging onto `platform-http` (REUSE-ROADMAP §2.4 items in order) |

Acceptance per product: no `@aws-sdk/*` dependency; no outbox table; consumer CI green; one week in
production without regressions.

After WP-15: remove `ExclusiveJob` in the next `platform-runtime` major.

---

## 7. Work outside `app-platform` that this plan needs

| Repository | Item | When |
|---|---|---|
| `gitops` | `onprem` chart profile env names match WP-2/WP-11; SSE routes disable Envoy request timeout (BackendTrafficPolicy / HTTPRoute timeouts); Grafana alert for `FAIL_OPEN_FIELD`; LiteLLM config with aliases, per-key budgets and the local-only flag | W2–W4 |
| `ci` | Reusable "consumer test against canary" workflow (WP-1) | W1 |
| Products | Renovate preset with the `app-platform` group; R2 endpoint env for storage | W1–W4 |
| `infra` | Entra federated credentials for Graph and Key Vault used by WP-8 | W2 |
| `infra` | Mail (table in §11 Q4): five shared mailboxes, each product's existing Entra app (one per product; created only where missing), five Exchange Online management scopes and "Application Mail.Send" role assignments (PowerShell runbook), five federated credentials (one per product ServiceAccount) | W2–W3 |

---

## 8. Rules for executing agents

1. **Read before writing:** `ADMISSION-TEST.md`, `REUSE-ROADMAP.md` §0–§2, the package's README,
   and the plan sections referenced by the work package.
2. **Branch per work package** from `main`; never commit to `main` directly.
3. **Conventional Commits** (`feat(platform-db): …`, `fix(identity): …`); release-please derives
   versions. **Do not add AI attribution lines** (`Co-Authored-By`, "Generated with …") to commits
   or PR descriptions.
4. **Before opening a PR:** `pnpm build && pnpm typecheck && pnpm test && pnpm lint` green; consumer
   CI green once WP-1 exists.
5. **Breaking changes** only in a major, with a `MIGRATION.md` section and a consumer PR prepared.
6. **Measure before promoting** existing product code (`diff -w`, REUSE-ROADMAP §1). Never extract
   on resemblance.
7. **No product configuration knobs** in new packages. If one seems necessary, stop and write an ADR.
8. **Do not merge release PRs** of `rova` or `opshub` (they deploy on merge) unless the owner names
   the PR explicitly. Do not merge `app-platform` release PRs without owner approval.
9. **No secrets** in code, tests, fixtures or docs. Credentials come from env; tests use generated
   ones.
10. **When a spike fails or an acceptance criterion cannot be met,** stop, record the finding in an
    ADR and report — do not redesign silently.

---

## 9. Decisions (with what was rejected)

| # | Decision | Rejected | Why |
|---|---|---|---|
| APD-1 | Keep `app-platform`; TypeScript-only | Each product implements its own | rova/opshub already forked and drifted; auth/TLS/health are security- and contract-critical |
| APD-2 | Many small packages in one repo | One mega-package; one monorepo with products | Mega-package forces `better-auth`/`pg-boss` on everyone; products have separate release cadences |
| APD-3 | `platform-db` password-only | Keep IAM legacy mode | AWS removed entirely; dead code and dependency |
| APD-4 | `platform-jobs` without KEDA | KEDA PostgreSQL scaler | KEDA dropped from the platform; one worker replica + alerts |
| APD-5 | No `platform-ai`; rules in LiteLLM + contract | A TS client package | Enforcement at the gateway covers Python too; client shapes diverge (opshub service vs solodesk agent) |
| APD-6 | `platform-mail` = transport + contract only | Extract rova/opshub email subsystem | Measured: only 1 of 9 files duplicated (REUSE-ROADMAP §0.2); the Graph transport is new code for everyone |
| APD-7 | Independent versions + grouped Renovate + consumer CI | Lockstep versioning | Keeps the repo's tf-modules model; identity can take a major without forcing others; the compatibility risk is covered by consumer CI |
| APD-8 | Storage and realtime stay in products until measured in P2 | Packages in P1 | Measured divergence (588/314, 97/223); LMS would be a first-consumer promotion |
| APD-9 | pg-boss is the outbox; Valkey pub/sub only for ephemeral signals | Outbox tables + relays; a broker | One durable mechanism in the product's own database; nothing extra to run or back up |
| APD-10 | Framework-agnostic core + `/nest` for new packages | Nest-only | Scripts, workers and a future framework can reuse; NestJS majors decouple |
| APD-11 | Canary + consumer CI before merge | Publish then discover | The largest maintenance risk is breaking a product silently |
| APD-12 | Starter template **deferred**; LMS skeleton is the reference | Template now | Only one new product (LMS) in the horizon — a template now would be a first-consumer promotion |
| APD-13 | **All email through M365 Graph, one mailbox and one app per product** (`noreply-<product>@qnsc.vn`, the product's one Entra app (its existing login app), limited to its mailbox with Exchange Online RBAC for Applications; §11 Q4). Upgrade path per product: Cloudflare Email Service (`mail.qnsc.vn`), Resend second, when that product exceeds ~1,000 external emails/day, is sending-restricted by Microsoft, or needs marketing email (2026-10-09; supersedes the 2026-10-08 Cloudflare split) | Azure Communication Services Email; Cloudflare Email Service now; Amazon SES | ACS — being retired (no new customers from 2026-10-23, removed 2028-09-30); Cloudflare Email Service now — public beta, an extra vendor and a stored API token, unnecessary at current volume (kept as the per-product upgrade path); SES — AWS removed. M365 Business Standard is already paid ($0 extra), generally available and federated (no secret). Exchange Online limits are per mailbox (~30 messages/minute, 10,000 recipients/day, 2,000 external recipients/24 h — MC787382), so one mailbox per product gives each its own quota and isolates a sending block; expected volume is tens to a few hundred messages/day per product |

---

## 10. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | pg-boss spike fails | Same API on BullMQ + outbox (WP-6) |
| R2 | Better Auth spike fails | Option C in the identity plan (WP-9) |
| R3 | Entra workload identity federation from k3s fails | Client-certificate credential in Key Vault, short-lived, rotated (`MASTER-ROADMAP.md` §7) |
| R4 | Consumer CI flaky or slow | Run only typecheck + unit tests per consumer on canaries; full suites nightly |
| R5 | One maintainer | Reviews by the `platform-infra` team; ADRs; a second engineer owns WP-8 |
| R6 | Platform work blocks product cut-overs (W4–W6) | WP-2/3/4 are the only hard blockers; everything else can slip without moving cut-overs |
| R7 | Scope creep into product vocabulary | Admission test + rule 7 (no knobs) + reviewer checklist |
| R8 | Exchange Online limits or a sending block on one product mailbox (for example many mistyped learner addresses; External Recipient Rate Limit from October 2026) | One mailbox per product (a block stays in one product); digest batching; `mail.send` queue rate-limited to ~20 messages/minute per mailbox; per-product upgrade path to Cloudflare Email Service (Resend second) by `MAIL_TRANSPORT` (APD-13) |

---

## 11. Open questions (owner: platform lead)

| # | Question | Default |
|---|---|---|
| Q1 | Reviewers | **Decided:** `@quynhonsemiconductor/platform-infra` team, as today. Open: who in the team owns WP-8 |
| Q2 | Consumer CI credentials | **Decided:** existing org automation GitHub App (§6.1); owner extends its installation to rova, opshub, solodesk |
| Q3 | `qnsc-service-starter` | **Decided:** deferred (§6.13) |
| Q4 | Mail sender addresses | **Decided (2026-10-09):** one shared mailbox and one app per product — `noreply-rova@qnsc.vn` "Rova" (rova's existing Entra app); `noreply-opshub@qnsc.vn` "QNSC OpsHub" (opshub's existing Entra app); `noreply-kb@qnsc.vn` "QNSC Knowledge Base" (kb's existing Entra app); `noreply-solodesk@qnsc.vn` "SoloDesk" (solodesk's existing Entra app); `noreply-academy@qnsc.vn` "QNSC Academy" (the LMS Entra app) |
| Q5 | Cache environment variable | **Decided (2026-10-10):** `REDIS_URL` — rova and opshub already use it and the chart injects it. The earlier `VALKEY_URL` in §6.14 is dropped. No package reads it: the product passes the value to `CacheModule` |
| Q6 | Correlation id | **Done (2026-10-10, #178):** `enableCorrelationId(app)` in `platform-http` seeds the request context from `X-Correlation-Id` (kept only if 1–128 characters of `[A-Za-z0-9._:-]`, otherwise a generated UUID), echoes it on the response and puts it in the context; `CORRELATION_ID_MODE=disabled` opts out. The products' own middleware can go once their logger and exception filter read `observability`'s store (opshub does not yet) |
| Q7 | Log trace field names | **Decided (2026-10-10):** keep `trace.id` / `span.id`, as the logger emits them. The earlier `trace_id` / `span_id` in §6.14 is dropped; a non-TypeScript service uses the dotted names |
| Q8 | `S3_*` in the contract | **Decided (2026-10-10):** waits for WP-17. Storage stays product-owned, and its variable names per product, until it is measured |
