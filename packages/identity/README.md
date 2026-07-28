# @qnsc-vn/identity

Shared authentication for QNSC product backends — the mechanism, not the policy.

| in this package                                                                  | in your product                                              |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| access + refresh tokens (ES256), single-use rotation with family theft-detection | your `users` / `auth_sessions` tables and their adapters     |
| Microsoft Entra ID token verification                                            | your HTTP controller and cookie names                        |
| BFF: PKCE, single-use `state`, code exchange, opaque server-side session         | your JWT strategy/guard if your payload is extended          |
| access-token + user denylist (logout, offboarding)                               | **authorization** — permission catalogue, guard, scope model |
| JIT SSO provisioning hook                                                        |                                                              |

Authorization is deliberately absent. It carries product vocabulary (permission
codes, scope dimensions, role definitions), so it belongs in the product — see
[Not in scope](#not-in-scope).

Depends on [`@qnsc-vn/platform-cache`](../platform-cache) and
[`@qnsc-vn/platform-http`](../platform-http) as **peer** dependencies: the cache
must be the same instance your app uses, or BFF sessions written by one holder are
invisible to the other.

## Install

```ini
# .npmrc
@qnsc-vn:registry=https://npm.pkg.github.com
```

```bash
pnpm add @qnsc-vn/identity
```

## What you must bind

Every collaborator arrives through a DI token. There is no `forRoot` that fills
them in — both existing products assemble the pieces in their own module, because
each extends the JWT payload and owns its own routes.

### Required

| token                     | you provide              | notes                                                                                         |
| ------------------------- | ------------------------ | --------------------------------------------------------------------------------------------- |
| `USER_REPOSITORY`         | `IUserRepository`        | your users table; `Tx` is generic, so any driver works                                        |
| `AUTH_SESSION_REPOSITORY` | `IAuthSessionRepository` | refresh-token sessions + families                                                             |
| `TRANSACTION_RUNNER`      | `ITransactionRunner`     | e.g. a wrapper over `db.transaction`                                                          |
| `CLAIMS_PROVIDER`         | `IClaimsProvider`        | **the product's authorization shape** — what goes in the token (roles? permissions? nothing?) |
| `AUDIT_SERVICE`           | `IAuditService`          | login / rotation / theft events                                                               |
| `AUTH_CONTEXT`            | request-context adapter  | read by `JwtAuthGuard`; usually your ALS store                                                |
| `AUTH_SERVICE_OPTIONS`    | `AuthServiceOptions`     | token TTLs, cookie + rotation policy                                                          |
| `JWT_STRATEGY_OPTIONS`    | `JwtStrategyOptions`     | ES256 verification material                                                                   |
| `ENTRA_VERIFIER_OPTIONS`  | `EntraVerifierOptions`   | tenant + audience                                                                             |
| `JwtService`              | `JwtModule`              | from `@nestjs/jwt`                                                                            |
| `CacheService`            | `CacheModule`            | from `@qnsc-vn/platform-cache`; backs `AuthTokenCache`                                        |

### Optional — bind only if the concept exists in your product

| token                       | bind when                                          | if unbound                                     |
| --------------------------- | -------------------------------------------------- | ---------------------------------------------- |
| `SSO_PROVISIONING_HOOK`     | you reconcile roles/records on each SSO login      | no hook runs                                   |
| `SSO_CONNECTION_REPOSITORY` | multi-connection / multi-IdP login                 | home-tenant login only                         |
| `ACCESS_SERVICE`            | multi-tenant: resolve a user's access to a context | skipped                                        |
| `WORKSPACE_SERVICE`         | multi-tenant: workspace membership + switching     | skipped; single-tenant products leave this out |
| `BFF_OPTIONS`               | you want browser sessions instead of tokens in JS  | `BffService` unusable                          |

`BffService` additionally needs `EntraOidcClient`, `BffSessionStore` and
`AuthService` as providers, and takes `ConnectionRegistry` / `OidcClient` /
`OidcTokenVerifier` as `@Optional()` multi-IdP broker collaborators.

## Assembling it

```ts
@Global()
@Module({
  controllers: [MyAuthController, MyBffController], // yours, not the package's
  providers: [
    AuthService,
    EntraTokenVerifier,
    // BFF (browser sessions): the product supplies the controller + cookie name
    EntraOidcClient,
    BffSessionStore,
    BffService,

    // Persistence + collaborators
    { provide: USER_REPOSITORY, useClass: UserDrizzleRepository },
    { provide: AUTH_SESSION_REPOSITORY, useClass: AuthSessionDrizzleRepository },
    { provide: TRANSACTION_RUNNER, useClass: DrizzleTransactionRunner },
    { provide: CLAIMS_PROVIDER, useClass: MyClaimsProvider },
    { provide: AUDIT_SERVICE, useExisting: AuditService },
    { provide: AUTH_CONTEXT, useExisting: RequestContextService },

    // Options, resolved from your own config layer
    {
      provide: AUTH_SERVICE_OPTIONS,
      useFactory: (c: AppConfig) => c.authOptions,
      inject: [AppConfig],
    },
    {
      provide: JWT_STRATEGY_OPTIONS,
      useFactory: (c: AppConfig) => c.jwtOptions,
      inject: [AppConfig],
    },
    {
      provide: ENTRA_VERIFIER_OPTIONS,
      useFactory: (c: AppConfig) => c.entraOptions,
      inject: [AppConfig],
    },
    { provide: BFF_OPTIONS, useFactory: (c: AppConfig) => c.bffOptions, inject: [AppConfig] },
  ],
})
export class IdentityModule {}
```

A missing binding surfaces as a Nest resolution error at boot, naming the token it
could not resolve — check it against the required table above.

## Testing your adapters

`@qnsc-vn/identity/testing` ships typed in-memory ports and the conformance suites
that cover the semantics the interfaces cannot express:

```ts
import { describeAuthSessionRepositoryContract } from '@qnsc-vn/identity/testing';

describeAuthSessionRepositoryContract({
  name: 'AuthSessionDrizzleRepository',
  create: async () => new AuthSessionDrizzleRepository(db),
});
```

Run these against your real repositories. A `revokeByIdIfActive` that returns
`true` unconditionally typechecks perfectly and turns single-use refresh rotation
into a token that can be replayed for ever — the suite is what catches it. Same for
family revocation scope (theft detection) and `upsertBySsoIdentity` linking an
existing email instead of creating a second account.

The in-memory classes (`InMemoryUserRepository`, `InMemoryAuthSessionRepository`,
`InMemoryTransactionRunner`, `StubClaimsProvider`, `RecordingAuditService`,
`RecordingAuthContext`) are usable directly in your own tests. They carry real
`implements` clauses, so a port change breaks them at compile time.

`reference-consumer.spec.ts` in this package boots a real Nest context with exactly
the required bindings below and nothing else — that is what keeps the table honest.

## Constraints

Assumptions baked in today. Each is a real limit, not a config gap:

- **Microsoft Entra ID.** `EntraTokenVerifier`, `EntraOidcClient` and
  `BffEntraOptions` are Entra-shaped. A product on another IdP needs the generic
  `oidc/` path generalised first.
- **NestJS + Passport.** Guards, strategies and modules are Nest constructs.
- **A shared cache reachable from every replica.** BFF sessions and the denylist
  live in Valkey/Redis. A per-instance cache means sessions and revocations that
  only some replicas can see.
- **No JWKS endpoint.** Both verification sites run in the signing process. Tokens
  cannot be verified by a third party as-is.

## Not in scope

The line: **divergence in the mechanism above is a security defect; divergence in
controllers, DTOs, routes, cookie names and permission codes is merely
inconsistent.** The first belongs here, the second in the product.

Removed in v6 because nothing consumed it and all of it was on the wrong side of
that line:

| removed                                                                                | why                                                                                                                                                                |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AuthController`, auth DTOs, `AuthModule`                                              | HTTP surface. Both products write their own controller (one needed a `switch-workspace` route the other has no concept of) and neither called `AuthModule.forRoot` |
| `PermissionGuard`, `permissions.ts`, `PERMISSION_CHECKER`                              | authorization, and hardcoded one product's `ns:*` wildcard vocabulary — unusable by a product whose codes are `resource.action`                                    |
| `Public`, `Auth`, `RequirePermission`, `CurrentUser`, `ApiCommonErrors`, metadata keys | route decorators; `Auth()` mounted the deleted permission guard. Both products already have their own                                                              |
| `BffModule`                                                                            | products bind the three BFF providers directly                                                                                                                     |

## Convergence candidate

`JwtStrategy`, `JwtAuthGuard`, `AUTH_CONTEXT` and `JWT_STRATEGY_OPTIONS` are
exported but **used by neither product today** — each wrote its own guard to carry
an extended `JwtPayload` plus product concerns (BFF-cookie-vs-Bearer branch,
denylist, authorization-epoch check, fail-open telemetry).

They are kept, not deleted, because that duplication is drift rather than a real
divergence: the cookie-vs-Bearer branch is mechanism, and the second product needs
exactly the first one's version when it adopts BFF sessions. Converging them here
is the next step, not another deletion.
