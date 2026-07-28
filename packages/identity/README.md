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

Authorization stays in the product. `permission.guard.ts` + `PERMISSION_CHECKER`
are the one exception, and they are **deprecated pending removal in the next
major**: they hardcode one product's `ns:*` wildcard vocabulary, both products now
run their own guard, and neither imports them any more.

Also product-owned: HTTP controllers and DTOs, route names, and cookie names.
Divergence in those is merely inconsistent; divergence in the mechanism above is a
security defect — which is the line that decides what lives here.
