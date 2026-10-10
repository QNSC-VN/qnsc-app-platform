# Changelog

## [4.2.0](https://github.com/quynhonsemiconductor/app-platform/compare/platform-http-v4.1.0...platform-http-v4.2.0) (2026-10-10)


### ✨ Features

* **platform-http:** seed the correlation id from X-Correlation-Id, or generate one ([#178](https://github.com/quynhonsemiconductor/app-platform/issues/178)) ([487c923](https://github.com/quynhonsemiconductor/app-platform/commit/487c9239f1bcb3533a136134a39de0961ba578ba))


### 🐛 Bug Fixes

* **observability,platform-http:** security/auth metrics never throw; say when DISABLE_RATE_LIMIT is ignored ([#158](https://github.com/quynhonsemiconductor/app-platform/issues/158)) ([7cecb0f](https://github.com/quynhonsemiconductor/app-platform/commit/7cecb0f680e808b2ac98efcfe2da1f3c560856ce))

## [4.1.0](https://github.com/quynhonsemiconductor/app-platform/compare/platform-http-v4.0.2...platform-http-v4.1.0) (2026-10-09)

### ✨ Features

- **platform-http:** client IP and cache-required startup checks ([#147](https://github.com/quynhonsemiconductor/app-platform/issues/147)) ([7f76ebc](https://github.com/quynhonsemiconductor/app-platform/commit/7f76ebc64393c1645f4b82388c773a3936ce6921))

## [4.0.2](https://github.com/quynhonsemiconductor/app-platform/compare/platform-http-v4.0.1...platform-http-v4.0.2) (2026-10-08)

### ♻️ Refactors

- **platform-http:** own sanitizeString, and relocate orphaned tests ([#131](https://github.com/quynhonsemiconductor/app-platform/issues/131)) ([0be062f](https://github.com/quynhonsemiconductor/app-platform/commit/0be062f9ef38e3fed79e7db3deb963162bd12745))

### 🔒 Security

- **deps:** clear the osv-scanner findings that turn the required check red ([#141](https://github.com/quynhonsemiconductor/app-platform/issues/141)) ([40749f7](https://github.com/quynhonsemiconductor/app-platform/commit/40749f70065df43a3776d1d3d96d0772dd0b5fc7))

## [4.0.1](https://github.com/quynhonsemiconductor/app-platform/compare/platform-http-v4.0.0...platform-http-v4.0.1) (2026-09-08)

### 🐛 Bug Fixes

- **platform-http:** align the fastify devDependency on ^5.12.3 ([#122](https://github.com/quynhonsemiconductor/app-platform/issues/122)) ([ae9bf89](https://github.com/quynhonsemiconductor/app-platform/commit/ae9bf89b1007c4714a1286174fef0482f9a0a6c6))

## [4.0.0](https://github.com/quynhonsemiconductor/app-platform/compare/platform-http-v3.1.1...platform-http-v4.0.0) (2026-09-05)

### ⚠ BREAKING CHANGES

- package scope changed; update dependency names to the new scope.

### ✨ Features

- publish packages under the organization scope ([#91](https://github.com/quynhonsemiconductor/app-platform/issues/91)) ([cd3af62](https://github.com/quynhonsemiconductor/app-platform/commit/cd3af62cde67a78dda2798a4896cf902cf3c0a2a))

## [3.1.1](https://github.com/QNSC-VN/qnsc-app-platform/compare/platform-http-v3.1.0...platform-http-v3.1.1) (2026-08-07)

### 🐛 Bug Fixes

- **platform-http:** give 503 its own error code instead of INTERNAL_ERROR ([#77](https://github.com/QNSC-VN/qnsc-app-platform/issues/77)) ([0e11e39](https://github.com/QNSC-VN/qnsc-app-platform/commit/0e11e39d6921c8c9be989ce4bdd98b3d1286544c))

## [3.1.0](https://github.com/QNSC-VN/qnsc-app-platform/compare/platform-http-v3.0.0...platform-http-v3.1.0) (2026-07-18)

### ✨ Features

- **platform-http:** map HTTP 412 to PRECONDITION_FAILED ([#52](https://github.com/QNSC-VN/qnsc-app-platform/issues/52)) ([f166300](https://github.com/QNSC-VN/qnsc-app-platform/commit/f166300d437e332bd5da15660a91d71106c76833))

## [3.0.0](https://github.com/QNSC-VN/qnsc-app-platform/compare/platform-http-v2.0.0...platform-http-v3.0.0) (2026-07-11)

### ⚠ BREAKING CHANGES

- **platform-http:** @quynhonsemiconductor/platform-cache is now a peerDependency and must be provided by the consumer; requires >=2.0.0.

### ✨ Features

- **platform-http:** consume CacheService and make platform-cache a peer dependency ([4f888d7](https://github.com/QNSC-VN/qnsc-app-platform/commit/4f888d70b9a532ec727fd60445cbc2ddd480b3c7))

## [2.0.0](https://github.com/QNSC-VN/qnsc-app-platform/compare/platform-http-v1.0.1...platform-http-v2.0.0) (2026-07-10)

### ⚠ BREAKING CHANGES

- **platform-http:** root-level flat pagination exports (buildPageResult, encodeCursor, PageQuerySchema, ...) are relocated under the cursorPagination namespace; import them via cursorPagination.*.

### ✨ Features

- **platform-http:** expose cursor and offset pagination as namespaces ([8cf96dc](https://github.com/QNSC-VN/qnsc-app-platform/commit/8cf96dcee6ca0189a5674e9c05f28a5f21d07122))

## [1.0.1](https://github.com/QNSC-VN/qnsc-app-platform/compare/platform-http-v1.0.0...platform-http-v1.0.1) (2026-07-10)

### 🐛 Bug Fixes

- **release:** rename npm scope [@qnsc](https://github.com/qnsc) to [@qnsc-vn](https://github.com/qnsc-vn) to match GitHub Packages org ([#20](https://github.com/QNSC-VN/qnsc-app-platform/issues/20)) ([7c82f2c](https://github.com/QNSC-VN/qnsc-app-platform/commit/7c82f2c94f26efd02f232d5a3c7784b88fab154c))

## 1.0.0 (2026-07-10)

### ✨ Features

- **platform-http:** add Valkey-backed rate-limit guard, tiers + decorators ([#17](https://github.com/QNSC-VN/qnsc-app-platform/issues/17)) ([7dda749](https://github.com/QNSC-VN/qnsc-app-platform/commit/7dda7493800af547a16a93affd12e60298d6c07b))
- **platform-http:** extract error taxonomy, exception filter & pagination from rally ([#6](https://github.com/QNSC-VN/qnsc-app-platform/issues/6)) ([7545bb6](https://github.com/QNSC-VN/qnsc-app-platform/commit/7545bb6ba7b6d7ee53176356afa2a241ea11611c))
- **platform-http:** extract HTTP logging & idempotency interceptors and request-context service from rally ([#8](https://github.com/QNSC-VN/qnsc-app-platform/issues/8)) ([45043c4](https://github.com/QNSC-VN/qnsc-app-platform/commit/45043c4b81df7cd98224782ac79b2b87e511c26d))
- scaffold qnsc-app-platform shared package repo ([cafd6b5](https://github.com/QNSC-VN/qnsc-app-platform/commit/cafd6b5bc7a905eb49c97627ff949eba7f27185e))
