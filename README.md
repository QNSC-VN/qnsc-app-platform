# qnsc-app-platform

Shared **application-layer** packages for QNSC product backends (`rally`,
`opshub`, and future products). This repo does for application code what
[`qnsc-tf-modules`](https://github.com/QNSC-VN/qnsc-tf-modules) does for
infrastructure: **one implementation, independently versioned, consumed by many
products** — eliminating the copy-mirror drift that previously lived in each
product's `libs/`.

> Publishing model: **share the code, not the runtime.** Each product keeps its
> own Valkey, its own sessions, and its own ECS tasks. These packages are
> build-time dependencies only.

## Packages

| Package                                              | Purpose                                                                                                | Tag prefix          |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------- |
| [`@qnsc-vn/identity`](packages/identity)             | Auth service, refresh rotation, CSRF, JWT strategy, guards, SSO/Entra validation, BFF session handlers | `identity-v*`       |
| [`@qnsc-vn/platform-cache`](packages/platform-cache) | Valkey/Redis cache service (ioredis wrapper, key-prefix, fail-open)                                    | `platform-cache-v*` |
| [`@qnsc-vn/platform-http`](packages/platform-http)   | Fastify bootstrap, CORS, cookie config, error codes, OTel wiring                                       | `platform-http-v*`  |

Each package is versioned and released **independently** via release-please
(Conventional Commits), mirroring the per-module tag model of `qnsc-tf-modules`.

## Consuming these packages

Packages are published to **GitHub Packages** under the `@qnsc-vn` scope. In a
consumer repo (`rally`, `opshub`), add an `.npmrc`:

```ini
@qnsc-vn:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

Then pin the package in `package.json`:

```jsonc
{
  "dependencies": {
    "@qnsc-vn/identity": "1.0.0",
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
  identity/         @qnsc-vn/identity
  platform-cache/   @qnsc-vn/platform-cache
  platform-http/    @qnsc-vn/platform-http
.github/workflows/
  ci.yml            lint · typecheck · test · build (PRs + main)
  release-please.yml  per-package release PRs (calls qnsc-ci reusable)
  publish.yml       publish to GitHub Packages on <package>-v* tag
```
