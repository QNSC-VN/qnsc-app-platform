# Changelog

## [3.1.0](https://github.com/QNSC-VN/qnsc-app-platform/compare/platform-http-v3.0.0...platform-http-v3.1.0) (2026-07-18)


### ✨ Features

* **platform-http:** map HTTP 412 to PRECONDITION_FAILED ([#52](https://github.com/QNSC-VN/qnsc-app-platform/issues/52)) ([f166300](https://github.com/QNSC-VN/qnsc-app-platform/commit/f166300d437e332bd5da15660a91d71106c76833))

## [3.0.0](https://github.com/QNSC-VN/qnsc-app-platform/compare/platform-http-v2.0.0...platform-http-v3.0.0) (2026-07-11)


### ⚠ BREAKING CHANGES

* **platform-http:** @qnsc-vn/platform-cache is now a peerDependency and must be provided by the consumer; requires >=2.0.0.

### ✨ Features

* **platform-http:** consume CacheService and make platform-cache a peer dependency ([4f888d7](https://github.com/QNSC-VN/qnsc-app-platform/commit/4f888d70b9a532ec727fd60445cbc2ddd480b3c7))

## [2.0.0](https://github.com/QNSC-VN/qnsc-app-platform/compare/platform-http-v1.0.1...platform-http-v2.0.0) (2026-07-10)


### ⚠ BREAKING CHANGES

* **platform-http:** root-level flat pagination exports (buildPageResult, encodeCursor, PageQuerySchema, ...) are relocated under the cursorPagination namespace; import them via cursorPagination.*.

### ✨ Features

* **platform-http:** expose cursor and offset pagination as namespaces ([8cf96dc](https://github.com/QNSC-VN/qnsc-app-platform/commit/8cf96dcee6ca0189a5674e9c05f28a5f21d07122))

## [1.0.1](https://github.com/QNSC-VN/qnsc-app-platform/compare/platform-http-v1.0.0...platform-http-v1.0.1) (2026-07-10)


### 🐛 Bug Fixes

* **release:** rename npm scope [@qnsc](https://github.com/qnsc) to [@qnsc-vn](https://github.com/qnsc-vn) to match GitHub Packages org ([#20](https://github.com/QNSC-VN/qnsc-app-platform/issues/20)) ([7c82f2c](https://github.com/QNSC-VN/qnsc-app-platform/commit/7c82f2c94f26efd02f232d5a3c7784b88fab154c))

## 1.0.0 (2026-07-10)

### ✨ Features

- **platform-http:** add Valkey-backed rate-limit guard, tiers + decorators ([#17](https://github.com/QNSC-VN/qnsc-app-platform/issues/17)) ([7dda749](https://github.com/QNSC-VN/qnsc-app-platform/commit/7dda7493800af547a16a93affd12e60298d6c07b))
- **platform-http:** extract error taxonomy, exception filter & pagination from rally ([#6](https://github.com/QNSC-VN/qnsc-app-platform/issues/6)) ([7545bb6](https://github.com/QNSC-VN/qnsc-app-platform/commit/7545bb6ba7b6d7ee53176356afa2a241ea11611c))
- **platform-http:** extract HTTP logging & idempotency interceptors and request-context service from rally ([#8](https://github.com/QNSC-VN/qnsc-app-platform/issues/8)) ([45043c4](https://github.com/QNSC-VN/qnsc-app-platform/commit/45043c4b81df7cd98224782ac79b2b87e511c26d))
- scaffold qnsc-app-platform shared package repo ([cafd6b5](https://github.com/QNSC-VN/qnsc-app-platform/commit/cafd6b5bc7a905eb49c97627ff949eba7f27185e))
