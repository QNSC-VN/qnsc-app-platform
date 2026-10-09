# spikes/pg-boss — WP-6

Evidence for [`docs/adr/0001-job-queue.md`](../../docs/adr/0001-job-queue.md): can pg-boss be the
company job queue behind `platform-jobs`? **Not a package.** It is private, never published, not in
`release-please-config.json`, and not part of the root `pnpm test` (the scenarios start Postgres
and Grafana containers and take minutes to hours).

Read the ADR for the verdict and the numbers; this file is for re-running them.

## Run

Docker is required. Build once so `platform-db` resolves from `dist`:

```bash
pnpm install && pnpm build
cd spikes/pg-boss
pnpm test                               # the scenario tests (about 25 minutes, scenario 4 alone is 12)
pnpm exec vitest run --config vitest.config.ts src/scenarios/01   # one scenario
pnpm bench:load                         # scenario 5: 100 jobs/s for 10 minutes (about 11 minutes)
pnpm bench:transcode                    # scenario 2 at full length: a 30-minute job (about 80 minutes)
```

Measured numbers are written to [`results/*.json`](results) by the runs themselves; the ADR cites
those files. Each run overwrites only its own keys.

## What is where

| Path                                     | Scenario (PORTFOLIO-TECH-REVIEW §2A.6, or WP-6 addition)                                |
| ---------------------------------------- | --------------------------------------------------------------------------------------- |
| `src/scenarios/01-transactional-enqueue` | 1 — enqueue in a transaction, rollback; Drizzle `DbExecutor`                            |
| `src/scenarios/02-crash-recovery`        | 2 — SIGKILL mid-job, time-compressed (expiry and heartbeat)                             |
| `src/bench/transcode.run.ts`             | 2 — the same at full length, real time                                                  |
| `src/scenarios/03-retry-dead-letter`     | 3 — retry with backoff, then dead-letter, then redrive                                  |
| `src/scenarios/04-schedule-two-replicas` | 4 — one run per tick across 2→3 replicas and a SIGKILL                                  |
| `src/bench/load.run.ts`                  | 5 — 100 jobs/s for 10 minutes, database CPU, backlog                                    |
| `src/scenarios/06-grafana-dashboard`     | 6 — real Grafana 13 against the live schema (HTTP API)                                  |
| `src/scenarios/06b-otel-metrics`         | 6 — the same facts as OpenTelemetry metrics                                             |
| `src/scenarios/07-graceful-shutdown`     | 7 — SIGTERM drain, and the retry budget it spends                                       |
| `src/scenarios/A-pickup-latency`         | addition — p95 pickup at a 1 s polling interval, end to end                             |
| `src/scenarios/B-enqueue-idempotency`    | addition — which pg-boss option really dedupes a key                                    |
| `src/scenarios/C-least-privilege`        | addition — migrator owns the schema, app role only has grants                           |
| `src/scenarios/D-packaging`              | addition — ESM-only pg-boss inside a CommonJS package                                   |
| `grafana/pgboss-queues.dashboard.json`   | the dashboard scenario 6 loads                                                          |
| `src/support/`                           | harness: cluster, pg-boss over a platform-db pool, Drizzle `send`, child worker process |

## Conventions

- Every database connection is a `platform-db` pool: verified TLS against a CA generated for the
  run. pg-boss is given that pool through its `db` option and never opens one of its own.
- Workers that get killed or drained are real child processes (`src/support/worker-process.ts`,
  started with Node's type stripping), not in-process instances.
- Credentials are generated per run. Nothing is committed that could authenticate anywhere.
- Latency is stamped by the database (`created_on`, `started_on`, `clock_timestamp()`) wherever
  two machines' clocks would otherwise be compared.
