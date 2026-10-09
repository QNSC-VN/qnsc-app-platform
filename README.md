# app-platform

Shared **application-layer** packages for QNSC product backends (`rally`,
`opshub`, and future products). This repo does for application code what
[`tf-modules`](https://github.com/quynhonsemiconductor/tf-modules) does for
infrastructure: **one implementation, independently versioned, consumed by many
products** — eliminating the copy-mirror drift that previously lived in each
product's `libs/`.

> Publishing model: **share the code, not the runtime.** Each product keeps its
> own Valkey, its own sessions, and its own deployment. These packages are
> build-time dependencies only.

## Packages

| Package                                                               | Purpose                                                                                                                                                                                                                        | Tag prefix            |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------- |
| [`@quynhonsemiconductor/identity`](packages/identity)                 | Auth **mechanism**: refresh rotation with theft detection, Entra/SSO verification, token denylist, JWT strategy, BFF session flow. Authorization stays in the product                                                          | `identity-v*`         |
| [`@quynhonsemiconductor/platform-cache`](packages/platform-cache)     | Valkey/Redis cache service (ioredis wrapper, key-prefix, fail-open)                                                                                                                                                            | `platform-cache-v*`   |
| [`@quynhonsemiconductor/platform-http`](packages/platform-http)       | Error taxonomy + HTTP status mapping, global exception filter, pagination                                                                                                                                                      | `platform-http-v*`    |
| [`@quynhonsemiconductor/observability`](packages/observability)       | OTel bootstrap, logger factory, ALS request/job context, metric instruments, fail-open contract                                                                                                                                | `observability-v*`    |
| [`@quynhonsemiconductor/platform-runtime`](packages/platform-runtime) | `.env` loading (subpath, pre-OTel), env validation + typed config, leader-elected scheduled jobs, request-arrival timing                                                                                                       | `platform-runtime-v*` |
| [`@quynhonsemiconductor/platform-db`](packages/platform-db)           | PostgreSQL connection layer: password auth from the CloudNativePG secret, TLS verified against the cluster CA, pool, readiness ping, advisory lock, `DbExecutor` + `withTransaction`. Drizzle at `/drizzle`, NestJS at `/nest` | `platform-db-v*`      |

Each package is versioned and released **independently** via release-please
(Conventional Commits), mirroring the per-module tag model of `tf-modules`.

`packages/testing` (`@quynhonsemiconductor/testing`) is **private and never published**: the
testcontainers harness (PostgreSQL 18, Valkey) that the other packages' tests share. See its
[README](packages/testing/README.md).

**Before adding anything here, read [docs/ADMISSION-TEST.md](docs/ADMISSION-TEST.md).**
A file belongs in this repo only if divergence between products would be a security
defect or a cross-repo contract break; if divergence would merely be inconsistent,
it stays in the product. That document records the rule, the promotion checklist,
and why each current exception is one.

## Consuming these packages

Packages are published to **GitHub Packages** under the `@quynhonsemiconductor` scope. In a
consumer repo (`rova`, `opshub`, `solodesk`), add an `.npmrc`:

```ini
@quynhonsemiconductor:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

Then declare the packages in `package.json`:

```jsonc
{
  "dependencies": {
    "@quynhonsemiconductor/identity": "^7.1.0",
  },
}
```

### Renovate: one grouped pull request

Products take **all** `@quynhonsemiconductor/*` updates in a single Renovate PR, so a platform
change that spans packages (say `platform-db` and `platform-runtime`) lands, and is tested, as
one unit. Add this rule to the product's `renovate.json`:

```jsonc
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["local>quynhonsemiconductor/.github:renovate-config"],
  "packageRules": [
    {
      "groupName": "app-platform",
      "matchPackageNames": ["/^@quynhonsemiconductor\\//"],
      "minimumReleaseAge": "1 day",
      "automerge": false,
    },
  ],
}
```

- `matchPackageNames` with a `/regex/` is the current form of `matchPackagePatterns`
  (`["^@quynhonsemiconductor/"]`), which Renovate has deprecated.
- `minimumReleaseAge: "1 day"` matches pnpm 11's default `minimumReleaseAge` (one day). A
  Renovate PR that bumps to a release younger than that fails `pnpm install` on the product's
  lockfile policy check, so Renovate should not open it until the release has aged.
- The org preset already has a rule named `qnsc platform packages` for the same scope. A rule in
  the product's own `renovate.json` is applied after the preset, so it wins where they overlap.
- Versions stay independent per package (tags `<package>-v<version>`); only the PR is grouped.

## Pull requests: canary packages and consumer CI

Every pull request does two things automatically, so a platform change can never break a product
silently.

**Canary packages** (`.github/workflows/canary.yml`). Each package the PR changes is published to
GitHub Packages as `<version>-pr.<number>.<sha7>` under the dist-tag `pr-<number>`:

```bash
pnpm add @quynhonsemiconductor/platform-http@pr-123
```

A prerelease never satisfies a plain range like `^4.1.0` and `latest` is untouched, so nothing
picks a canary up unless it asks. The job that publishes holds `packages: write` and runs no code
from the PR; it only uploads tarballs built by a separate, credential-free job. Same-repo PRs only.

**Consumer CI** (`Consumer · rova`, `Consumer · opshub`, `Consumer · solodesk` in `ci.yml`). Each
product is checked out, every `@quynhonsemiconductor/*` dependency is pointed at a tarball packed
from the PR, and the product's `typecheck` and unit tests run. Tarballs rather than the canary
registry versions, so a package that has never been published installs the same way and the real
version numbers keep peer ranges satisfiable. The job fails if the product depends on none of our
packages, so it cannot pass by testing the registry versions instead. solodesk is typecheck-only:
its services have only database-backed e2e suites, which need infrastructure the job does not start.

Products are read through the read-only org GitHub App `qnsc-repo-reader` (`contents: read`;
`vars.QNSC_REPO_READER_APP_ID`, `secrets.QNSC_REPO_READER_PRIVATE_KEY`). The write-capable
automation App is never used in a pull-request workflow. These jobs do not yet block merging;
they join the `CI required` gate once green on three consecutive PRs.

## Local development

Node 24 and pnpm 11 (see `.nvmrc` and `packageManager`). Docker is needed for the tests that start
PostgreSQL or Valkey; without it they are skipped locally, and fail on CI.

```bash
pnpm install
pnpm build        # tsc build every package (CJS + .d.ts)
pnpm typecheck
pnpm test         # vitest across all packages
pnpm lint
```

## Release

1. Land Conventional-Commit PRs to `main`.
2. release-please opens **one** combined release PR for every package with pending changes.
3. Merging it tags each `<package>-v<version>` and the publish workflow pushes each package to
   GitHub Packages. The tag allowlist in `publish.yml` is explicit on purpose (that workflow holds
   publish credentials), so a new package adds its own `'<component>-v*'` entry.

## Repository layout

```
packages/
  identity/          @quynhonsemiconductor/identity
  observability/     @quynhonsemiconductor/observability
  platform-cache/    @quynhonsemiconductor/platform-cache
  platform-db/       @quynhonsemiconductor/platform-db
  platform-http/     @quynhonsemiconductor/platform-http
  platform-runtime/  @quynhonsemiconductor/platform-runtime
  testing/           @quynhonsemiconductor/testing   (private, never published)
tools/
  consumer-ci/       pack, link and test helpers for the canary and consumer-CI workflows
docs/
  adr/               architecture decision records
.github/workflows/
  ci.yml             lint · typecheck · test · build, plus consumer CI (PRs + main)
  canary.yml         publish changed packages as pr-<number> canaries (PRs)
  security.yml       dependency, SAST and secret scans
  release-please.yml combined release PR (calls ci reusable)
  publish.yml        publish to GitHub Packages on <package>-v* tag
```
