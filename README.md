# app-platform

Shared **application-layer** packages for QNSC product backends (`rally`,
`opshub`, and future products). This repo does for application code what
[`tf-modules`](https://github.com/quynhonsemiconductor/tf-modules) does for
infrastructure: **one implementation, independently versioned, consumed by many
products** — eliminating the copy-mirror drift that previously lived in each
product's `libs/`.

> Publishing model: **share the code, not the runtime.** Each product keeps its
> own Valkey, its own sessions, and its own ECS tasks. These packages are
> build-time dependencies only.

## Packages

| Package                                              | Purpose                                                                                                                                                               | Tag prefix          |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| [`@quynhonsemiconductor/identity`](packages/identity)             | Auth **mechanism**: refresh rotation with theft detection, Entra/SSO verification, token denylist, JWT strategy, BFF session flow. Authorization stays in the product | `identity-v*`       |
| [`@quynhonsemiconductor/platform-cache`](packages/platform-cache) | Valkey/Redis cache service (ioredis wrapper, key-prefix, fail-open)                                                                                                   | `platform-cache-v*` |
| [`@quynhonsemiconductor/platform-http`](packages/platform-http)   | Error taxonomy + HTTP status mapping, global exception filter, pagination                                                                                             | `platform-http-v*`  |
| [`@quynhonsemiconductor/observability`](packages/observability)   | OTel bootstrap, logger factory, ALS request/job context, metric instruments, fail-open contract                                                                       | `observability-v*`  |
| [`@quynhonsemiconductor/platform-runtime`](packages/platform-runtime) | `.env` loading (subpath, pre-OTel), env validation + typed config, leader-elected scheduled jobs, request-arrival timing | `platform-runtime-v*` |
| [`@quynhonsemiconductor/platform-db`](packages/platform-db) | PostgreSQL connection layer: password auth from the CloudNativePG secret, TLS verified against the cluster CA, pool, readiness ping, advisory lock, `DbExecutor` + `withTransaction`. Drizzle at `/drizzle`, NestJS at `/nest` | `platform-db-v*` |

Each package is versioned and released **independently** via release-please
(Conventional Commits), mirroring the per-module tag model of `tf-modules`.

**Before adding anything here, read [docs/ADMISSION-TEST.md](docs/ADMISSION-TEST.md).**
A file belongs in this repo only if divergence between products would be a security
defect or a cross-repo contract break; if divergence would merely be inconsistent,
it stays in the product. That document records the rule, the promotion checklist,
and why each current exception is one.

## Consuming these packages

Packages are published to **GitHub Packages** under the `@quynhonsemiconductor` scope. In a
consumer repo (`rally`, `opshub`), add an `.npmrc`:

```ini
@quynhonsemiconductor:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

Then pin the package in `package.json`:

```jsonc
{
  "dependencies": {
    "@quynhonsemiconductor/identity": "1.0.0",
  },
}
```

Renovate proposes updates **within each package's own tag series** (see
`renovate.json` in consumer repos).

## Local development

```bash
pnpm install
pnpm build        # tsc build every package (CJS + .d.ts)
pnpm typecheck
pnpm test         # vitest across all packages
pnpm lint
```

## Release

1. Land Conventional-Commit PRs to `main`.
2. release-please opens a per-package "release" PR.
3. Merging it tags `<package>-v<version>` and the publish workflow pushes the
   package to GitHub Packages.

## Repository layout

```
packages/
  identity/         @quynhonsemiconductor/identity
  platform-cache/   @quynhonsemiconductor/platform-cache
  platform-http/    @quynhonsemiconductor/platform-http
  platform-db/      @quynhonsemiconductor/platform-db
.github/workflows/
  ci.yml            lint · typecheck · test · build (PRs + main)
  release-please.yml  per-package release PRs (calls ci reusable)
  publish.yml       publish to GitHub Packages on <package>-v* tag
```
