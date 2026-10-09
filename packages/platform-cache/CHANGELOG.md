# Changelog

## [3.1.1](https://github.com/quynhonsemiconductor/app-platform/compare/platform-cache-v3.1.0...platform-cache-v3.1.1) (2026-10-09)


### 🐛 Bug Fixes

* **platform-cache:** quit the client in onApplicationShutdown, not onModuleDestroy ([9fd069b](https://github.com/quynhonsemiconductor/app-platform/commit/9fd069b0b26976088112cd5d862d50fbfd82f058))

## [3.1.0](https://github.com/quynhonsemiconductor/app-platform/compare/platform-cache-v3.0.0...platform-cache-v3.1.0) (2026-09-08)


### ✨ Features

* add platform-runtime, make the conformance kit runnable against real adapters ([#98](https://github.com/quynhonsemiconductor/app-platform/issues/98)) ([486783f](https://github.com/quynhonsemiconductor/app-platform/commit/486783f69edd0090a8251626bd7b032909945c10))

## [3.0.0](https://github.com/quynhonsemiconductor/app-platform/compare/platform-cache-v2.1.0...platform-cache-v3.0.0) (2026-09-05)


### ⚠ BREAKING CHANGES

* package scope changed; update dependency names to the new scope.

### ✨ Features

* publish packages under the organization scope ([#91](https://github.com/quynhonsemiconductor/app-platform/issues/91)) ([cd3af62](https://github.com/quynhonsemiconductor/app-platform/commit/cd3af62cde67a78dda2798a4896cf902cf3c0a2a))

## [2.1.0](https://github.com/QNSC-VN/qnsc-app-platform/compare/platform-cache-v2.0.0...platform-cache-v2.1.0) (2026-07-11)


### ✨ Features

* **platform-cache:** make consumeRateLimit a true sliding window ([2dc2997](https://github.com/QNSC-VN/qnsc-app-platform/commit/2dc2997652ec878c7f36b9fc6b3d31dacf174529))
* unify cache/auth primitives (sliding-window rate limit + AuthTokenCache.unrevokeUser) ([8308ced](https://github.com/QNSC-VN/qnsc-app-platform/commit/8308cedab55a506c59a029cad416a7695db5c177))

## [2.0.0](https://github.com/QNSC-VN/qnsc-app-platform/compare/platform-cache-v1.0.0...platform-cache-v2.0.0) (2026-07-11)


### ⚠ BREAKING CHANGES

* **platform-cache:** ValkeyService/VALKEY_OPTIONS are removed. Use CacheService and CACHE_OPTIONS. Auth-token denylist/rotation/revocation now live in @quynhonsemiconductor/identity (AuthTokenCache).

### ✨ Features

* **platform-cache:** replace ValkeyService with generic mode-aware CacheService ([8598871](https://github.com/QNSC-VN/qnsc-app-platform/commit/8598871bb07e218e3ab9b3b8ddeadd099eff0e6c))

## 1.0.0 (2026-07-10)


### ✨ Features

* **platform-cache:** extract ValkeyService from rally ([#5](https://github.com/QNSC-VN/qnsc-app-platform/issues/5)) ([0055f84](https://github.com/QNSC-VN/qnsc-app-platform/commit/0055f841c5d3fba36ed285b2ebea7d6c688c04ce))
* scaffold qnsc-app-platform shared package repo ([cafd6b5](https://github.com/QNSC-VN/qnsc-app-platform/commit/cafd6b5bc7a905eb49c97627ff949eba7f27185e))


### 🐛 Bug Fixes

* **release:** rename npm scope [@qnsc](https://github.com/qnsc) to [@qnsc-vn](https://github.com/qnsc-vn) to match GitHub Packages org ([#20](https://github.com/QNSC-VN/qnsc-app-platform/issues/20)) ([7c82f2c](https://github.com/QNSC-VN/qnsc-app-platform/commit/7c82f2c94f26efd02f232d5a3c7784b88fab154c))
