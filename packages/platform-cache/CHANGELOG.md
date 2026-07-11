# Changelog

## [2.0.0](https://github.com/QNSC-VN/qnsc-app-platform/compare/platform-cache-v1.0.0...platform-cache-v2.0.0) (2026-07-11)


### ⚠ BREAKING CHANGES

* **platform-cache:** ValkeyService/VALKEY_OPTIONS are removed. Use CacheService and CACHE_OPTIONS. Auth-token denylist/rotation/revocation now live in @qnsc-vn/identity (AuthTokenCache).

### ✨ Features

* **platform-cache:** replace ValkeyService with generic mode-aware CacheService ([8598871](https://github.com/QNSC-VN/qnsc-app-platform/commit/8598871bb07e218e3ab9b3b8ddeadd099eff0e6c))

## 1.0.0 (2026-07-10)


### ✨ Features

* **platform-cache:** extract ValkeyService from rally ([#5](https://github.com/QNSC-VN/qnsc-app-platform/issues/5)) ([0055f84](https://github.com/QNSC-VN/qnsc-app-platform/commit/0055f841c5d3fba36ed285b2ebea7d6c688c04ce))
* scaffold qnsc-app-platform shared package repo ([cafd6b5](https://github.com/QNSC-VN/qnsc-app-platform/commit/cafd6b5bc7a905eb49c97627ff949eba7f27185e))


### 🐛 Bug Fixes

* **release:** rename npm scope [@qnsc](https://github.com/qnsc) to [@qnsc-vn](https://github.com/qnsc-vn) to match GitHub Packages org ([#20](https://github.com/QNSC-VN/qnsc-app-platform/issues/20)) ([7c82f2c](https://github.com/QNSC-VN/qnsc-app-platform/commit/7c82f2c94f26efd02f232d5a3c7784b88fab154c))
