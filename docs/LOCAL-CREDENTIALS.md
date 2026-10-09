# Local credentials and `@quynhonsemiconductor/identity`

> **Status:** Proposal, awaiting review — **v2, supersedes v1 of 2026-09-07**
> **Date:** 2026-09-07
> **Target:** convergence now; `identity` 7.1.0 promotion when the checklist is satisfied
> **Related:** [ADMISSION-TEST.md](./ADMISSION-TEST.md) · [`packages/identity/README.md`](../packages/identity/README.md) · `solodesk/services/backend-api/src/modules/auth`

---

## 0. What changed in v2

v1 of this document was written on a false premise. It claimed there was no credential verification anywhere in the TypeScript stack and proposed writing one from scratch in `identity`.

**SoloDesk already implements local credentials in TypeScript, on top of `@quynhonsemiconductor/identity` ^7.0.0.** It has `argon2` as a direct dependency, a `PasswordService`, an `auth_tokens` table for email verification and password reset, an auth audit log, rate limiting on `CacheService.consumeRateLimit`, and a full route surface including Google social login.

Consequences:

| v1 said                                                     | v2 says                                                                                               |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| No TypeScript product has credentials                       | **SoloDesk does**, and it is well built                                                               |
| Write a new module in `identity`                            | **Reuse SoloDesk's implementation**; the work is extraction and hardening, not greenfield             |
| Learning would be the first consumer                        | Learning is the **second**, which makes the promotion checklist properly evaluable                    |
| Admit as a declared single-consumer exception, like `oidc/` | **No exception needed.** Converge two real implementations, then promote on the checklist's own terms |
| Effort 2–4 weeks                                            | Materially less for Learning; the design questions are already answered                               |

The rejection of Cognito, Keycloak, and the other vendors (§4) survives unchanged and is in fact strengthened: the organisation has already demonstrated it can build this well.

---

## 1. Summary

Do not add a credential module to `identity` yet, and do not adopt an external identity vendor.

1. **Learning adopts SoloDesk's implementation** as its reference, rather than designing afresh.
2. **Harden four specific gaps** found in that implementation (§6). These are real and worth fixing in SoloDesk regardless of Learning.
3. **Promote to `identity` 7.1.0** once Learning and SoloDesk have converged and the promotion checklist's three conditions genuinely hold.

This sequencing follows the repo's own rule instead of working around it.

---

## 2. What `identity` 7.0.0 already provides

Established by reading the source.

### 2.1 Token issuance

`signAccessToken` — ES256 through an **injected** signer, so the package carries no JWT library. Claims: `sub`, `contextId`, `sessionId`, `jti` (uuidv7), product `claims`, `authMethod`.

`generateRefreshToken` — 32 bytes CSPRNG, base64url; **only the SHA-256 is persisted**, so a database leak cannot be replayed. `hashToken` is exported and is already reused by SoloDesk for its verification tokens.

### 2.2 Refresh rotation and theft detection

Atomic single-use rotation through a compare-and-swap (`revokeByIdIfActive`) inside a transaction, so exactly one concurrent request wins and the loser never creates a second live session. A cache-backed grace window replays successor tokens for benign reuse — multiple tabs, retried requests, React StrictMode — while genuine replay escalates to **family revocation** via the preserved `familyId`. CSRF double-submit is enforced on refresh with a fresh token per rotation.

### 2.3 Revocation

Three levels: token (`denylist:{jti}`), user (`denylist:user:{userId}`, with `unrevokeUser`), and family. Cache-unavailable behaviour is fail-open by design — tokens still expire via `exp`.

### 2.4 Federation and sessions

Provider-agnostic OIDC broker with mandatory discovery, PKCE S256, nonce, single-use `state`, JWKS verification, `ConnectionRegistry`, and secrets held by reference only. Connections typed `directory` or `shared`. BFF flow with opaque server-side sessions. `JwtAuthGuard` checks token and user denylists in parallel and normalises infrastructure errors to 401.

### 2.5 The seam for passwords

`authMethod: 'password' | 'sso'` runs through the token claims, session model, and rotation path. `AuthSession.ssoProvider` is documented as _"null for password sessions"_. `User.emailVerified` and `User.locale` already exist. `devLogin` is this exact path minus credential verification, hard-disabled in production.

The package was designed with a password path in mind. SoloDesk filled it in the product, which is where the checklist says the first implementation belongs.

---

## 3. What SoloDesk already built

`solodesk/services/backend-api` — NestJS + Fastify + Drizzle, consuming all four `@quynhonsemiconductor/*` packages.

| Area          | Implementation                                                                                                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Hashing       | `platform/auth/password.service.ts` — argon2id via `argon2` ^0.45.1                                                                                                                                          |
| Tokens        | `db/schema/auth-tokens.ts` — one table, `purpose` discriminator (`email_verify` \| `password_reset`), `token_hash` unique, `used_at`, `expires_at`. Reuses the package's `hashToken`.                        |
| Audit         | `db/schema/auth-audit-log.ts`, `infrastructure/auth-audit.service.ts`                                                                                                                                        |
| Rate limiting | `CacheService.consumeRateLimit` — an atomic Lua sliding window on Valkey, already in `platform-cache`. Login 5 per 15 min per email; forgot-password 3/hr; signup 10/hr per IP; slot redemption 8/hr per IP. |
| Routes        | `signup`, `verify-email`, `login`, `redeem-slot`, **`google`**, `refresh`, `logout`, `logout-all`, `me`, `update-me`, `forgot-password`, `reset-password`                                                    |
| Services      | `login.service.ts`, `signup.service.ts`, `session-minter.ts`, `slot-redemption.service.ts`                                                                                                                   |

**Quality is high.** The reset path burns _every_ outstanding reset token for the user, not only the redeemed one, with a written explanation of the takeover it prevents — an attacker's reset request is precisely what prompts the owner to reset, so older live tokens are a real path back in. Email-verify tokens are deliberately _not_ swept, with the reasoning stated. Session revocation follows.

That is a better-reasoned implementation than the one v1 of this document proposed.

**Google social login already exists.** This materially reduces the open question about whether Learning needs a vendor for social auth.

---

## 4. Vendors considered and rejected

Every managed or self-hosted identity product supplies a directory **and** duplicates the broker and session layer already owned.

| Shape                            | Examples                                  | Credentials live | New runtime service             | New PII processor |
| -------------------------------- | ----------------------------------------- | ---------------- | ------------------------------- | ----------------- |
| **A — in-product or in-package** | current approach; Better Auth; Auth.js v6 | Own PostgreSQL   | No                              | **No**            |
| **B — self-hosted IdP**          | Keycloak, Zitadel, Logto, Ory, Authentik  | Its own database | Yes, on the critical login path | No                |
| **C — managed IdP**              | Cognito, Auth0, Clerk, WorkOS, Descope    | Vendor-held      | No                              | **Yes**           |

| Option                                | Rejected because                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Amazon Cognito**                    | A second store of personal data to reconcile against `users`; a second processor to declare under Decree 13/2023; two-phase deletion on every erasure request; an immutable user-pool attribute schema; and password hashes that cannot be exported, so migration would force a reset for every user. It also buys operational relief the org has already demonstrated it does not need — SoloDesk ships this today. |
| **Keycloak**                          | Rejected by ADR-17 on self-host burden. A Java service plus its own PostgreSQL plus HA plus CVE cadence, duplicating ~70% of `identity`.                                                                                                                                                                                                                                                                             |
| **Zitadel / Logto / Ory / Authentik** | Same Shape-B objection. Zitadel is the strongest and would be right if a standalone IdP were needed; it is not.                                                                                                                                                                                                                                                                                                      |
| **Better Auth**                       | MIT, TypeScript-native, credentials in your own database — genuinely attractive. Rejected because it is designed to **own session management**, which would sit on top of a mature session layer that already exists and is already relied on by three services.                                                                                                                                                     |
| **Auth0 / Clerk / Descope**           | Per-MAU pricing at consumer scale, higher lock-in, no AWS-native offset.                                                                                                                                                                                                                                                                                                                                             |

**The case rests on architecture and law, not cost.** Cognito at a few thousand users is inexpensive. The argument is that mechanism belongs inside the boundary `identity` already draws, and that holding personal data in one store with one deletion path is simpler to operate and to defend under audit.

---

## 5. Admission and promotion

### 5.1 The primary rule — passes

> A file enters this repo only if divergence between products would be a **security defect** or a **cross-repo contract break**.

Two divergent copies of password verification are two security postures, bug class account takeover — the same clause that admitted refresh rotation, theft detection, PKCE, and single-use `state`. Password hashing carries **no product vocabulary**, so the drift that made `permissionGrants` unusable cannot occur.

### 5.2 The promotion checklist — now genuinely evaluable

> Promote when all three hold: byte-identical between products; the same edit twice; imports no product schema or permission type.

| Condition                                     | Status                                                                                                                                   |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Byte-identical between products               | **Not yet** — Learning has not been built                                                                                                |
| Same edit twice                               | **Not yet**                                                                                                                              |
| No product schema or permission type imported | `PasswordService` already satisfies this. The token _table_ is Drizzle + product schema and stays product-side behind a repository port. |

**So the answer is: not yet, and that is the correct answer.** v1 of this document argued for a declared exception on the `oidc/` precedent. That argument is no longer needed and should not be used — with SoloDesk plus Learning there is a real path to satisfying the checklist honestly, and taking a second exception when the ordinary route is available would erode the rule.

### 5.3 Consumer reality

| Product            | Local credentials?                                                      |
| ------------------ | ----------------------------------------------------------------------- |
| `rova`             | No — Entra-only                                                         |
| `opshub`           | No — Entra-only                                                         |
| **SoloDesk**       | **Yes — the reference implementation**                                  |
| **Learning**       | Yes — the second consumer                                               |
| Knowledge Base     | Yes, but **in Python** — `qnsc-kb-backend/src/core/security.py`, bcrypt |
| Hospital Camera AI | Unknown                                                                 |

### 5.4 The divergence this repo cannot fix

Knowledge Base uses **bcrypt in Python**; SoloDesk uses **argon2id in TypeScript**. Two products, two password postures — exactly the situation the admission test's security-defect clause is about. But `app-platform` publishes TypeScript packages, so the shared-code remedy is unavailable across the language boundary.

If cross-language consistency matters, the only mechanism that spans both is a **written parameter standard** — algorithm, cost parameters, token TTLs, rate-limit curves, revocation-on-reset requirements — that each stack implements independently and each is reviewed against. That is a separate decision, and it is a document, not a package.

---

## 6. Gaps found in the current implementation

These apply to SoloDesk today and would be inherited by Learning if copied unexamined. Each is narrow and fixable.

### 6.1 No timing equalisation — enumeration by latency

```ts
const passwordOk = found?.passwordHash
  ? await this.passwordService.verify(found.passwordHash, password)
  : false;
```

When the user does not exist, no argon2 work happens, so the response returns in a fraction of the time. Account existence is measurable from outside.

**Fix:** verify against a fixed precomputed hash when the user is absent, so both paths pay the same cost.

### 6.2 Distinguishable error codes — enumeration by response

`INVALID_CREDENTIALS`, `EMAIL_NOT_VERIFIED`, `ACCOUNT_NOT_ACTIVE`, and `NO_TENANT_MEMBERSHIP` are separately observable. An attacker learns which addresses are registered, and something about their state.

This is a genuine usability-versus-disclosure trade-off, and many products accept it deliberately. It should be an explicit, recorded decision rather than an accident — and Learning, whose learners are a public consumer population, may want to weigh it differently from SoloDesk's known cohort.

### 6.3 argon2 parameters unpinned, and no rehash path

```ts
argon2.hash(plain, { type: argon2.argon2id });
```

Cost parameters come from the library's defaults, so they shift silently on upgrade. There is no `algo`/parameters column stored beside the hash, so **transparent rehash-on-login is impossible** when parameters are later raised.

**Fix:** pin `memoryCost`, `timeCost`, `parallelism` explicitly, benchmarked to roughly 50–100 ms on the target task size; store the algorithm and parameters alongside the hash; rehash on successful login when they differ from current policy.

### 6.4 Login rate limit is per-email only

`auth:login:${email}` limits 5 attempts per 15 minutes per address. A spray attack trying one password across thousands of addresses from a single source is never limited.

**Fix:** add a per-IP counter alongside the per-email one, as signup and slot redemption already do.

### 6.5 Confirmed sound — no change needed

- Raw tokens never stored; SHA-256 only, reusing the package's `hashToken`
- Reset burns **every** outstanding reset token for the user, with the takeover reasoning documented
- Email-verify tokens deliberately not swept, with reasoning
- Session revocation follows a completed reset
- Rate limiting is atomic (Lua sliding window), not read-then-write
- `emailVerified` and account status both enforced on the credential path

---

## 7. Recommended sequence

1. **Fix §6.1, §6.3, §6.4 in SoloDesk.** They are defects today, independent of Learning. §6.2 is a decision to record, not necessarily to change.
2. **Learning builds its auth module from SoloDesk's**, hardened. Not a fork — a deliberate second implementation with the same shape, so convergence is visible.
3. **Track the divergence.** When both have taken the same edit twice, the checklist is satisfied honestly.
4. **Promote to `identity` 7.1.0:** `PasswordService` (parameterised), a `VerificationTokenService` behind a repository port, and the reset-revocation contract. All ports optional, so `rova` and `opshub` upgrade with no code change.
5. **`platform-http` 4.1.0** for shared error codes, if and only if both frontends branch on them — the same justification recorded for the existing `DomainException` mapping.
6. **Decide the cross-language standard** (§5.4) separately.

---

## 8. What stays in the product, permanently

Controllers, DTOs, route names, cookie names (removed from the package in v6.0.0 for exactly this reason) · email templates and delivery, localized from `User.locale` · password policy — minimum length 12, no composition rules per NIST SP 800-63B · rate-limit thresholds, which are policy even though the counting mechanism is shared · registration, invitation, and slot-redemption flows, which are product vocabulary.

---

## 9. Security checklist

For Learning's implementation, and for the SoloDesk hardening in §6.

- [ ] argon2id with **explicitly pinned** parameters, benchmarked on the target task size
- [ ] Algorithm and parameters stored beside the hash; rehash-on-login when policy changes
- [ ] Timing equalised for non-existent users
- [ ] Enumeration posture explicitly decided and recorded (§6.2)
- [ ] Rate limiting per account **and** per IP on every credential path
- [ ] Raw tokens never persisted — SHA-256 only
- [ ] Verification tokens single-use via compare-and-swap
- [ ] Reset burns all outstanding reset tokens for the user
- [ ] Reset revokes all refresh families **and** sets user-level access-token revocation
- [ ] Suspended, inactive, and soft-deleted accounts rejected on the credential path
- [ ] No credential material in logs — check against the `observability` `redact` list
- [ ] Minimum length 12, no composition rules

---

## 10. Open questions

1. **Does Learning need Google social login?** SoloDesk already implements it, so the answer no longer requires a vendor either way.
2. **Passkeys at launch?** Still the one requirement that would favour Cognito. `@simplewebauthn/server` is the alternative.
3. **Email transport** — `rova` provisions `aws_sesv2_email_identity` in Terraform and also carries `resend`. SoloDesk has its own path. Settle on one before Learning adds a fourth.
4. **Is a cross-language password standard wanted** (§5.4), given KB is bcrypt-on-Python?
5. **Who owns the §6 fixes in SoloDesk**, and on what timeline? They are live defects, not Learning's backlog.
