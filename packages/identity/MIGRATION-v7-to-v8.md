# Migrating `@quynhonsemiconductor/identity` from 7.x to 8.0.0

8.0.0 is a rewrite on Better Auth. Nothing from 7.x is source-compatible. Browser sessions become database
sessions behind an `HttpOnly` cookie; there is no access token, refresh token or BFF orchestrator any more.
Order of adoption (identity plan §13): LMS and solodesk first, then opshub, then rova. Renovate never
auto-merges this major, so each product moves on its own schedule while 7.x keeps working.

7.x does not receive new features. A 7.x patch needs a maintenance branch (see the PR description).

## What is removed

| 7.x                                                                   | 8.0.0                                                                                           |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `JwtStrategy`, `JwtAuthGuard`, `AUTH_CONTEXT`, `JWT_STRATEGY_OPTIONS` | `SessionGuard` (global) + `@Public()`, `@CurrentSession()`, `@CurrentUser()` from `/nest`       |
| `AuthService` (rotation, theft detection, logout, switch-workspace)   | Better Auth sessions; revoke via `auth.api.revokeSession(s)`; see "Behaviour changes"           |
| `access-token`, `refresh-token`, `AuthTokenCache` (denylist)          | Session revocation is a database update, effective on the next request (staff: no cache)        |
| `BffService`, `BffSessionStore`, `bff-options`                        | `HttpOnly` session cookie set by Better Auth                                                    |
| `EntraVerifier`, `EntraOidcClient`                                    | `staff` preset: Microsoft provider, tenant-checked                                              |
| `oidc/` broker, `ConnectionRegistry`, `SSO_CONNECTION_REPOSITORY`     | `organizations` preset: Better Auth `sso` plugin (providers per organization, verified domains) |
| `ClaimsProvider`, claims in the token                                 | Nothing: the product looks permissions up on each request (rova already does)                   |
| `SsoProvisioningHook`                                                 | `hooks.onSsoProvisioned`, `hooks.ssoRole`                                                       |
| `repository-ports`, `service-ports`, port-conformance kit             | `/testing` conformance kit over the secure defaults                                             |
| Peers `@nestjs/jwt`, `@nestjs/passport`, `passport`, `passport-jwt`   | Drop them if nothing else uses them                                                             |

## What you add

1. **Dependencies:** `@quynhonsemiconductor/platform-db` (>= 0.1.1), `platform-cache` (>= 3.1), `platform-http` (>= 4.1),
   `drizzle-orm`, `pg`, `fastify`. Do not depend on `better-auth` yourself.
2. **Environment:** `BETTER_AUTH_SECRET` (32+ chars) and, with the `organizations` preset, `IDENTITY_ENCRYPTION_KEY`
   (32 random bytes, base64) — both from Key Vault through External Secrets. Remove the v7 JWT key and BFF secrets.
3. **Email and jobs:** a `JobEnqueue` binding (`platform-jobs`) and your `AuthEmailTemplates`. Auth emails are enqueued.
4. **Tables** (below) and one `createIdentity()` call (README).
5. **Entra:** the staff app registration must be **single-tenant**, emit the `email` optional claim, and have
   `https://<api>/api/auth/callback/microsoft` as a redirect URI. Decide `staff.allowGuests` (rova: `true`, opshub: `false`).
6. **Frontend:** use `better-auth/react` `createAuthClient` against `/api/auth/*`; delete MSAL silent re-auth. A Microsoft
   sign-in is a server-side redirect.
7. **Lint:** forbid `better-auth` imports outside the file that calls `createIdentity` (identity plan I7).

## If the same change moves you to pnpm 11: registry authentication

Independent of identity, but it bites at exactly this kind of upgrade, so it is recorded here. **pnpm 11 ignores
a token in a project `.npmrc`** and answers `ERR_PNPM_FETCH_401` for `@quynhonsemiconductor/*`. rova, opshub and
solodesk all authenticate that way today (`//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}` in `.npmrc`),
and CI runs pnpm 10 (solodesk pins `pnpm@10.23.0`), so nothing is broken yet. The first product to move to pnpm 11
fails in **three** places, not one:

1. **Developer machines:** put the token in `~/.npmrc` (`( umask 077; printf '//npm.pkg.github.com/:_authToken=%s\n' "$TOKEN" >> ~/.npmrc )`)
   and delete the token line from the project `.npmrc`, leaving only the registry line.
2. **GitHub Actions:** `actions/setup-node` with `registry-url: https://npm.pkg.github.com`, `scope: '@quynhonsemiconductor'`
   and `NODE_AUTH_TOKEN` on the install step. **The shared `setup-node-pnpm` action in `quynhonsemiconductor/ci` does not
   do this**: it calls `actions/setup-node` without `registry-url` and runs `pnpm install --frozen-lockfile` itself, so it
   relies on the product's project `.npmrc` and will 401 on pnpm 11. Until that action writes a user-level npmrc (a change
   in the `ci` repository, not here), write one yourself in a step before it, or run the install outside the action
   (`install-deps: 'false'`).
3. **Docker builds:** rova's and opshub's Dockerfiles `COPY .npmrc` and `export NODE_AUTH_TOKEN="$(cat /run/secrets/node_auth_token)"`
   in front of `pnpm install`. On pnpm 11 that 401s. Write `~/.npmrc` from the secret inside the same `RUN` and remove
   it afterwards: `( umask 077; printf '//npm.pkg.github.com/:_authToken=%s\n' "$(cat /run/secrets/node_auth_token)" > "$HOME/.npmrc" ) && pnpm install --frozen-lockfile && rm -f "$HOME/.npmrc"`.

Every form was run on pnpm 10.33.2 and 11.28.5 from a clean `HOME`, and the Docker form in a BuildKit build on both
(the current pattern installs on 10 and gets 401 on 11; the fix installs on both). The details and the other forms are in
the root [README](../../README.md#authenticating-to-github-packages).

## Tables and data

Generate the Better Auth tables for your instance (README, "Tables"), then migrate in one transaction. Ids are
preserved, so foreign keys to `identity.users.id` keep working.

| v7                                         | v8                                | Migration                                                                                                                                                                                        |
| ------------------------------------------ | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `identity.users`                           | `user`                            | Copy with the same ids and **the v7 `email_verified`** (do not force `true`: `invited` users never proved anything). Soft-deleted users are excluded; `inactive` and `suspended` become `banned` |
| `identity.sso_identities`                  | `account`                         | Only rows with `provider = 'entra'` (the staff tenant): `provider_id = 'microsoft'`, `account_id` = the Entra `oid` (`provider_sub`). Other providers have no v8 equivalent in 8.0.0             |
| `identity.sso_connections`, `..._domains`  | `sso_provider` (+ `organization`) | Not the staff tenant: per-workspace Entra connections wait for 8.1 (rova). For an OIDC partner, create the organization and provider through your admin tool; see "SSO providers"                |
| `identity.auth_sessions`, `refresh_tokens` | `session`                         | Not migrated: everyone signs in once after cutover                                                                                                                                               |
| `identity.api_tokens` (rova)               | unchanged                         | Keep the product's module (decision D5)                                                                                                                                                          |
| `identity.employees` (opshub)              | unchanged                         | Product data, linked by user id                                                                                                                                                                  |

```sql
BEGIN;
INSERT INTO identity."user" (id, name, email, email_verified, image, banned, ban_reason, created_at, updated_at)
SELECT id,
       display_name,
       lower(email),
       email_verified,                                   -- as v7 had it
       avatar_url,
       status IN ('inactive', 'suspended'),              -- v7 lifecycle -> v8 ban
       CASE WHEN status IN ('inactive', 'suspended') THEN 'migrated from v7: ' || status END,
       created_at,
       now()
FROM identity.users
WHERE deleted_at IS NULL;                                -- soft-deleted users are not carried over

INSERT INTO identity.account (id, account_id, provider_id, user_id, created_at, updated_at)
SELECT uuidv7(), s.provider_sub, 'microsoft', s.user_id, s.created_at, now()
FROM identity.sso_identities s
JOIN identity."user" u ON u.id = s.user_id              -- skips identities of excluded users
WHERE s.provider = 'entra';
COMMIT;
```

Check before cutover: no two v7 users share a lower-cased email (v8 requires it to be unique); the only rows
that should not copy are the ones you meant to exclude.

### SSO providers and their secrets

A partner IdP is registered by an organization owner or admin through the application, or by your admin tool
calling the same API, so the client secret passes through the encrypting adapter. If you must write
`sso_provider.oidc_config` yourself (a one-off script), seal the secret with the package's helper, never store
it plain:

```ts
import { sealSsoClientSecret } from '@quynhonsemiconductor/identity';

const sealed = sealSsoClientSecret(plainSecret); // `enc:v1:…`, key from IDENTITY_ENCRYPTION_KEY
```

Set `domain_verified` only after the DNS proof, and expect a provider whose domain is not verified to be unusable.
v7 `sso_connections` stored a secret reference, not the secret; fetch the secret from where that reference points.

solodesk: users and Google identities map the same way. Existing argon2 password hashes (any parameters) verify
as they are, so password users do **not** have to reset; hashes in another format will fail with a plain 401 and
need a reset.

## Behaviour changes to design for

- **Claims and workspace context.** v7 put `contextId` and claims in the access token. v8 has no token for browsers:
  read permissions from your own tables per request (cache briefly in Valkey). `contextId` on the session is not in
  8.0.0; **rova waits for 8.1**, which adds it together with per-workspace SSO.
- **No refresh-token theft detection.** Cookie sessions have no refresh token. Mitigations: `HttpOnly` cookie, session
  list, short staff sessions (12 h), no cookie cache for staff, immediate revocation.
- **Revocation window.** With the public cookie cache (5 min) a revoked session can still be believed for up to 5 minutes.
  Staff instances have no cache.
- **Service-to-service tokens** were never browser sessions; if you verified v7 ES256 tokens elsewhere, that needs the
  `jwt` plugin, which is **not** in 8.0.0.
- **Rate limiting** moves into Valkey (`platform-cache`) and keys on `clientIp()`; fail-open when Valkey is down.
- **Failed email enqueue does not fail the request.** Better Auth swallows a throwing callback; the user can use "resend".

## Rollback

Redeploy the previous image. v7 tables are untouched; keep them read-only for 30 days, then drop them.
