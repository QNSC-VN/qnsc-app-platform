# Reference consumer: the end-to-end async path, against the published packages

**M6** of [ADR 0002](../docs/adr/0002-identity-v8-better-auth.md): plan criterion 9 re-run with the real
`platform-jobs` and `platform-mail` instead of stand-ins, installed from the registry exactly as a product
installs them.

```
request (enableCorrelationId)
  -> identity sign-up                         @quynhonsemiconductor/identity       8.0.1
  -> mail.send enqueued in the SAME tx        @quynhonsemiconductor/platform-jobs  0.1.2   (pg-boss)
  -> worker process (ROLE=worker)             @quynhonsemiconductor/platform-mail  0.1.2   (ledger in Valkey)
  -> smtp transport -> Mailpit                @quynhonsemiconductor/platform-http  4.2.0   (the correlation id)
```

Also under test: `observability` 0.2.2, `platform-db` 0.1.1, `platform-cache` 3.1.1, `platform-runtime` 0.1.3.

## What makes this different from the package tests

- **Published artifacts, not workspace builds.** This directory is its own pnpm root (outside the repo
  workspace, like `spikes/`). `pnpm install` fetches every `@quynhonsemiconductor/*` package from GitHub
  Packages, so a wrong `files`, `exports` map, peer range or `.d.ts` shows up here. The TypeScript is compiled
  against the published declarations.
- **Two real processes.** The API (`dist/api.js`) and the worker (`dist/worker.js`, `ROLE=worker`) are
  separate OS processes running the compiled entries. A SIGTERM is a SIGTERM. Their stdout is parsed as JSON
  lines, so what is asserted is what an operator's collector would see.
- **No stand-in.** PostgreSQL 18, Valkey 8 and [Mailpit](https://mailpit.axllent.org/) run in containers. The
  application connects as a less privileged role than the migrator, so a missing `GRANT` in a package fails a
  test (`installJobsSchema` creates them).

## Run it

```bash
cd reference-consumer
# TOKEN: a GitHub token with read:packages. pnpm 11 ignores a token in a project .npmrc, so it goes in a
# user-level file (works on pnpm 10 and 11; see "Authenticating to GitHub Packages" in the root README).
( umask 077; printf '//npm.pkg.github.com/:_authToken=%s\n' "$TOKEN" > /tmp/npmrc )
export NPM_CONFIG_USERCONFIG=/tmp/npmrc

pnpm install --frozen-lockfile
pnpm test                   # about a minute: Docker is required
M6_SLOW=1 pnpm test         # adds the two limit tests (about three more minutes)
```

CI: `.github/workflows/reference-consumer.yml` runs it on changes to this directory, weekly, and on demand
(for example right after a release). It is **not** in the `CI required` gate: it needs the registry and image
pulls, and what it checks is a release, not a pull request.

To check a newer release, bump the pins in `package.json`, then reinstall **without** `--frozen-lockfile`.

## What each test proves

`test/async-path.test.ts`

| Requirement                   | Test                                                 | How it is shown                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One correlation id end to end | sign-up with `X-Correlation-Id`                      | The response echoes it; the API's `jobs.send` line carries it; the worker's `mail.send delivered` line carries it (the worker has no HTTP context, so it can only have come from the job payload); the **job id** is the same in both lines; the log's `messageId` is the Message-ID Mailpit holds.                                                            |
|                               | no header sent                                       | A generated UUID reaches the worker too.                                                                                                                                                                                                                                                                                                                       |
|                               | hostile header (`attack "with quotes" and spaces`)   | It is replaced, and the rejected text is in **no** log line of either process.                                                                                                                                                                                                                                                                                 |
| Rollback => no mail           | sign-up whose COMMIT fails                           | A constraint trigger fails the COMMIT after identity enqueued. The API's `jobs.send` line proves the job **was** created, with `inTransaction: true`; afterwards there is no user row, no job row (pending, active or dead-lettered) and no mail.                                                                                                              |
|                               | product transaction that throws after `mail.enqueue` | Same, through `MailService`.                                                                                                                                                                                                                                                                                                                                   |
| Duplicate => one mail         | one key enqueued three times in one transaction      | One job id and two `null`s; one mail.                                                                                                                                                                                                                                                                                                                          |
|                               | two concurrent requests, same key                    | One job; one mail.                                                                                                                                                                                                                                                                                                                                             |
|                               | the same key again **after** the mail was sent       | A new job is created (the completed one, and its job-id dedupe, is gone because `mail.send` keeps nothing), the worker logs `skipped: this message was already sent`, still one mail. This is platform-mail's Valkey ledger at work.                                                                                                                           |
| SIGTERM drain => no duplicate | worker told to stop while a send is in flight        | Six messages queued with no worker. Worker A sends through a slowed SMTP connection and is SIGTERMed mid-send: it exits 0, **finishes** that send, and hands over the rest. Worker B takes the remaining jobs. Each of the six people has exactly one message; A's and B's delivered job sets are disjoint and together are all six; nothing is dead-lettered. |

`test/controls.test.ts` flips one thing each and shows the opposite outcome, so a pass above means something:
without the injected COMMIT failure the same sign-up succeeds and sends; with the ledger wiped a re-enqueued
key sends a second mail.

`test/regressions.test.ts` pins the fixes for two behaviours this check found (#191, #192; see the issues below). It began as a
characterization of the bugs; when identity 8.0.1, platform-jobs 0.1.2 and platform-mail 0.1.2 fixed them, the assertions were
flipped: an unprocessed `mail.send` job is kept at most 24 h, and a sign-up whose enqueue fails in SQL answers `500` with the
hybrid error body and creates no user and no job.

`test/known-limits.test.ts` (opt-in, `M6_SLOW=1`) pins the behaviour at the documented limits: a drain that
runs **out of budget** after the sink stored a message but before the client was told sends it twice (about
108 s later), and a SIGKILLed worker never duplicates but a stuck message waits for recovery (87 s measured).

`test/schema-drift.test.ts` fails when the published identity's tables move on and this copy has not.

## Findings

Reported as issues in this repository. #191 and #192 are fixed in the releases named below and are now regression tests; the
rest are open or documented as limits.

| Issue                                                                   | Finding                                                                                                                                                                                                                                                  | Evidence                                                                                                                      |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| [#190](https://github.com/quynhonsemiconductor/app-platform/issues/190) | **The `platform-mail` README's NestJS example does not boot.** `createValkeyMailState(cache.instance)` inside `useFactory` throws `client is not available`: `CacheService` creates its client in `onModuleInit`, after every provider is built.         | Reproduced against the published packages and a real Valkey; only a lazy lookup boots. `src/infra.ts` carries the workaround. |
| [#191](https://github.com/quynhonsemiconductor/app-platform/issues/191) | **A failed SQL enqueue inside the sign-up transaction answered `200` with a user that does not exist.** Better Auth swallows the callback's error, the aborted transaction's COMMIT is a silent ROLLBACK. **Fixed** in identity 8.0.1: it answers `500`. | `test/regressions.test.ts`                                                                                                    |
| [#192](https://github.com/quynhonsemiconductor/app-platform/issues/192) | **An unprocessed `mail.send` job was kept 14 days with the verification link in clear**, not the 24 h that ADR 0002 decision 4 bounds. **Fixed** in platform-jobs 0.1.2 / platform-mail 0.1.2 (`retention.pending`).                                     | `test/regressions.test.ts`                                                                                                    |
| [#193](https://github.com/quynhonsemiconductor/app-platform/issues/193) | **pnpm 11 ignores `${NODE_AUTH_TOKEN}` in a project `.npmrc`**, which is what the install snippets in the root and identity READMEs said. **Fixed** (docs): the root README's "Authenticating to GitHub Packages", pointed to from every package README. | `ERR_PNPM_FETCH_401` and pnpm's warning, reproduced here                                                                      |
| [#195](https://github.com/quynhonsemiconductor/app-platform/issues/195) | **A drain that runs out of budget with a lost acknowledgement sends twice**, and the SMTP transport cannot be aborted once a send has started. The documented "no exactly-once" limit, now with a trigger.                                               | `test/known-limits.test.ts`                                                                                                   |
| [#196](https://github.com/quynhonsemiconductor/app-platform/issues/196) | **Errors on `/api/auth/*` are not the platform envelope** (`{message, code}`), and a failed COMMIT answers `500` with a `null` body; the cause reaches stderr but not the structured log.                                                                | measured, see the issue                                                                                                       |

Observations that are **not** issues: the heartbeat/monitor recovery of a SIGKILLed worker took 87 s in the
slow test (documented as up to about 75 s plus the claim lease); and the first run saw one first-attempt
`network` failure of a send that could not be reproduced in 12 + 8 further sends, so the harness now waits for
the SMTP banner on the host port before sending.

## Limits of this check

- **Mailpit is not Exchange Online.** The `graph` transport (the one production uses) is not exercised here;
  only `smtp`, which `platform-mail` refuses in production.
- **No Kubernetes, Cloudflare Tunnel or CloudNativePG.** Plain containers; the database speaks TLS-less
  (`DATABASE_SSL=disable`, allowed outside production).
- **`SIGTERM` is sent to a process, not to a pod**: no kubelet grace period, no endpoint-removal delay
  (`SHUTDOWN_ENDPOINT_DELAY_MS=0`).
- The mock for the identity provider is not needed (public preset only); Entra/SSO paths are not covered.
- Timing assertions are generous on purpose (a container start varies by seconds). The default suite finishes in
  about a minute; a run on a loaded machine can be slower.
