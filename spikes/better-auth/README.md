# spikes/better-auth

**Throwaway.** WP-9: does Better Auth carry identity v8 on NestJS 11 + Fastify 5 + Drizzle? The result
is [`docs/adr/0002-identity-v8-better-auth.md`](../../docs/adr/0002-identity-v8-better-auth.md); this
directory is its evidence. Nothing here is published, released or imported by a package, and WP-10
writes `packages/identity` v8 from scratch rather than promoting this code.

It is **not** part of the pnpm workspace (`packages/*`): it has its own `pnpm-workspace.yaml` and
lockfile so Better Auth's dependency tree stays out of the root lockfile, the release config and the
root lint/typecheck/test runs.

## Run it

Needs Docker (PostgreSQL 18 and Valkey through `packages/testing`) and a built repo, because the
real `platform-db`, `platform-cache`, `platform-http` and `observability` are consumed as `file:`
dependencies of their `dist/`.

```bash
pnpm install && pnpm build          # repo root
cd spikes/better-auth
pnpm install
pnpm typecheck
pnpm test                           # 12 files, 111 tests, ~10 s
pnpm build && pnpm boot:cjs         # Better Auth loaded from plain CommonJS (Node 24 require(esm))
./scripts/regenerate-schema.sh      # auth generate -> src/db/schema.ts -> drizzle/ migration
```

Every generated credential (secrets, passwords, client secrets) is created at run time; nothing in
the tree is a real secret.

## Layout

| Path                                          | What it is                                                                                        |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `src/identity/create-identity.ts`             | `createIdentity()` as sketched in the identity plan §5.3 / A.1, written against Better Auth 1.7.7 |
| `src/identity/{storage,password,lockout}.ts`  | `secondaryStorage` over `platform-cache`; argon2id override; per-account lockout plugin           |
| `src/identity/{tx-context,job-email-port}.ts` | Captures Better Auth's Drizzle transaction so an email callback can enqueue through it            |
| `src/nest/*`                                  | Fastify mount of `auth.handler`, global `SessionGuard`, `IdentityModule`                          |
| `src/jobs/*`                                  | **Stand-ins** for `platform-jobs` (WP-7) and `platform-mail` (WP-8), with the §6.7 / §6.8 shapes  |
| `src/db/schema.ts`, `drizzle/`                | Generated: `auth generate` -> uuid ids in an `identity` schema -> `drizzle-kit`                   |
| `test/c01…c11-*.test.ts`                      | One file per §8.1 criterion (`c11` backs the "differences" criterion)                             |
| `test/support/mock-idp.ts`                    | A local OpenID Provider standing in for Entra and for a partner IdP                               |

## What is not real

- **Entra and the partner IdP** are a local mock. It proves Better Auth's handling (PKCE, state, claim
  mapping, tenant binding, provisioning); it cannot prove Entra's own behaviour. See the ADR's
  "Manual checks".
- **`platform-jobs` / `platform-mail`** do not exist yet. `src/jobs` has the same `send(queue, data,
{ tx, idempotencyKey })` shape and the same observable semantics (job written through the caller's
  `DbExecutor`; a duplicate key returns `null`), so the criterion-9 conclusions are about Better
  Auth, not about the queue. Re-run `c09` against the real packages when WP-7 lands.
