# @quynhonsemiconductor/identity

One authentication system for every QNSC product backend, built on [Better Auth](https://better-auth.com).
Staff sign in with Microsoft Entra, public users with email + password or Google, partner organisations with
their own OIDC identity provider. The package owns the **mechanism** and its secure defaults; roles,
permissions, UI, email text and cookie names stay in the product (`docs/ADMISSION-TEST.md`).

**v8 is a breaking rewrite.** The Passport/JWT strategy, refresh-token service, BFF flow, Entra verifier and
`oidc/` broker are gone. See [MIGRATION-v7-to-v8.md](./MIGRATION-v7-to-v8.md).

Decisions and evidence: [ADR 0002](../../docs/adr/0002-identity-v8-better-auth.md) (the WP-9 spike and the
platform lead's decisions) and the identity v8 plan.

## Migration from 7.x

[MIGRATION-v7-to-v8.md](./MIGRATION-v7-to-v8.md) lists what is removed, what to add (dependencies, environment,
tables, Entra settings), the data mapping with a SQL template, and the behaviour changes to design for.

## Install

```ini
# .npmrc
@quynhonsemiconductor:registry=https://npm.pkg.github.com
```

The token (`read:packages`) goes in your **user-level** `~/.npmrc`, **not** in this file: pnpm 11 ignores a token
in a project `.npmrc`. See [Authenticating to GitHub Packages](../../README.md#authenticating-to-github-packages).

```bash
pnpm add @quynhonsemiconductor/identity
```

Better Auth is a **dependency of this package, pinned exactly**. Products never import `better-auth`
themselves (one place to upgrade; every bump runs the conformance kit). It is ESM-only; this CommonJS
package loads it through `require(esm)`, which needs Node >= 22.12 (the repo is >= 24).

Peers: `@quynhonsemiconductor/platform-cache`, `platform-db`, `platform-http`, `drizzle-orm`, `pg`; for `/nest`:
`@nestjs/common`, `@nestjs/core`, `fastify`; optional `observability`, `ioredis`.

## Subpaths

| Import                                   | What                                                                                    |
| ---------------------------------------- | --------------------------------------------------------------------------------------- |
| `@quynhonsemiconductor/identity`         | Framework-agnostic: `createIdentity`, `purgeUnverifiedAccounts`, ports, `DEFAULTS`      |
| `@quynhonsemiconductor/identity/nest`    | `IdentityModule`, global `SessionGuard`, `@Public()`, `@CurrentSession()`, error filter |
| `@quynhonsemiconductor/identity/testing` | The conformance kit, a test client, a mock IdP, the reference schema                    |

## Environment

Secrets and keys come from the environment only.

| Variable                  | Required when          | Meaning                                                                                                                                                              |
| ------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`      | always                 | 32+ characters. Signs cookies and encrypts 2FA secrets and OAuth tokens. Key Vault -> External Secrets                                                               |
| `IDENTITY_ENCRYPTION_KEY` | `organizations` preset | 32 random bytes, base64 (`openssl rand -base64 32`). Encrypts SSO client secrets at rest. Rotation: `v2=<b64>,v1=<b64>` (encrypt with the highest, decrypt with any) |
| `IDENTITY_TEST_LOGIN`     | end-to-end suites only | `enabled` loads `/test-login`, and only when `NODE_ENV` is exactly `test` or `development`                                                                           |
| `NODE_ENV`                | —                      | `production` requires an `https` `baseURL`                                                                                                                           |

## What a product writes

```ts
// apps/api/src/auth.ts
export const auth = createIdentity({
  product: 'lms',
  db, // the product's Drizzle instance (platform-db DATABASE_TOKEN)
  schema: identitySchema, // the product's auth tables, generated (see "Tables")
  cache, // platform-cache CacheService
  baseURL: env.PUBLIC_API_URL,
  trustedOrigins: [env.WEB_ORIGIN],
  presets: ['public', 'staff', 'organizations'],
  mail: { jobs, templates }, // platform-jobs / platform-mail; templates are the product's
  staff: { tenantId, clientId, clientSecret, domains: ['qnsc.vn'], allowGuests: false },
  google: { clientId, clientSecret },
  hooks: { onUserCreated, onSsoProvisioned, ssoRole },
  events, // security events -> observabilitySecurityEvents(logger) / audit
  logger, // Better Auth warnings and errors -> identityLoggerFrom(logger)
});
```

```ts
@Module({
  imports: [
    CacheModule.forRoot({/* … */}),
    DatabaseModule.forRootAsync({ schema: identitySchema }),
    IdentityModule.forRootAsync({
      inject: [DATABASE_TOKEN, CacheService, JOBS],
      useFactory: (db, cache, jobs) => createIdentity({/* … */}),
    }),
  ],
  providers: [
    // Order matters: Nest asks the LAST registered global filter first.
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
    { provide: APP_FILTER, useClass: AuthApiErrorFilter },
  ],
})
export class AppModule {}
```

The module mounts `auth.handler` on `/api/auth/*` as an encapsulated Fastify plugin that receives the raw body
(so form posts from SSO work) and leaves the rest of the app's parsers alone. It writes the client address,
resolved with `clientIp()` (`cf-connecting-ip` first), into the one header Better Auth reads, discarding any the
client sent.

**`/api/auth/*` follows Better Auth's wire protocol, plus the platform error envelope next to it.** `better-auth/client`,
which product frontends use, reads the top-level `code` and `message` of an error body and the HTTP status, so none of
those change. Every response of 400 or above also carries contract §7's envelope in an additive `error` field:

```json
{
  "code": "INVALID_EMAIL_OR_PASSWORD",
  "message": "Invalid email or password",
  "error": {
    "code": "INVALID_EMAIL_OR_PASSWORD",
    "message": "Invalid email or password",
    "details": [],
    "correlationId": "…"
  }
}
```

- **4xx:** Better Auth's status and its own fields are untouched (a missing `code`/`message` is added from the status);
  `error.code`/`error.message` repeat them, and `correlationId` is the request's (`unknown` if none was seeded). Its
  request-body validation (400 `VALIDATION_ERROR`) stays 400 and is `error.code: VALIDATION_FAILED` with the issues in
  `error.details`. A body that already has an `error` key (an OAuth-style `{ error, error_description }`) is left as it is.
- **5xx:** `code` and `error.code` are `INTERNAL_ERROR` and the message is the fixed "An unexpected error occurred", at the top
  level too, never an empty body; nothing Better Auth said about the failure is on the wire (it is in the log).
- Redirects (the OAuth and SSO callbacks) and successes are untouched.
- **`AuthApiErrorFilter` is a different path on purpose.** It maps an error raised through `auth.api.*` inside your own
  controller to a `DomainException`, and so answers the platform envelope alone with the platform's statuses (an
  unrecognised 4xx is 422). The mounted routes keep Better Auth's statuses (that 4xx is 400) because Better Auth's clients
  expect them. The same condition can therefore be a 400 on `/api/auth/*` and a 422 from your controller.

A 500 from Better Auth is logged with the error's **class and code** (`error: "DrizzleQueryError"`, `cause`, `errorCode`:
the SQLSTATE) and the request's `correlationId`, never its message, which a database error fills with the statement or the row.

Every route needs a session unless it is `@Public()`. Authorization stays in the product's guard, which reads
`@CurrentSession()` / `@CurrentUser()`.

### Presets

| Preset          | Enables                                                                                                              |
| --------------- | -------------------------------------------------------------------------------------------------------------------- |
| `public`        | Email + password with verification, reset, Google, TOTP two-factor                                                   |
| `staff`         | Microsoft Entra restricted to the QNSC tenant (`tid` checked), no password endpoints, 12 h sessions, no cookie cache |
| `organizations` | Organizations, OIDC SSO per organization with verified domains and provisioning, encrypted secrets                   |

The `admin` plugin is always on, **without impersonation** (the endpoints do not exist in 8.0.0; 8.1 brings them back with
a required reason, a 1 h limit and an audit record). Passkeys, the `jwt` plugin, SAML and `contextId` are not in 8.0.0.

Better Auth's lifetime is per instance, so in an instance with both `staff` and `public` sessions are written with the
public lifetime and **the 12 h staff cap is enforced where sessions are written** (`session.create.before` and
`session.update.before`, so Better Auth's own endpoints honour it and a refresh cannot stretch it). Staff means a user
with a Microsoft account or an email on `staff.domains`. A staff session at its cap is never refreshed (Better Auth would
ask for a refresh on every read, and the clamp would write the same expiry back): reading it costs no database write, no
Valkey write and no `Set-Cookie`. The cookie cache is off whenever `staff` is present.

The cap is also enforced **when a session is read**, not only when one is refreshed: a staff session older than 12 h is
dead on its next read (`get-session`, `list-sessions`, the guard) whatever expiry it stores. That matters for a session that
was issued on the public lifetime and whose owner is staff _now_. A user **becomes staff** when a Microsoft account is
linked or when their email moves onto `staff.domains`; at that moment the sessions they hold that are not staff-shaped
(a stored expiry beyond `createdAt + 12 h`) are revoked, so they sign in again as staff, and their capped sessions are
left alone. **The same limit applies to that revocation**: it runs inside the request that linked the account or moved the
email, so it cannot refuse; if the cache is degraded at that moment (the signal is `onStorageDegraded`) the rows go from
Postgres but the cached copies stay, and come back when Valkey recovers. They are still staff sessions on a public
lifetime, so the read-time cap ends them within 12 h of their creation (`revokeAllSessions` cannot reach them: their rows are
already gone, so flush the product's cache keys for the user if that window matters); alert on `onStorageDegraded` if it
does. `list-sessions` and the admin's
`list-user-sessions` do not list a staff session past its cap as active. The staff test costs nothing in a session's first 12 h or for a staff-domain email; for anyone else it is one
`account` lookup, remembered per process for 30 s.

**Changing the presets of a running system** (adding `staff`, or moving from `public + staff` to `staff` only) does not
end the sessions issued under the old policy by itself. Staff ones end within 12 h of their creation; to end every session
now, call `revokeAllSessions(auth)` once at deploy. It deletes them in Postgres and in Valkey, returns how many it ended,
and everyone signs in again. **It refuses to run while the cache is unavailable** (it throws `SessionStoreUnavailableError`
before deleting anything) and stops, leaving the rows for a re-run, if the cache fails during the run: sessions are served
from Valkey first, Valkey's deletes are silent no-ops while it is down (`onStorageDegraded` fires), so rows deleted from
Postgres alone would leave cached sessions that come back to life when Valkey recovers. Run it again when the cache is
healthy; what it already revoked stays revoked:

```ts
import { createIdentity, revokeAllSessions } from '@quynhonsemiconductor/identity';

const auth = createIdentity({ ...options, presets: ['public', 'staff'] });
console.log(`revoked ${await revokeAllSessions(auth)} sessions`);
```

Organization creation is closed (`allowOrganizationCreation`, default `false`): organizations are created by the product,
because an organization owner can register an SSO provider. `trustedOrigins` is exactly the list you pass; provider
origins are never added to it.

### Tables

The product owns the auth tables, in its own database. Generate them with the Better Auth CLI against the same
`createIdentity` call and commit the result as a normal migration:

```bash
pnpm exec auth generate --config scripts/auth-cli-config.ts --output src/db/identity.schema.ts
```

House adjustments the package expects (see `scripts/regenerate-reference-schema.sh` for the exact edits): tables
in an `identity` schema, `uuid` id columns (ids are `uuidv7()`), `timestamptz`. The reference schema the
conformance kit uses is exported from `/testing`.

### Ports

Identity depends on two ports, never on the packages behind them:

- **`JobEnqueue`** — `send(queue, data, { tx, idempotencyKey, priority })` (the real `platform-jobs` `Jobs` type is assignable
  to it; `ports.types.test.ts` checks this at compile time). Auth emails are **enqueued, never awaited**, on queue
  `mail.send`, with idempotency key `purpose:userId:sha256(token)` and **priority 10** (`AUTH_MAIL_PRIORITY`), so a bulk
  digest on the same queue cannot delay a verification or reset mail. The sign-up verification mail joins Better Auth's own
  database transaction (rolled back with the user); the others enqueue on their own. **A transaction that cannot commit is
  never a 200:** if a statement in it fails (an SQL error in the enqueue, a revoked grant, a deadlock) Better Auth swallows
  the callback's error and PostgreSQL turns the `COMMIT` into a silent `ROLLBACK`; identity checks the transaction before
  it commits and fails the request instead, so sign-up answers `500` with Better Auth's top-level `code`/`message` (`INTERNAL_ERROR`, a fixed message)
  plus the platform envelope in `error` (with the request's `correlationId`), and `auth.api.signUpEmail` rejects. The log
  line says what failed: the error's class, its cause's class, the SQLSTATE and the correlation id, never the message. An enqueue that fails WITHOUT poisoning the transaction (a
  queue not registered in this process) still leaves the user, and is logged as `identity.mail_enqueue_failed`.
- **Retention is the queue's, not identity's.** Reset and verification links are bearer tokens in clear in the job row, so
  how long a finished job is kept matters (ADR 0002, decision 4). `platform-jobs` has no per-send retention; it is
  configured per queue, and `platform-mail` owns it for `mail.send` (`MAIL_QUEUE_CONFIG`: a completed job is deleted at
  once, a failed or dead-lettered one is kept 24 h). That guarantee holds **only if `mail.send` is registered through
  `platform-mail` in EVERY process that enqueues to it** (the API as well as the worker). An unregistered queue makes
  `send` throw: it fails closed and never falls back to the library's defaults, which would keep the links for days.
  Better Auth swallows a throwing email callback, so the sign-up still answers and the user can use "resend".
- **Correlation id.** The `mail.send` payload carries `correlationId` when the enqueue happens inside a request that has one:
  the id in `observability`'s request context, the store `platform-http`'s `enableCorrelationId` seeds, so one id follows
  the action from the API request into the worker's log lines (platform contract §7). It is included only if it is 1 to 128
  characters from `[A-Za-z0-9._:-]`, otherwise the key is omitted (an invalid value is never echoed); it is not part of the
  idempotency key. The field mirrors `platform-mail`'s `EmailMessage.correlationId`, so the two types are assignable both ways.
  `observability` is an optional peer: without it there is simply no id.
- **`AuthEmailTemplates`** — the product renders `verifyEmail` and `resetPassword`.

`EmailSender` and `EmailMessage` are exported as the **contract `platform-mail` implements** (`send(message) -> { id }`).
Identity never calls an `EmailSender`: auth emails go through the job queue, which is what calls it. The types are here so
the product and `platform-mail` agree on one shape.

### Logs and security events

If an auth email cannot be enqueued (typically `mail.send` was never registered in this process), Better Auth swallows the
throw and the request still answers 200. Identity therefore logs one **ERROR** line with the stable code
`identity.mail_enqueue_failed` and the fields `queue`, `purpose` and the error's class (never an address, a token, a link
or the error's message), then rethrows. **Alert on that code**: it is the only sign a product's mail is not being sent.

Pass `logger` (`{ warn, error }`) to receive Better Auth's own warnings and errors, and `events` to receive the security
events (`sign_in.success`/`failure` for password, social and SSO sign-ins, `account.locked`, `password.reset*`,
`sessions.revoked`, `admin.user_banned`, `account.unverified_replaced`/`purged`). `/nest` has adapters for
`observability`: `observabilitySecurityEvents(logger)` (a counter `identity.security_events{event}` and a log line with ids
only) and `identityLoggerFrom(pinoLogger)`. Events never contain an email address or a token.

### Scheduled work

```ts
// the worker process, once platform-jobs exists
await registerIdentityJobs(jobs, auth); // or
// until then, from an ExclusiveJob, hourly:
await purgeUnverifiedAccounts(auth);
```

`purgeUnverifiedAccounts` deletes accounts that are unverified, older than 72 h, hold only a password account and
never had a session. Safe to run concurrently.

## Secure defaults

Fixed in `DEFAULTS` and asserted by the conformance kit; a product cannot change them.

| Setting            | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Password hash      | argon2id, m = 19456 KiB, t = 2, p = 1; verifies existing argon2 hashes of any parameters                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Password policy    | 12..128 characters, no composition rules                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Email verification | Required before first sign-in                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Reset              | Single-use token, 15 minutes, stored hashed; every session revoked                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Sessions           | Public 7 d sliding (cookie cache 5 min); staff 12 h, no cache; stored in Postgres and Valkey                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Cookies            | `__Secure-<product>.*`, HttpOnly, Secure, SameSite=Lax, host-only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Origins            | `trustedOrigins` required; origin and callback-URL checks pinned **on** (Better Auth turns them off under `NODE_ENV=test`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Rate limits        | Per IP in Valkey (client IP from `clientIp()`); per account **and address** lockout (5 failures in 15 minutes) and, per account from any address, a progressive delay with a ceiling of 50 attempts an hour, on sign-in and on 2FA — a success or a password reset clears both. A browser that has signed in carries an HttpOnly **known-device** cookie (per account; our own HMAC over the cookie name and payload, 90 days enforced server-side from an `iat` inside the value, and bound to the credential: a password change or reset, "sign out everywhere", "sign out other sessions" or the admin's revoke-all invalidates it, also when called server-side with `auth.api`; "other sessions" keeps the asking browser by re-issuing its cookie in the same response, same device and expiry, new epoch; it is minted from a snapshot taken before the call and only if this call performed the bump, a compare-and-set, so two devices racing, or a password change racing, never leave more than one — or any — cookie behind; a cookie that is not valid for that user at that moment is never re-issued). With a valid one the account-wide delay and ceiling are skipped and only 5 failures per device in 15 minutes apply — and 20 an hour across all of the account's devices (spent only by attempts that passed their own device's limit, so one stolen cookie cannot use up the owner's other devices' share), after which a cookie counts for nothing — so a flood of guesses from many addresses cannot lock the owner out; reset/verification mail 3 per hour per email, dropped silently |
| Enumeration        | Identical responses; `request-password-reset`, `send-verification-email`, `sign-up` take at least 150 ms                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Account linking    | Only verified emails from the tenant or a verified SSO domain; SSO auto-links only members of the provider's organization                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| IDs                | `uuidv7()`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Telemetry          | Off                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

## Decisions the package enforces (ADR 0002, plan D9–D20)

- **SSO client secret** is stored as `enc:v1:<base64(iv|ciphertext|tag)>` (AES-256-GCM) in `sso_provider.oidc_config`;
  never logged or returned by an API.
- **Squatting.** Password sign-up is refused for staff domains and verified SSO domains (`USE_COMPANY_SIGN_IN`). When a
  provider asserts a verified email and the only account is unverified, password-only and never had a session, it is
  replaced (`account.unverified_replaced`). Unverified accounts are purged after 72 h.
- **Tenant and guests.** `tid` must equal the configured tenant. A tenant member is accepted only with an email on
  `staff.domains`. B2B guests are refused unless `staff.allowGuests`, and a guest **never auto-links**: if the address belongs
  to an existing account the sign-in is refused with `ACCOUNT_LINK_REQUIRED`.
- **Google** (public preset) is refused for staff and verified-SSO domains, like password sign-up.
- **IdP registration is default-deny** on `/sso/register` and `/sso/update-provider`. Only an organization owner or admin,
  only for the organization, never for a staff domain; the provider is unusable until its domain is verified. Asserted
  emails outside the provider's domain are rejected. SAML is refused (`SAML_NOT_SUPPORTED`). The client secret is not
  echoed in the response.
- **Linking.** An existing local account is linked by SSO automatically only if it is a member of the provider's
  organization; otherwise the sign-in is refused with `ACCOUNT_LINK_REQUIRED`.
- **SSRF.** Discovery, token, JWKS and userinfo URLs must be `https` and public, judged by Better Auth's
  `isPublicRoutableHost` (it sees through IPv4-mapped, NAT64, 6to4 and Teredo forms, benchmarking and CGNAT ranges) after
  resolving the name, and must not redirect. Checked at registration and update; at fetch time Better Auth's own guard
  applies. An error shows the caller a generic message; the reason is only in the log.
- **Test login.** `/test-login` loads only with `testLogin: true`, `IDENTITY_TEST_LOGIN=enabled` **and** `NODE_ENV` exactly
  `test` or `development` (an unset or unknown value is refused); asking for it otherwise throws at start-up.

## Testing

```ts
import { runIdentityConformance } from '@quynhonsemiconductor/identity/testing';

runIdentityConformance(
  { describe, it, beforeAll, afterAll, expect },
  {
    database: async () => ({ pool /* a fresh, empty PostgreSQL 18 database */ }),
    valkey: async () => ({ url, keyPrefix: `${randomUUID()}:` }),
  },
);
```

Run it in the package's CI (done) and in every consumer's CI. It builds an instance over the reference schema, drives
it in process through `auth.handler` and a local OIDC mock, and fails if any default or decision above is no longer in force.

## Known limits

- **Explicit account linking from a signed-in session is not implemented** (D15): a non-member's account is refused
  with `ACCOUNT_LINK_REQUIRED`; Better Auth's SSO callback exposes no session to the resolver.
- **No refresh-token family theft detection** (cookie sessions have no refresh token); mitigations are HttpOnly cookies,
  short staff sessions and immediate revocation.
- **The public cookie cache is a revocation window** of up to 5 minutes. Staff instances have none.
- `Identity` is the wide `Auth<BetterAuthOptions>` type; plugin endpoints are untyped through it.
- Entra behaviour (single-tenant app registration, the `email` optional claim, which claims mark a guest) and the DNS-TXT
  domain verification are proven only against a mock here; ADR 0002 lists them as manual checks.
- The conformance kit's `platform-jobs` / `platform-mail` stand-ins are not those packages; re-run `testing` against them when WP-7/WP-8 land.
