# Shared-platform roadmap and implementation plan

> **Status banner (2026-10-09).** §4 (implementation plan) and §5 (sequencing) are **superseded by
> [PLAN.md](./PLAN.md)** (`APP-PLATFORM-PLAN.md`, 2026-10-08), which is now the single source of truth
> for what is built and in what order. **§0–§2 stay in force** as the method: the corrections (§0), the
> `identity-drizzle` withdrawal (§0.0), the measurement method (§1) and the classification (§2). Read
> those before proposing to promote anything. §3 describes a package that no longer exists.

> **Update (2026-10-10): solodesk is retired.** Its repository is archived and it is no longer a consumer.
> This document measures it as it stood on 2026-09-08, and those measurements stay as the record of how the
> method was applied; do not read them as a description of a live product. What changes: nothing in §0–§2
> depends on solodesk to hold, but steps that say "solodesk adopts first" (§4) and open questions about
> solodesk (§8) are moot.

> **Status:** WP-0 and WP-1 shipped **and adopted**; **WP-2 withdrawn**; **WP-3 measured and not needed** — **v4, supersedes v3**
> **Date:** 2026-09-08
> **Consumers:** `rova` · `opshub` · ~~`solodesk`~~ (retired 2026-10-10) · Learning (new)
> **Related:** [ADMISSION-TEST.md](./ADMISSION-TEST.md) · [LOCAL-CREDENTIALS.md](./LOCAL-CREDENTIALS.md)

---

## 0. Corrections from v1

v1 was written from file-path overlap. Measuring the files changed three conclusions. They are recorded here because the corrections matter more than the original claims.

| v1 claimed                                                      | Measurement                                                         | Corrected                                                                                                                                                                |
| --------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `email/email-delivery.service.ts` is a clean promotion (6 diff) | It imports `emailOutbox` from `db/schema/messaging`                 | **Fails admission condition 3.** Needs table parameterisation like every other schema-bound adapter.                                                                     |
| Five duplicate JWT guards                                       | rova 241 lines, opshub 182, **201 diff lines**; solodesk 31         | **Not duplicates.** They genuinely diverged — rova carries API-token auth, opshub carries policy/authz. The only real issue is the _unused_ guard shipped in `identity`. |
| `libs/platform` is ~55 duplicated files                         | Many already import `@quynhonsemiconductor/*` and are thin adapters | **Roughly a third is genuine duplication.** `http/`, `errors/`, `cache/`, `rate-limit.guard` already consume the packages correctly.                                     |

The headline is smaller and more honest than v1 implied: **about 370 lines are pure-win extraction today.** The rest is a convergence programme, not a promotion.

---

## 0.0 WP-2 was withdrawn, and why that is the right outcome

`@quynhonsemiconductor/identity-drizzle` was built, tested, adopted into `solodesk`
against a local link, and then **deleted**. The reasoning is worth keeping, because
the same instinct will recur.

**What went wrong.** Making one adapter serve three products meant parameterising
everything that differed: `table`, `columns`, `toDomain`, `toInsert`,
`toProviderValue` — five knobs. The result was _generic_, and that cost exactly what
genericity costs:

|                 | hand-written                       | the factory               |
| --------------- | ---------------------------------- | ------------------------- |
| Columns         | `typeof authSessions.$inferSelect` | `unknown`                 |
| Rows            | fully typed                        | `Record<string, unknown>` |
| Predicates      | typed                              | `as never` casts          |
| solodesk's file | 71 lines                           | 79 lines                  |

**Less type-safe than the code it replaced, and longer.** It bought one thing: the
rotation compare-and-swap in a single place.

**The heuristic that falls out.** _If making something shareable requires adding
configuration, it probably should not be shared as code._ Compare what actually
earned its place:

| Shared thing                  | Config knobs | Verdict          |
| ----------------------------- | ------------ | ---------------- |
| `ExclusiveJob`                | 0            | genuinely shared |
| `request-timing`              | 0            | genuinely shared |
| `load-env`                    | 0            | genuinely shared |
| `createAuthSessionRepository` | 5            | the smell        |

The four `platform-runtime` extractions were byte-identical across two products
_before_ anyone touched them. Nothing to parameterise, because there was nothing to
disagree about. That is what a real shared decision looks like.

**Three tiers, and only one of them is shared code:**

1. Same code everywhere, unchanged → share it.
2. Implementations must differ, behaviour must agree → share a **contract**.
3. Product vocabulary → never shared.

The session repository is tier 2. It was put in tier 1.

**What replaced it.** `@quynhonsemiconductor/identity/testing` already had
`describeAuthSessionRepositoryContract`, covering the CAS with the same reasoning —
and **no product ran it**. Investigating why found the real defect: its fixtures are
logical names (`'session-1'`), which a `uuid` column rejects with `22P02` before any
assertion, and `auth_sessions.user_id` is a foreign key with no parent rows. The kit
was only ever runnable against the in-memory ports.

Fixed in `identity` 7.1.0 — `id`, `seedUsers`, `SESSION_CONTRACT_USER_IDS`,
`absentId`/`absentEmail`, plus a new assertion that fires three concurrent
`revokeByIdIfActive` calls and requires exactly one to win. The sequential case
passes even for a read-then-write adapter; only the concurrent one distinguishes a
genuine compare-and-swap.

This guards the CAS **better** than sharing the code did: it verifies behaviour
rather than preventing one way of causing the failure, it costs no type safety, and
it works whatever ORM a future product picks.

---

## 0.1 Implementation status (2026-09-07)

| WP                 | State          | What landed                                                                                                                                                                            |
| ------------------ | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **WP-0**           | **Done**       | `enableAutoPipelining` in `platform-cache`; argon2 parameters pinned in `solodesk` with rehash-on-login; timing equalisation; per-IP login limit; reset now revokes live access tokens |
| **WP-1**           | **Done**       | `@quynhonsemiconductor/platform-runtime@0.1.0` — published-ready, builds clean, tests green                                                                                            |
| **WP-2**           | **Withdrawn**  | `identity-drizzle` was built, adopted into `solodesk`, then **deleted**. The package no longer exists. Replaced by the port-conformance kit in `identity` 7.1.0 — §0.0                 |
| **WP-3**           | **Not needed** | `platform-email` — measured, and the duplication is not there. §0.2                                                                                                                    |
| WP-4 / WP-5 / WP-6 | Not started    | Convergence; audit/notifications; the guard decision                                                                                                                                   |

**Adoption HAS happened, as of 2026-09-08.** `rova` and `opshub` both consume
`platform-runtime@0.1.1` — `load-env`, `registerRequestTiming`, `ExclusiveJob`
(2 and 9 cron sites), `AppConfigModule` and `TypedConfigService` — and both moved to
`identity@7.1.0` and `platform-cache@3.1.0`. `solodesk` deliberately does not:
four of the five `platform-runtime` pieces have no counterpart there, and the fifth
is a 7-line `validateEnv` whose divergence is inconsistent rather than a defect,
which ADMISSION-TEST.md puts in the product.

The conformance kit shipped in `identity@7.1.0` and had **zero consumers** until
rova's e2e suite began running it against the real Drizzle adapter — the thing WP-2's
withdrawal was supposed to buy, finally collected.

### What WP-2 0.1.0 deliberately left out

`createUserRepository` has three copies with the same seven methods and is the
obvious next addition, but its mapping surface is larger than the session
repository's. Shipping it half-finished alongside two complete adapters would have
been worse than shipping the two whole. `createSsoConnectionRepository` has one
consumer (`rova`) and its broker-resolution set is the largest of the ports — it
waits for a second consumer, per the promotion checklist. Table builders wait for
Learning: a builder with no consumer is the `oidc/` mistake repeated.

### One correction to WP-0 as written

§4's WP-0 said to "store the algorithm and parameters beside the hash". That was
wrong: argon2's PHC string (`$argon2id$v=19$m=...,t=...,p=...$salt$hash`) **already
encodes its own parameters**, and `argon2.needsRehash` reads them back out. No extra
column is needed, and none was added.

### Adoption is gated on PUBLISHING, and that is a hard sequencing constraint

All three products consume `@quynhonsemiconductor/*` from **GitHub Packages**, not as
workspace links — `solodesk`'s `CLAUDE.md` states this explicitly, and its `.npmrc`
confirms it. So `platform-runtime@0.1.0` and `identity-drizzle@0.1.0` (since
withdrawn — §0.0) cannot be
installed by any consumer until release-please publishes them.

`solodesk`'s adoption was written and **typechecked clean** against a temporary local
symlink, then reverted so the repository is not left in a state that cannot install.
The verified file is kept at `docs/adoption/solodesk-auth-session.drizzle-repository.ts.verified`
and is ready to apply once the package is on the registry.

### The line-count acceptance criterion FAILED on the first product

§4's WP-1/WP-2 acceptance was "each adoption deletes more lines than it adds". On
`solodesk` the session repository went **71 → 79 lines**.

The rule was not wrong to state, but it measured the wrong thing here. `solodesk`'s
copy was already the leanest of the three (71, against `rova`'s 85 and `opshub`'s 91)
because it resolves `db` at module scope and carries no DI wiring — so there was
little boilerplate for a factory to remove, while the delegating class, the port type
alias and the wiring block all cost lines. What the adoption actually bought is not
size: it is that the rotation compare-and-swap now has ONE home instead of three.

Two consequences worth carrying forward:

1. **Expect the line win, if it comes, on `rova` and `opshub`** — they are the ones
   with DI boilerplate and the larger copies. If it does not appear there either, the
   criterion should be replaced rather than the code contorted to satisfy it.
2. **Do not treat a line increase as a signal to abandon an adoption.** The revised
   test is: does this delete a duplicated _decision_? For the CAS, yes.

### Two design defects the adoption exposed, both fixed

Neither was visible from the package's own tests — only from compiling a real consumer
against it.

- **`DrizzleExecutor` named drizzle's `SQL` type**, so assignability depended on both
  sides resolving the SAME `drizzle-orm` instance. `SQL` carries a private field, so
  two copies are structurally incompatible even at identical versions, and a consumer
  with a duplicated drizzle would fail to typecheck against a package it was using
  correctly. No drizzle type appears in that interface now; predicates thread through
  as `never` and are cast at the call site.
- **Inferring the delegating class's method types triggered TS2742** ("cannot be named
  without a reference to…"). The adoption now annotates each member from the port
  itself, which is both portable and more honest on a DI surface.

### `createUserRepository` deliberately omits `upsertBySsoIdentity`

The three implementations genuinely DISAGREE, and the disagreements are policy rather
than drift — sharing it would impose one product's decision on another:

|                                  | `rova`                      | `solodesk`                                                           |
| -------------------------------- | --------------------------- | -------------------------------------------------------------------- |
| Changed `providerEmail`          | updates it                  | ignores it                                                           |
| Linking to an unverified account | leaves `emailVerified`      | **sets it true** — documented: the link is itself proof of ownership |
| Email normalisation              | lowercases and trims        | matches raw                                                          |
| Row ids                          | client-side `uuidv7`        | column defaults                                                      |
| `findByEmail` / `findById`       | filters `isNull(deletedAt)` | does not                                                             |

That method is also the account-LINKING path, a well-known takeover vector, so the
divergence deserves a deliberate decision rather than a quiet merge — and that
decision belongs to the products. The soft-delete filter is exposed as an OPTION
(supply the column or don't) since both postures are defensible.

### Verification actually performed

`pnpm -r build` clean across all six packages; `pnpm test` 306/306 plus 10 new;
the compare-and-swap test red-checked by removing the `is_revoked = false` predicate
and the `returning` clause (2 of 3 fail, pass again on restore). **solodesk's e2e
suite was NOT run** — that machine has no `.env` and no running Postgres or Valkey,
so `tsc --noEmit` is the ceiling there and the argon2/login/reset changes are
typecheck-verified only.

---

## 0.2 WP-3 was measured and is not needed

`platform-email` was carried as pending work on the strength of "~700 lines across
9 files". That number counts lines that EXIST TWICE, not lines that are THE SAME —
the same measurement error that produced WP-2, made once more.

Diffed file by file, rova against opshub:

| File                           | rova lines | differing |
| ------------------------------ | ---------- | --------- |
| `email-delivery.service.ts`    | 85         | **6**     |
| `email.provider.ts`            | 69         | 61        |
| `providers/dev.provider.ts`    | 40         | 40        |
| `providers/ses.provider.ts`    | 96         | 115       |
| `providers/resend.provider.ts` | 100        | 121       |
| `email.service.ts`             | 95         | 119       |
| `email-scheduler.service.ts`   | 82         | 125       |
| `templates/index.ts`           | 239        | 422       |
| `providers/shared.ts`          | —          | rova only |

**Exactly one file is duplicated.** Everything else diverges by as much as or more
than its own length — a diff larger than the file means the two share a name and
little else. `templates/index.ts` at 422 differing lines over 239 is not duplication
at all; §4's own WP-3 steps already said to leave templates in the products because
they are product vocabulary.

The provider abstraction was the part worth extracting, and it is the most divergent:
`dev.provider.ts` differs on 40 of 40 lines. Sharing it would mean parameterising
what differs, which is precisely the shape WP-2 was withdrawn for — and the heuristic
that came out of that withdrawal applies unchanged: **if making something shareable
requires adding configuration, it probably should not be shared as code.**

ADMISSION-TEST.md settles the rest. Two products sending differently-worded emails is
neither a security defect nor a cross-repo contract break. It is the case the test
exists to keep out.

**What would change this.** `IEmailProvider` — the interface alone, not the
implementations — is a genuine contract and would be worth sharing at a third
consumer. Learning needs email and would otherwise become that third divergent copy,
so the decision is worth reopening THEN, on the interface only, with these numbers
re-measured against three products rather than two.

**Not done, deliberately:** no package, no extraction, no parameterisation.

---

## 1. Method

Every claim below is measured, not inferred:

- `diff -w` line counts between `rova/libs/platform/src/**` and the same path in `opshub`
- whether each file imports `@quynhonsemiconductor/*` (thin adapter) or nothing (genuine duplicate)
- whether each file imports product schema (blocks promotion without parameterisation)

Nothing is proposed because it "looks reusable". The repo's own history records both failure modes — `oidc/` promoted before a second consumer, `permissionGrants` promoted while carrying product vocabulary.

---

## 2. Classification

### 2.1 Already correct — leave alone

These consume the shared packages and extend them locally. This is the intended pattern, not duplication.

| File                                                             | Why it is correct                                                                                             |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `cache/index.ts`                                                 | One-line re-export of `platform-cache` so product code imports from `@platform`                               |
| `errors/exceptions.ts`                                           | Extends the shared `DomainException` so package-thrown and product-thrown errors share **one class identity** |
| `http/index.ts`, `http/pagination.ts`                            | Explicitly sourced from `platform-http` — opshub's file says so in a comment                                  |
| `http/http-logging.interceptor.ts`, `idempotency.interceptor.ts` | Import `platform-http` and extend                                                                             |
| `rate-limit/rate-limit.guard.ts`                                 | Package-sourced                                                                                               |
| `rate-limit/rate-limit.constants.ts`                             | 114 diff on 84 lines — per-route limits are **product vocabulary**, correctly divergent                       |

`platform-http` already ships `global-exception.filter`, `pagination/{cursor,offset}`, `http-logging.interceptor`, `idempotency.interceptor`, `rate-limit.{constants,decorator,guard}`, and `request-context`. Check it before proposing anything HTTP-shaped.

### 2.2 Promote now — measured, clean

| File                                  | Lines | Diff  | Package imports                   | Product schema            |
| ------------------------------------- | ----- | ----- | --------------------------------- | ------------------------- |
| `scheduling/exclusive-job.service.ts` | 104   | **0** | `platform-cache`, `observability` | none                      |
| `http/request-timing.ts`              | 108   | **0** | none (fastify only)               | none                      |
| `config/load-env.ts`                  | 35    | **0** | none (`node:process` only)        | none                      |
| `config/app-config.service.ts`        | 16    | **0** | none                              | none — generic over `Env` |
| `config/config.module.ts`             | 26    | 2     | none                              | none                      |
| `utils/sanitize.util.ts`              | 42    | 37    | none                              | none                      |
| `context/als.middleware.ts`           | 37    | 39    | none                              | none                      |

≈ 368 lines. The first four are byte-identical: extraction is deletion, not reconciliation.

`exclusive-job.service.ts` is the single best candidate — 104 lines, zero diff, and it **already consumes two shared packages correctly**. It proves the pattern without touching an auth path.

### 2.3 Promote with parameterisation

Same treatment as §4: the product passes its table objects, the package supplies behaviour.

| Subsystem                 | Scope                             | Note                                                                                                                                                                                                                                      |
| ------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `email/*`                 | ~700 lines across 9 files in rova | The largest coherent duplicated subsystem. `email-delivery.service.ts` is 6-diff but schema-bound; providers (`dev`, `resend`, `ses`) are 34–115 diff. **Answers Learning's transport question — do not pick a transport, consume this.** |
| Identity Drizzle adapters | 3 copies                          | See §3                                                                                                                                                                                                                                    |

### 2.4 Converge first — these are projects, not promotions

Divergence is too large for extraction. Same concept, different implementations; reconciling them carries regression risk in live products.

| File                                              | Lines | Diff    |
| ------------------------------------------------- | ----- | ------- |
| `storage/storage.service.ts`                      | 314   | **588** |
| `resilience/resilience.service.ts`                | 245   | **389** |
| `notifications/notification.templates.ts`         | 174   | 343     |
| `email/templates/index.ts`                        | 239   | 416     |
| `http/pagination.ts`                              | 247   | 260     |
| `outbox/abstract-outbox-relay.ts`                 | 332   | 258     |
| `notifications/notification-scheduler.service.ts` | 114   | 124     |
| `observability/health.controller.ts`              | 93    | 66      |
| `http/csrf.ts`                                    | 74    | 49      |

Do not attempt these before §2.2 and §3 have shipped and proved the model.

### 2.5 Never promote

Domain modules (`projects`, `assets`, `qms`, `catalog-inventory`, …) · authorization (`rova/modules/access` uses `ns:*`, `opshub/modules/authz` uses `resource.action`) · controllers, DTOs, route names, cookie names · policy values (rate-limit thresholds, password minimums, TTLs) · Drizzle table definitions.

---

## 3. `@quynhonsemiconductor/identity-drizzle`

> **SUPERSEDED — this package was withdrawn and deleted. See §0.0.**
> Kept because the design and the measurements that killed it are the useful part:
> the parameterisation it needed is the shape to recognise next time. Do not build
> from this section.

Three products independently wrote adapters against `identity`'s own ports.

| Adapter                  | Evidence                                                                                                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ITransactionRunner`     | 3 copies. rova and opshub byte-identical apart from the doc comment; solodesk differs only in module-scope `db` vs DI. Body is `db.transaction(fn)`.       |
| `IAuthSessionRepository` | 3 copies, **identical surface** — `create`, `findByTokenHash`, `revokeAllForUser`, `revokeById`, `revokeByIdIfActive`, `revokeFamily`. 85 / 91 / 71 lines. |
| `IUserRepository`        | rova's 7 methods; solodesk the same 7 **plus** `findPasswordHashByEmail`. A clean superset, not divergence.                                                |
| BFF session resolver     | 2 copies, 27 vs 30 lines, one `resolve()`, differ in class-name prefix                                                                                     |

**`revokeByIdIfActive` is the compare-and-swap that makes refresh rotation single-use, and it exists in all three.** That security-critical query has been hand-propagated three times. Three hand-maintained copies of a concurrency-critical write is how atomicity quietly breaks.

### 3.1 Why a separate package

`identity` is deliberately ORM-agnostic — `Tx` is generic and its only runtime dependencies are `jose` and `uuidv7`. Adding `drizzle-orm` would force it on every consumer, including any future non-Drizzle one.

### 3.2 Parameterisation — the design that makes this legal

Shared code must import no product schema. So the product passes its tables:

```ts
import {
  createAuthSessionRepository,
  createDrizzleTransactionRunner,
} from '@quynhonsemiconductor/identity-drizzle';
import { authSessions } from './db/schema';

const AuthSessionRepository = createAuthSessionRepository({
  table: authSessions,
  columns: { contextId: 'tenant_id' }, // only when names diverge
});
```

The package declares a **column contract**; TypeScript enforces table shape structurally. Live products keep their tables and map columns — no migration is forced on anyone.

### 3.3 Table builders for new consumers

```ts
export const authSessions = authSessionsTable(identitySchema);
```

Learning gets a correct schema on day one instead of writing its own adapters and diverging. This is what makes the package useful immediately rather than only in hindsight.

### 3.4 Contents

`createAuthSessionRepository` · `createUserRepository` (with `findPasswordHashByEmail` as an optional capability, so the eventual credential promotion has somewhere to land) · `createDrizzleTransactionRunner` · `createSsoConnectionRepository` · `createBffSessionResolver` · table builders for `authSessions`, `users`, `ssoConnections`, `ssoIdentities`.

**Not included:** `SecretResolver` implementations. rova's binds AWS Secrets Manager; keeping it out preserves the store-agnostic design.

### 3.5 Admission case

| Condition                                  | Verdict                                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Divergence is a security defect            | **Yes** — `revokeByIdIfActive` is a CAS                                                          |
| Byte-identical modulo product name         | **Yes** for runner and resolver; identical surface for repositories, table binding parameterised |
| Same edit twice                            | **Three times**                                                                                  |
| Imports product schema or permission types | **No**, by construction                                                                          |

All four hold. No exception needed.

---

## 4. Implementation plan

Each work package is independently shippable and independently revertable.

### WP-0 — Performance fixes (do first, unblocks nothing, costs nothing)

| Fix                         | Where                                 | Detail                                                                                                                                                                                                                                                                                                                                                |
| --------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Enable auto-pipelining      | `platform-cache/src/cache.service.ts` | `new Redis(url, { … })` has no `enableAutoPipelining`. `JwtAuthGuard` runs `Promise.all([isTokenDenied, isUserRevoked])` — concurrency, not batching, so **two Redis round trips on every authenticated request in all four products**. Set `enableAutoPipelining: true`.                                                                             |
| Pin argon2 parameters       | `solodesk/.../password.service.ts`    | `argon2.hash(plain, { type: argon2id })` takes library defaults — 64 MiB, parallelism 4. Under concurrent logins that is real memory pressure on a Fargate task, and `p=4` oversubscribes a 2-vCPU task. Pin `memoryCost`, `timeCost`, `parallelism`; benchmark to 50–100 ms. Store algorithm + parameters beside the hash to enable rehash-on-login. |
| Deduplicate within solodesk | `internal-service.guard.ts`           | Two copies (backend-api, connector-hub), 19 diff lines. Intra-repo duplication — fix locally, no package needed.                                                                                                                                                                                                                                      |

**Acceptance:** p50 authenticated request latency measured before and after the pipelining change; argon2 verify time benchmarked on the real task size.

### WP-1 — `platform-runtime` (the 368-line extraction)

**New package** `@quynhonsemiconductor/platform-runtime`, 0.1.0. Contents from §2.2.

Steps:

1. Extract the four zero-diff files verbatim: `exclusive-job.service`, `request-timing`, `load-env`, `app-config.service`.
2. Add `config.module` (2 diff — reconcile trivially).
3. Reconcile `sanitize.util` (37 diff) and `als.middleware` (39 diff). Read both, take the superset, write tests covering both behaviours.
4. Publish 0.1.0.
5. **rova adopts first** — it is the source of the extraction, so the diff is pure deletion.
6. opshub adopts. Delete its copies.
7. Learning consumes from its first commit.

**Acceptance:** each adoption deletes more lines than it adds. If one does not, that product had a reason to differ — add a package capability rather than a product workaround.

**Rollback:** revert the product commit; the package remains published and unused. No schema, no data, no runtime coupling.

**Risk:** low. `exclusive-job.service` touches scheduling — verify no job runs twice in staging before prod.

### WP-2 — `identity-drizzle`

> **SUPERSEDED — withdrawn, see §0.0.** The port-conformance kit in `identity` 7.1.0
> replaced it, and rova now runs that kit against its real adapter.

**New package** `@quynhonsemiconductor/identity-drizzle`, 0.1.0. Contents from §3.4.

Steps:

1. Extract from the most complete implementation (rova's, which has the SSO connection repository).
2. Implement the §3.2 column-contract parameterisation.
3. Add the §3.3 table builders.
4. Port-conformance tests for every factory, following `domain-ports.test.ts` and `service-ports.test.ts`.
5. A conformance case proving a consumer binding **nothing** still boots identically to today.
6. ~~**solodesk adopts first** — newest, fewest live users, already has the superset user repository.~~ (Moot: solodesk retired 2026-10-10.)
7. opshub, then rova.
8. Learning consumes with table builders from its first commit.
9. Tag 1.0.0 when all four are on it.

**Acceptance:** `revokeByIdIfActive` exists in exactly one place in the estate.

**Rollback:** per-product revert. No schema change, no data migration — the tables are unchanged and still product-owned.

**Risk: this is the highest-risk package here.** It touches the auth path of three live products. One owner, one product at a time, staging soak between each.

### WP-3 — `platform-email`

> **SUPERSEDED — measured and not needed, see §0.2.** The "~700 lines" below counts
> lines that exist twice, not lines that are the same. Diffed, exactly one file of
> nine is duplicated. Kept for the steps, which remain the right shape IF a third
> consumer ever justifies reopening it — on the interface only.

**New package**, 0.1.0. The ~700-line email subsystem from §2.3.

Steps:

1. Extract the provider abstraction — `email.provider.ts` plus `dev`, `resend`, `ses` providers. **This resolves the Learning transport question: consume this, do not choose a transport.**
2. Parameterise `email-delivery.service` over the outbox table (§3.2 pattern), since it imports `emailOutbox` today.
3. Leave `email/templates/index.ts` in the products — 416 diff lines, and templates are product vocabulary.
4. rova adopts, then opshub, then Learning.

**Acceptance:** one provider abstraction, three consumers, templates still product-owned.

**Risk:** medium. Email delivery is user-visible. Run both paths in parallel in staging before switching.

### WP-4 — Convergence programme (§2.4)

Not scheduled here. Revisit after WP-1 through WP-3 have shipped and the model is proven. `storage.service` at 588 diff lines and `resilience.service` at 389 are rewrites, and should be justified on their own merits rather than on tidiness.

### WP-5 — Tier 2 domain-shaped candidates

`audit` (2 copies: shared port, types, write path; **opshub's `audit-catalogue.ts` stays product** — action codes are vocabulary) and `notifications` (2 copies: shared preference model, types, ports; **channels, templates, relays stay product** — Learning's Zalo channel is exactly what must not be shared).

Do not promote either until Learning has built its version and three implementations can be compared. Promoting on two copies is how `permissionGrants` happened.

### WP-6 — Retire the unused guard

`identity` ships `jwt.guard.ts`, `JwtStrategy`, `AUTH_CONTEXT`, `JWT_STRATEGY_OPTIONS`, which `ADMISSION-TEST.md` records as "kept, though currently unused" pending opshub's BFF work. Products have since diverged genuinely (rova 241 lines with API-token auth, opshub 182 with policy/authz, 201 diff between them).

Decide explicitly: converge on the package version, or delete it from the package. Dead code in a security-critical package is a liability either way. This is a decision, not a task.

---

## 5. Sequencing

```
WP-0  perf fixes           ── independent, do now
WP-1  platform-runtime     ── low risk, proves the model
WP-2  identity-drizzle     ── WITHDRAWN (§0.0); conformance kit instead
WP-3  platform-email       ── NOT NEEDED (§0.2); revisit at a third consumer
WP-6  guard decision       ── any time; it is a decision
WP-5  audit/notifications  ── after Learning exists
WP-4  convergence          ── reassess later
```

Learning consumes `platform-runtime` and the `identity` package (including its port-conformance kit) from its first commit. It does NOT consume `identity-drizzle` or `platform-email` — neither exists, and §0.0 and §0.2 record why. Email is where Learning could still become a third divergent copy, which is the trigger for reopening §0.2 on the interface alone.

---

## 6. Versioning

| Package                                      | Change                 | Version                          |
| -------------------------------------------- | ---------------------- | -------------------------------- |
| `platform-runtime`                           | New                    | 0.1.0 → 1.0.0 at three consumers |
| ~~`identity-drizzle`~~                       | **Withdrawn**          | never published; §0.0            |
| ~~`platform-email`~~                         | **Not needed**         | not built; §0.2                  |
| `identity`                                   | port-conformance kit   | 7.1.0                            |
| `platform-cache`                             | `enableAutoPipelining` | patch                            |
| `identity`, `platform-http`, `observability` | none required          | unchanged                        |

---

## 7. Governance

The value of this repo is the admission test being applied, not the package count growing.

1. **Every promotion cites its copies.** A proposal that cannot name two or three existing implementations is a design idea, not a promotion.
2. **Adoption is part of the promotion.** A package with one consumer six months on is evidence the test was misapplied.
3. **Measure before proposing.** v1 of this document got three conclusions wrong by reading paths instead of files.

Standing single-consumer exceptions: `oidc/` and `SSO_CONNECTION_REPOSITORY`. This plan adds none.

---

## 8. Open questions

1. Does opshub's `auth_sessions` table differ structurally from rova's, or only in naming? Determines whether §3.2 column mapping suffices.
2. Should `identity-drizzle` ship migrations or only table builders? Migrations are more turnkey for Learning but couple the package to each product's migration tooling.
3. ~~Does solodesk's module-scope `db` need the factory to accept both DI and direct forms?~~ (Moot: solodesk retired 2026-10-10.)
4. Who owns WP-2? It touches three live auth paths and needs one owner plus a per-product rollback plan.
5. WP-6: converge the guard or delete it from the package?
6. Is a fifth consumer expected? Hospital Camera AI's stack is undecided; if Python, none of this reaches it.
