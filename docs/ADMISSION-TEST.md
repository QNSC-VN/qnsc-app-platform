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
value: frontend error-code branching, a CloudWatch metric filter in Terraform, the
storage a session is written to.

Worked examples, all real:

| in                                                                | why                                                                                                                               |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| refresh-token rotation, theft detection, PKCE, `state` single-use | two divergent copies = two security postures, and the bug class is account takeover                                               |
| `DomainException` → HTTP status mapping                           | **both** frontends branch on those codes; divergence turns one product's 409 into another's 422                                   |
| `FAIL_OPEN_FIELD` (`securityFailOpen`)                            | a CloudWatch metric filter in each product's Terraform matches this literal; a rename disarms the alarm silently                  |
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

## Current status per package

| package          | status                                                                                              |
| ---------------- | --------------------------------------------------------------------------------------------------- |
| `identity`       | trimmed in v6.0.0. See below for what was removed and what is deliberately kept-but-unused          |
| `platform-http`  | error taxonomy + pagination. Both products import it identically                                    |
| `platform-cache` | thin on its own; justified as the peer that keeps one Valkey client                                 |
| `observability`  | OTel bootstrap, logger factory, job context, fail-open contract. Best-documented; the model to copy |

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
- `@qnsc-vn/identity/testing` exports the conformance suites a product runs against
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
emits them since rally deleted its authorization epoch (QNSC-VN/rally#238);
removing union members is breaking, so they come out on the next major.
