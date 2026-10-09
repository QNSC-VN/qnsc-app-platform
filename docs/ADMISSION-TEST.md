# What belongs in a shared package

Written 2026-07-28, after an audit that asked whether these packages are genuinely
reusable or merely extracted from rally. The answer was "mostly the former", and
the ~35 % that wasn't had one thing in common: it carried product vocabulary. This
is the rule that fell out, plus the evidence behind it, so the next "should this be
shared?" has an answer that isn't a matter of taste.

## The admission test

> A file enters this repo only if divergence between products would be a
> **security defect** or a **cross-repo contract break**.
>
> If divergence would merely be _inconsistent_, it stays in the product.

Cross-repo contract break means something outside the code depends on the exact
value: frontend error-code branching, a Grafana alert rule that matches a log field or a
metric name, the storage a session is written to.

Worked examples, all real:

| in                                                                | why                                                                                                                               |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| refresh-token rotation, theft detection, PKCE, `state` single-use | two divergent copies = two security postures, and the bug class is account takeover                                               |
| `DomainException` → HTTP status mapping                           | **both** frontends branch on those codes; divergence turns one product's 409 into another's 422                                   |
| `FAIL_OPEN_FIELD` (`securityFailOpen`)                            | a Grafana alert rule matches this literal in the logs and on the `security.fail_open` metric; a rename disarms the alert silently |
| `CacheService`                                                    | it is a **peer** dependency of the BFF session store — two copies means sessions written by one holder are invisible to the other |

| out                                                    | why                                                                                                                                                                                     |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| permission codes, wildcard semantics, role definitions | product vocabulary by definition. rally uses `ns:*` with colons; opshub uses dotted `resource.action`. The shared `permissionGrants` was literally unusable by one of its two consumers |
| authorization guards, scope models                     | policy, not mechanism. Both products wrote their own and neither used the package's                                                                                                     |
| HTTP controllers, DTOs, route names, cookie names      | product surface. The package's `AuthController` shipped a `switch-workspace` route only one product has a concept of                                                                    |

## Promotion checklist

Do not promote on the first use. Promote when **all three** hold:

1. byte-identical between products, modulo the product name;
2. it has taken the _same_ edit in both products at least twice;
3. it imports no product schema and no product permission type.

The counter-example is in this repo's own history: `oidc/` (12 files, the multi-IdP
broker) was written here before a second consumer existed. It has one consumer
today, which is exactly what the checklist exists to prevent.

## Building new, instead of extracting

The checklist above is for code that **already exists in a product** and is being promoted. A
capability that **no product has implemented yet** can also be built here, directly. These principles
(numbered as in [PLAN.md](PLAN.md) §2) say when, and what stays true either way.

**P4 — new-capability rule.** A capability that no product has implemented yet, and that the platform
change requires (CloudNativePG, the job queue, Graph mail, Better Auth), may be built in this repo
when **at least two consumers are scheduled** and it passes the admission test above. Nothing is being
extracted, so the checklist does not apply. What still applies is the lesson from `identity-drizzle`
(REUSE-ROADMAP §0.0): **zero product-specific configuration knobs.** Configuration comes from the
environment only; if a knob seems necessary, the capability does not belong here as code.

**P5 — framework-agnostic core, NestJS adapter at a subpath.** Every _new_ package exports plain
functions from its root and the NestJS module from `/nest`, so a script, a worker or a future framework
can use it. Existing packages are not refactored to fit.

**P6 — no product schema in packages.** A package owns only its own schema (the job queue's own
schema, for instance). Product tables are passed in by the product or not used; there is no outbox
table in `platform-mail` because the job queue is the outbox.

Packages built under P4, with their consumers: `platform-db` (all TypeScript products), `platform-jobs`
and `platform-mail` (the LMS and solodesk first; rova and opshub at convergence), `identity` 8.

## Current status per package

| package            | status                                                                                                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `identity`         | trimmed in v6.0.0. See below for what was removed and what is deliberately kept-but-unused                                                                             |
| `platform-http`    | error taxonomy + pagination. Both products import it identically                                                                                                       |
| `platform-cache`   | thin on its own; justified as the peer that keeps one Valkey client                                                                                                    |
| `observability`    | OTel bootstrap, logger factory, job context, fail-open contract. Best-documented; the model to copy                                                                    |
| `platform-runtime` | env loading, health and graceful shutdown, request-arrival timing. Extracted byte-identical from rova and opshub; `ExclusiveJob` is deprecated for job-queue schedules |
| `platform-db`      | built new under P4 (zero knobs: environment only). The one transaction contract the job queue and identity 8 depend on                                                 |

### identity: removed in v6.0.0

`AuthController`, the auth DTOs, `AuthModule`, `PermissionGuard`, `permissions.ts`
(`permissionGrants`, `WORKSPACE_ALL`), `PERMISSION_CHECKER`, `decorators.ts`
(`Public`, `Auth`, `RequirePermission`, `CurrentUser`, `ApiCommonErrors`),
`metadata.ts`, `BffModule`.

Every one had **zero importers** across both products — established by extracting
the exact named imports from every consumer file, not by reading manifests. Six
peer dependencies went with them (`@nestjs/swagger`, `nestjs-zod`,
`@fastify/cookie`, `fastify`, `zod`, `@nestjs/core`), which is install surface every
consumer previously had to satisfy for code it never called.

### identity: kept, though currently unused

`JwtStrategy`, `JwtAuthGuard`, `AUTH_CONTEXT`, `JWT_STRATEGY_OPTIONS`.

Both products wrote their own guard to carry an extended `JwtPayload` plus product
concerns (BFF-cookie-vs-Bearer branch, denylist, fail-open telemetry). That is
**drift, not divergence**: the cookie-vs-Bearer branch is mechanism, and the second
product needs the first one's version verbatim when it adopts BFF sessions.
Deleting now and re-adding at convergence would be churn. Converge them here when
opshub's BFF work defines the shape.

### identity: single-consumer, declared

`oidc/` + `SSO_CONNECTION_REPOSITORY` — the multi-IdP broker. One consumer. Kept
because it is the seam a non-Entra product would need, so deleting it would remove
the thing worth generalising. Not evidence that the checklist above may be skipped.

## How a consumer proves it still fits

Two artefacts exist so the boundary is testable rather than asserted:

- `packages/identity/src/reference-consumer.spec.ts` boots a real Nest application
  context with **only** the bindings the README documents as required. If a port
  gains a dependency, or an `@Optional()` stops being optional, it fails here
  instead of in a product's boot logs after publishing.
- `@quynhonsemiconductor/identity/testing` exports the conformance suites a product runs against
  its own adapters. They cover what the interfaces cannot express — a
  `revokeByIdIfActive` that returns `true` unconditionally typechecks perfectly and
  makes a stolen refresh token replayable for ever.

## Known limits

Stated as limits, not gaps to be embarrassed about:

- **Microsoft Entra only** for login. A product on another IdP needs the generic
  `oidc/` path generalised first.
- **NestJS + Passport.**
- **A cache reachable from every replica.** BFF sessions and the denylist live
  there; a per-instance cache means sessions and revocations only some replicas can
  see.
- **No JWKS.** Both verification sites run in the signing process, so tokens cannot
  be verified by a third party as-is.

`FailOpenControl` still declares `authz_epoch` and `authz_epoch_bump`. Nothing
emits them since rally deleted its authorization epoch (quynhonsemiconductor/rally#238);
removing union members is breaking, so they come out on the next major.
