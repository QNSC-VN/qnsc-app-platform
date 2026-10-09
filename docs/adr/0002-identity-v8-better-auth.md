# 0002. Build identity v8 on Better Auth (WP-9 spike result: pass)

- **Status:** **Accepted** (2026-10-09, platform lead) — verdict **PASS**. Conditional: manual checks M1–M4 must pass against the real QNSC tenant before `identity` `8.0.0` is released, and M6 re-runs criterion 9 once WP-7/WP-8 land. WP-10 may start now.
- **Date:** 2026-10-09
- **Work package:** WP-9 (`APP-PLATFORM-PLAN.md` §6.9; spike per `APP-PLATFORM-IDENTITY-V8-PLAN.md` §8.1)
- **Deciders:** platform lead (`@quynhonsemiconductor/platform-infra`)

## Context

Identity v8 replaces `@quynhonsemiconductor/identity` 7.x (Passport/JWT, BFF, Entra verifier, `oidc/`
broker) with a package built on Better Auth, for every TypeScript product (identity plan §1, option D).
Before building it, §8.1 asks a throwaway NestJS 11 + Fastify 5 + Drizzle app to meet eleven acceptance
criteria, with a fail path (option C, a `customer-auth` package beside v7).

Constraints that shaped the spike: the admission test (`ADMISSION-TEST.md`) and principles P4–P6 (no
product knobs, env-only configuration, framework-agnostic core plus a `/nest` adapter), and the
dependencies WP-9 is told to use: `platform-db` 0.1.1 (`DbExecutor`, `withTransaction`, `/nest`),
`platform-cache` 3.1.1, `platform-http` 4.1.0 (`clientIp`), and a `platform-jobs` / `platform-mail` API of
the §6.7 / §6.8 shape. The last two do not exist yet (WP-7, WP-8), and the WP-6 pg-boss spike has not
merged, so `spikes/better-auth/src/jobs/` is a **stand-in** with the same shape and the same observable
semantics (job row written through the caller's `DbExecutor`; a duplicate idempotency key returns
`null`). It is not pg-boss.

Versions under test, all pinned exactly: `better-auth` 1.7.7, `@better-auth/sso` 1.7.7,
`@better-auth/drizzle-adapter` 1.7.7, `@node-rs/argon2` 2.2.2, `uuidv7` 1.2.1, `drizzle-orm` 0.45.3,
`@nestjs/*` 11.2.7, `fastify` 5.12.5. Node 24.11, PostgreSQL 18, Valkey 8.

## Decision

**Proceed to WP-10: build identity 8.0.0 on Better Auth.** All ten acceptance criteria pass, and
criterion 11 produced a list of differences from the plan (below). None of them is a blocker; each is
either already solved in the spike code or is a named requirement for WP-10. Option C is not needed.

Code: [`spikes/better-auth/`](../../spikes/better-auth/) (README there). Evidence: **111 tests in 12
files, all passing, ~10 s** (`cd spikes/better-auth && pnpm test`), run three times in a row without a
failure. `pnpm build && pnpm typecheck && pnpm test && pnpm lint` at the repo root are unaffected (the
spike is outside the pnpm workspace) and its own lockfile is clean under `osv-scanner`.

### Criteria and evidence

Each row names the test file in `spikes/better-auth/test/`. "Mock IdP" means the local OpenID Provider in
`test/support/mock-idp.ts`, because no Entra tenant is reachable from here (see Manual checks).

| #   | Criterion                                                                                             | Result                   | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | ----------------------------------------------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Entra sign-in via the Microsoft provider, restricted to the QNSC tenant                               | Pass (mock IdP)          | `c01` (10 tests). Authorize URL is `/<tenant>/oauth2/v2.0/authorize` with PKCE S256 and state; scope is `openid profile email` only; the account is keyed by the Entra `oid`; a token whose `tid` is another tenant is refused with `?error=unable_to_get_user_info` and writes no user. **Without** the `tid` check Better Auth accepts the foreign-tenant token (test `DIFFERENCE: without that preset check…`). A token with no `email` claim cannot sign in. A forged `state` is refused. The staff preset has no password sign-up or sign-in. |
| 2   | Second IdP as a per-organization `sso` provider; domain routing; org provisioning with a default role | Pass (mock IdP)          | `c02` (17 tests). `sign-in/sso` routes by email domain, `providerId` or organization slug; look-alike domain `evilpartner-u.test` is not matched, a sub-domain is. First sign-in creates the user and a `member` row with role `member`; `getRole` maps an IdP `groups` claim to `admin`/`member`; the provisioning hook receives the claims; a second sign-in does not duplicate. A second organization provisions into its own org. An assertion whose email is outside the provider's domain is rejected by `resolveUser` with no user written. |
| 3   | Email + password sign-up, verification, reset (all sessions revoked), lockout                         | Pass                     | `c03` (11 tests). Sign-in is 403 until verified; the emailed link verifies; policy 12..128 with no composition rules; reset token is single-use, 15 minutes (`expires_at - created_at` ≤ 900 s), stored hashed, and a reset kills **both** of two live sessions on their next request; account lockout (6th attempt → 429 `ACCOUNT_LOCKED` even with the right password, from five different addresses) and a success clears the count; sign-up, sign-in and reset responses are identical for known and unknown addresses.                        |
| 4   | `auth.handler` on Fastify inside NestJS; global guard via `auth.api.getSession`                       | Pass                     | `c04` (13 tests) + `smoke`. Routes are 401 (`platform-http` envelope, code `AUTH_UNAUTHENTICATED`) unless `@Public()`; forged and truncated cookies are 401, never 500; JSON **and** `application/x-www-form-urlencoded` bodies reach the handler; repeated `Set-Cookie` headers survive; cookie is `__Secure-spike.session_token`, HttpOnly, Secure, SameSite=Lax, host-only, Max-Age 7 d; untrusted `Origin` and an off-list `callbackURL` are 403. The package also loads from plain CommonJS on Node 24 (`pnpm build && pnpm boot:cjs`).       |
| 5   | argon2id override; rate limits and session cache in Valkey via `secondaryStorage`                     | Pass                     | `c05` (9 tests). New hashes are `$argon2id$v=19$m=19456,t=2,p=1$…`; rate-limit counters are `<prefix><ip>\|<path>` keys with a TTL ≤ 10 s, none in Postgres; sessions are cached in Valkey **and** stored in Postgres, and wiping Valkey leaves users signed in; `increment` is atomic (20 concurrent calls return 1..20) and sets the TTL on creation only; `getAndDelete` hands the value to exactly one of ten callers.                                                                                                                         |
| 6   | Drizzle schema generated and migrated; `uuidv7` ids                                                   | Pass                     | `c06` (5 tests). `auth generate` → `src/db/schema.ts` → `drizzle-kit` → `drizzle/0000_auth_tables.sql`, applied with Drizzle's migrator; eight tables in schema `identity`, every `id` a native `uuid`; ids written for `user`, `account`, `session`, `verification` all have version nibble 7 and sort in creation order. A schema missing a table makes every request reject, naming the table.                                                                                                                                                  |
| 7   | Revocation effective on the next request with the cookie cache off                                    | Pass                     | `c07` (8 tests). Sign-out, "sign out everywhere", revoking one other session, an admin's `revoke-user-sessions` and `ban-user` are each effective on the very next request (banned users also cannot sign in); a non-admin cannot revoke others'. Control: with the cookie cache **on**, the old cookie is still accepted after revocation (the window is real). Staff preset (via the Microsoft flow in `c01`): the session row lives 12 h, no `session_data` cache cookie is set, and the password endpoints answer 400.                         |
| 8   | solodesk argon2 hashes verify, or record re-authentication                                            | Pass                     | `c08` (6 tests). Hashes minted with solodesk's own code path (`argon2` ^0.45.1, `{ type: argon2id }`, i.e. `m=65536,t=3,p=4`) verify through the override and the stored hash is left unchanged (stronger than the v8 baseline, so no rehash is wanted); `change-password` re-hashes to v8 parameters; a bcrypt/scrypt-shaped hash is a 401, not a 500. Verify cost on this machine ≈15–40 ms (solodesk hash) vs ≈8–13 ms (v8 hash). **No password user has to re-authenticate.**                                                                  |
| 9   | Email callbacks enqueue a job; transaction behaviour recorded                                         | Pass (stand-in jobs)     | `c09` (11 tests). **Recorded: Better Auth runs the sign-up verification callback inside its DB transaction, and every other email callback outside any transaction** (below). With the in-transaction enqueue, a sign-up whose `COMMIT` fails leaves no user, no account and **no job**; with the fallback (enqueue outside) it leaves an orphan job and an email for an account that does not exist. The handler is idempotent: the same job redelivered sends one mail; the same `(purpose, user, sha256(token))` twice is one job.              |
| 10  | Rate-limit IP equals `clientIp` (`cf-connecting-ip`) via the IP-header option                         | Pass (with one addition) | `c10` (14 tests). Across six cases (Cloudflare header, spoofed `x-forwarded-for`, header chain, junk header, client-supplied internal header, no headers) the IP in Better Auth's Valkey rate-limit key and in `session.ip_address` equals `clientIp()`; rotating `x-forwarded-for` behind a fixed `cf-connecting-ip` does not escape the limiter. The option **alone** is not enough — see D17.                                                                                                                                                   |
| 11  | Written list of differences from the plan                                                             | Done                     | Next section.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

### Criterion 9, in detail

Better Auth wraps `sign-up/email` in `runWithTransaction` when the Drizzle adapter is created with
`transaction: true` (its default is **false**), and calls `sendVerificationEmail` inside it, awaited. Every
other email route calls its callback outside any transaction. Measured, in order, by the spike's port:

```
sign-up            verify-email   IN-TX
sign-in (unverified, sendOnSignIn)   verify-email   outside
POST /send-verification-email        verify-email   outside
POST /request-password-reset         reset-password outside
```

The callback receives `{ user, url, token }` and **no handle to the transaction**. The spike passes the
adapter a Drizzle `db` wrapped in a small `Proxy` whose `transaction()` publishes the open transaction in
`AsyncLocalStorage` (`src/identity/tx-context.ts`, 30 lines); the port then calls
`jobs.send('mail.send', message, { tx: currentAuthTransaction(), idempotencyKey })`. That makes the sign-up
enqueue atomic with the user and account, and falls back to an autocommit enqueue everywhere else, which is
safe because the reset token (and the verification JWT) exists before the job does, so the failure mode is
"token without an email" (the user taps "resend"), never "email without a token". Plan §8.1 asked for
"idempotent handler keyed by user, purpose and token hash" as the fallback; it is **also** needed on the
transactional path, because delivery is at-least-once.

Two more behaviours worth stating: a callback that **throws** is swallowed by Better Auth (sign-up returns
200, the user exists, no mail is queued — test `a callback that THROWS is swallowed`), so a failed enqueue
does not fail the request unless it poisons the transaction; and with `advanced.backgroundTasks.handler`
set, callbacks stop being awaited and are no longer sequenced with the commit (the spike's enqueue still
landed, but only because pg queues statements per connection) — **do not combine them**.

## Differences from the plan (criterion 11)

Numbered for reference. "Solved" means the spike code already does it; "WP-10" means the package must.

**Runtime and packaging**

- **D1. Better Auth is ESM-only; every `app-platform` package is CommonJS.** It works: Node 24's
  `require(esm)` loads `better-auth`, `@better-auth/sso` and `@better-auth/drizzle-adapter` from a CJS
  build (`pnpm boot:cjs` prints the plugin list), and types resolve under the repo's
  `moduleResolution: node` through the packages' `typesVersions`. It **requires Node ≥ 22.12** (the repo is
  ≥ 24). Also: `betterAuth(options)`'s inferred type references zod/better-call internals by pnpm path and
  cannot be emitted with `declaration: true` (TS2883/TS7056), so `createIdentity()` must return the wide
  `Auth<BetterAuthOptions>`; plugin endpoints (`api.createOrganization`, …) are then untyped through it.
  WP-10 decides between per-preset return types and accepting the wide type. (Solved: wide type.)
- **D2. Packages differ from the plan's sketch.** `drizzleAdapter` is `@better-auth/drizzle-adapter` (a
  separate exact-pinned package), the schema CLI is the `auth` package (`@better-auth/cli`'s latest release is 1.4.21), and
  `jose` is a runtime dependency of the Microsoft `getUserInfo` below. Both Better Auth peers on Drizzle
  are `^0.45.2 || >=1.0.0-rc.1 <2`, while `platform-db` declares `drizzle-orm >=0.45 <1`: a Drizzle 1.0
  move needs both ranges touched together. (WP-10.)
- **D3. `secondaryStorage` needs five operations, not three.** `get`, `set`, `delete` **and** atomic
  `getAndDelete` and `increment` (rate limiting on secondary storage throws on the first limited request without
  `increment`). `CacheService` has none of the last two, so `src/identity/storage.ts` goes through its raw
  client (`GETDEL`; a Lua `INCR`+`EXPIRE` that applies the TTL on creation only). Failure policy is ours,
  not Better Auth's, which propagates the rejection: reads/writes degrade to "absent", **rate limiting
  fails open**. Without a `cache.isAvailable` short-circuit, one sign-up + verify + sign-in against a
  refused Valkey port took **39.1 s** (ioredis' offline queue, several storage calls per request); with it
  **67 ms** and the user is still served from Postgres. (Solved.)
- **D4. The Drizzle adapter's `transaction` option defaults to `false`.** Without `transaction: true` user
  and credential account are two autocommit statements and criterion 9's atomicity does not exist. (Solved.)
- **D5. The NestJS mount in plan A.2 breaks form bodies.** It registers on the root Fastify instance, so the
  body is already parsed and re-serialised (`JSON.stringify(request.body)`); Fastify has **no** form
  parser, so the SSO plugin's own `form_post`/SAML callbacks would get 415 (test `a bare Fastify route
answers a form POST with 415`). The spike mounts an **encapsulated** plugin that removes the default
  parsers and hands the raw Buffer to `Request`. (The sketch's `headers.forEach` copy of repeated
  `Set-Cookie` does work on Node 24; the spike uses `getSetCookie()` regardless.) (Solved,
  `src/nest/fastify-mount.ts`.)
  The community `@thallesp/nestjs-better-auth` was not evaluated (community-maintained, Fastify marked beta
  upstream); the own mount is about 60 lines.
- **D6. Better Auth derives security switches from `NODE_ENV`.** It turns off the origin and callback-URL
  checks whenever `NODE_ENV === 'test'` or `TEST` is truthy, so a deployment that ever runs with that value
  silently loses CSRF and open-redirect protection; and `rateLimit.enabled` defaults to _production only_
  (storage defaults to in-process memory unless `secondaryStorage` is set). `createIdentity` pins
  `disableOriginCheck: false`, `disableCSRFCheck: false` and `rateLimit.enabled: true`; the conformance
  kit must assert all three under `NODE_ENV=test`. (Solved; test `TRAP:`.)
- **D7. The schema generator emits `text` ids and `timestamp` without time zone.** The spike's
  `scripts/regenerate-schema.sh` turns ids into `uuid` columns in an `identity` pg schema (ids are
  `uuidv7()` strings from `generateId`). Whether house tables use `timestamptz` was not checked; if so the
  generator output needs that adjustment too. Postgres 18's native `uuidv7()` exists (the tests seed with
  it); `generateId: false` plus a column default was **not** tried. Schema validation is lazy: a wrong
  schema does not fail boot, it rejects every request with the missing table named — add the auth
  instance to `/readyz`. (WP-10.)

**Authentication behaviour**

- **D8. Rate limiting is per `IP|path` only; there is no per-account lockout.** Plan §5.4 lists both. The
  spike adds `accountLockout()` (a 45-line plugin: atomic `increment` before the attempt, 5 per 15 minutes,
  cleared on success). Built-in rules are 3 requests/10 s for `/sign-in*`, `/sign-up*`, `/change-*`, 3/60 s
  for reset and verification sends, 100/10 s otherwise; the 429 carries `X-Retry-After` (not
  `Retry-After`). (Solved.)
- **D9. Re-sending verification on sign-in needs `emailVerification.sendOnSignIn`;** the password is checked
  first, so only the account's owner learns it is unverified. The verification token is a JWT stamped in
  whole seconds, so a resend in the same second is byte-identical and the idempotency key dedupes it.
  (Solved.)
- **D10. Enumeration.** Responses are identical for known and unknown addresses on sign-up, sign-in and
  reset. Timing: sign-in is equal within ~1 ms (13.8 vs 12.8 ms); `request-password-reset` is **2–4 ms
  slower for a known address** locally (it writes a verification row and a job). Small, probably below
  network jitter, but not zero. Accept or pad. (Open.)
- **D11. `requireLocalEmailVerified` makes an unverified squatter block the real owner.** If `public` and
  `staff` are both enabled, someone who registers `ceo@qnsc.vn` with a password they know (never verified)
  gets `account_not_linked` on the real person's Microsoft sign-in. It is safe — the squatter's password
  never gains access — but it is a lock-out. Needs a product policy: expire unverified accounts, or do not
  offer password sign-up for the staff domain. (Test `PRE-HIJACK`; WP-10 / LMS.)

**Microsoft (Entra)**

- **D12. Defaults that do not fit the plan.** The provider asks for `User.Read` and `offline_access` and
  fetches the Graph profile photo with the access token; in the authorization-code flow it **does not check
  `tid`** (it decodes the id_token without verifying it, trusting the tenant-specific token endpoint). The
  spike replaces `getUserInfo` (scopes `openid profile email`, no Graph call, `tid` must equal the tenant,
  `oid` and `email` required, `emailVerified` true because tenant membership is the verification). The
  account id is the Entra `oid` (matches plan §7). The `email` claim is optional in Entra id_tokens: if
  the app registration does not emit it, sign-in fails. (Solved; Manual check M2.)

**`sso` plugin**

- **D13. Domain trust.** SSO-created users are `emailVerified = false` even for a domain-verified provider
  and a matching address (only the deprecated `trustEmailVerified` flips it). A domain-verified provider
  **does** link onto an existing local account with the same address (the partner IdP can then sign in as
  every local user of its domain). `domainVerification` needs a `domain_verified` column and a DNS-TXT proof
  per partner domain. (Solved: enabled in the preset; DNS flow not exercised, M4.)
- **D14. Better Auth does not bind the asserted email to the provider's domain.** Without a guard a
  partner IdP — even a domain-verified one — can assert `ceo@qnsc.vn` and a user row is created for it
  (test `without the resolveUser binding`). The spike's `resolveUser` (new in
  1.7, runs in the same transaction as the account write, requires `session.storeSessionInDatabase` — which
  we have) rejects with `EMAIL_OUTSIDE_PROVIDER_DOMAIN` and nothing is persisted. (Solved.)
- **D15. Provider registration is open to any signed-in user** at the default `providersLimit` (10), for any
  domain; only domain verification stops the provider being usable. The preset sets `providersLimit: 0`
  (403 for everyone; the test uses an admin) and providers are created by product code, as `c02` does. The plan's
  "copy issuer, client ID, secret reference" migration (§7) has no equivalent: **the client secret is stored
  in plain text in `sso_provider.oidc_config`**. WP-10 must decide on column encryption or an injected
  secret resolver. (Open.)
- **D16. Trusted origins.** OIDC discovery, JWKS and token endpoints must be inside `trustedOrigins`
  (SSRF guard); a registered localhost IdP is "not publicly routable". A function-valued `trustedOrigins`
  is honoured (test `trustedOrigins as a function`), so the product can derive partner IdP origins from its
  provider table. `getRole` and the provisioning hook see only mapped fields: raw claims such as `groups`
  need `mapping.extraFields`. `disableImplicitSignUp` (v7's `jitEnabled=false`) is **plugin-wide**, not per
  provider; `requestSignUp` overrides it per call. Routing matches a domain exactly or as a suffix
  (`cs.partner-u.test` matches `partner-u.test`) and rejects look-alikes (`evilpartner-u.test`); the plugin
  source also accepts a comma-separated domain list (not exercised).
  (Solved / WP-10.)

**Client IP**

- **D17. The IP-header option alone does not match `clientIp`.** With
  `ipAddressHeaders: ['cf-connecting-ip','x-forwarded-for']` Better Auth agrees for a single
  `cf-connecting-ip` and a one-hop `x-forwarded-for`, but returns **null** for a multi-hop chain, and null
  means _one shared rate-limit bucket for everybody_ (it logs a warning once). So the mount resolves the
  address with `clientIp()` and writes it to one internal header (`x-qnsc-client-ip`) after deleting
  whatever the client sent under that name; `ipAddressHeaders` is that single header. Two consequences:
  Better Auth collapses IPv6 to the `/64` for the key (kept; logs and audit keep the full address), and
  routing through `clientIp` adopts its looser fallback (first `x-forwarded-for` entry) where Better Auth
  alone is stricter — safe only under `clientIp`'s documented assumption that pods are reachable solely
  through the Tunnel. (Solved.)

**Observability and scope**

- **D18. Better Auth logs expected failures** (wrong password, missing user) at warn; the package must route
  its logger to `observability` and keep telemetry off (`telemetry.enabled: false` is set).
- **D19. Not exercised** because §8.1 does not list them: `twoFactor`, `passkey`, `apiKey`, `jwt`,
  `bearer`, admin impersonation, SAML, the `test-login` plugin, the §5.7 `session.additionalFields.contextId`
  for rova, the frontend client, and the security-event plugin. They remain WP-10 scope with the same
  "prove it" standard.
- **D20. solodesk.** `REUSE-ROADMAP.md` §0.1 says solodesk's argon2 parameters were pinned with
  rehash-on-login; solodesk `main` (8f54e8a) hashes with the library defaults. Both verify (PHC strings
  carry their parameters), so criterion 8 holds either way. Better Auth has no rehash-on-login hook.

## Manual checks (not provable here)

The mock IdP shows how Better Auth handles a conforming IdP. It cannot show what Entra does. Before
`8.0.0`, with the real tenant:

- **M1.** The staff app registration is single-tenant, and a user from another tenant is refused by Entra
  before a code is issued. Decide whether B2B guests of the QNSC tenant (tenant id matches, address does
  not) may sign in.
- **M2.** The app registration emits the `email` optional claim for members; `oid` and `tid` are present in
  v2.0 id_tokens.
- **M3.** Behind Cloudflare Tunnel and Envoy: the registered redirect URI is
  `https://<api>/api/auth/callback/microsoft`, and `trustProxy`/`X-Forwarded-*` give the mount the right
  protocol and host.
- **M4.** The DNS-TXT verification flow (`/sso/verify-domain`) with real DNS; the spike seeds
  `domain_verified = true`.
- **M5.** SAML, if a partner needs it (not run).
- **M6.** Re-run `test/c09` against the real `platform-jobs` (WP-7) and `platform-mail` (WP-8). The
  conclusions depend on "enqueue through a `DbExecutor`", which the WP-6 prototype shares, but the
  idempotency mechanism there is a deterministic job id rather than this stub's unique index.

## Decisions by the platform lead (2026-10-09)

These close the questions this spike left open. WP-10 implements them; the conformance kit asserts
each one.

1. **SSO client secret (D15): encrypt in the column.** The package wraps reads and writes of
   `sso_provider.oidc_config` so the client secret is stored as `enc:v1:<base64(iv|ciphertext|tag)>`
   (AES-256-GCM). The key comes from env `IDENTITY_ENCRYPTION_KEY` (32 random bytes, base64), delivered
   from Azure Key Vault through External Secrets; the `v1` prefix is the key version for rotation
   (decrypt with any configured key, encrypt with the newest). Plain text is never logged or returned by
   any API. A per-organisation Key Vault secret resolver was rejected: every enterprise customer's SSO
   setup would need an operator action in Key Vault. Conformance test: after registering a provider, the
   raw row contains no plain-text secret, and sign-in still works.
2. **Squatting on unverified accounts (D11): three rules, all mechanism in the package.**
   - Password sign-up is **refused** for the staff domain(s) and for every domain an organisation has
     verified for SSO; the response tells the user to use their company sign-in.
   - An **unverified** password account proves nothing. When a user signs in with a provider that
     asserts a verified email (Entra, Google, verified SSO) and the only existing account for that email
     is unverified and has never had a session, that account is deleted (audit event
     `account.unverified_replaced`) and sign-in continues as a new user.
   - Unverified accounts are purged **72 hours** after creation by a `platform-jobs` schedule.
3. **Tenant check and B2B guests (M1).** The package enforces `tid` = the configured tenant for the
   staff preset. Whether B2B **guests** of that tenant may sign in is product policy (option
   `staff.allowGuests`, default `false`): rova sets it to `true` for vendors; opshub keeps `false`.
4. **Bearer links in job payloads (follow-up 3).** Reset and verification links are bearer tokens in
   clear in the `mail.send` job row. `mail.send` deletes completed jobs immediately and keeps failed or
   dead-lettered jobs at most 24 hours; reset tokens stay at 15 minutes. No payload encryption.
5. **IdP registration (D15 `providersLimit`).** Default deny: only an organisation owner/admin can
   register an SSO provider, and only for a verified domain.
6. D7 (`timestamptz`, `/readyz` check) and D10 (timing pad) are decided by the WP-10 author and recorded
   in the WP-10 PR; flag either if it changes a public API.

## Alternatives considered

| Option                                                           | Why it was not chosen                                                                                                                                                                                |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Option C: a new `customer-auth` package beside v7                | It is the fail path. No criterion failed, so two auth systems and two review surfaces are not justified (identity plan §4).                                                                          |
| `@thallesp/nestjs-better-auth` instead of an own mount and guard | Community-maintained and beta on Fastify; the own mount is small, and owning the raw-body handling was necessary for the SSO form callbacks (D5).                                                    |
| Pure IP-header configuration, no `clientIp` normalisation        | Returns null for a header chain and puts every user in one rate-limit bucket (D17).                                                                                                                  |
| Enqueue email outside the transaction everywhere                 | Leaves an orphan job and an email for an account that was never committed (test `a failed commit leaves an ORPHAN job`). Kept only as the fallback for flows Better Auth runs outside a transaction. |
| Sessions in Valkey only (no `storeSessionInDatabase`)            | A Valkey restart would sign everyone out, and `resolveUser` requires database-backed sessions.                                                                                                       |
| Cookie cache on for the public preset                            | Measured window: a revoked session keeps working until the cache expires (test `cookie cache ON`). Left as a product choice with that cost stated; staff stays off.                                  |

## Consequences

- **Good:** the hard parts of plan §5.4 are verified rather than assumed: verified-before-sign-in, reset that
  revokes every session, immediate revocation, account lockout, enumeration-safe responses, argon2id with
  existing solodesk hashes, rate limits and session cache in the product's own Valkey with a defined
  outage behaviour, and a transactional email enqueue. The spike code is a near-complete first draft of
  `createIdentity`, the Nest module and the testing kit.
- **Bad / costs:** Better Auth is ESM-only in a CommonJS repo (works on Node 24; pins the floor at ≥ 22.12);
  `Identity` loses plugin typing (D1); several secure behaviours are **ours to build and keep** — account
  lockout, domain binding, tenant check, IP normalisation, transaction capture — so the conformance kit has
  real work (identity plan §5.4); the plain-text SSO client secret (D15) and the squatting lock-out (D11)
  are open design problems.
- **Follow-ups (WP-10 unless stated):**
  1. Implement D1, D3–D6, D8, D12, D14, D15 (`providersLimit: 0`), D17 in `packages/identity`, and make the
     conformance kit assert D6, D14, D15, D17 explicitly.
  2. Decide D7 (`timestamptz`, `/readyz` check), D10 (timing pad), D11 (unverified-account expiry) and D15
     (secret storage) before `8.0.0`.
  3. Keep `jobs`/`mail` behind the `EmailSender` port with the idempotency key `purpose:userId:sha256(token)`;
     set `mail.send` retention knowing the job payload carries the bearer link in clear (the Postgres
     `verification` table is hashed, the job row is not). Owner: WP-7 / WP-8.
  4. Correct identity plan §5.2, §5.3, A.1, A.2 (D3, D4, D5), §5.4 (D6, D8) and §7 (secret storage) —
     **the plan lives outside this repository, so this ADR does not edit it.** Owner: platform lead.
  5. Run the Manual checks M1–M6. Owner: platform lead (M1–M4, M5), WP-7/WP-8 authors (M6).
