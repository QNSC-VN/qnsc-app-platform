# Changelog

## [0.2.2](https://github.com/quynhonsemiconductor/app-platform/compare/observability-v0.2.1...observability-v0.2.2) (2026-10-10)


### 🐛 Bug Fixes

* **observability,platform-http:** security/auth metrics never throw; say when DISABLE_RATE_LIMIT is ignored ([#158](https://github.com/quynhonsemiconductor/app-platform/issues/158)) ([7cecb0f](https://github.com/quynhonsemiconductor/app-platform/commit/7cecb0f680e808b2ac98efcfe2da1f3c560856ce))

## [0.2.1](https://github.com/quynhonsemiconductor/app-platform/compare/observability-v0.2.0...observability-v0.2.1) (2026-10-09)

### ✨ Features

- **observability:** k8s attributes, shared probe paths, label guard ([#145](https://github.com/quynhonsemiconductor/app-platform/issues/145)) ([fd7eb09](https://github.com/quynhonsemiconductor/app-platform/commit/fd7eb09ff7f8be8268b9fbe525741b24a7ee4521))

### 🔒 Security

- **deps:** clear the osv-scanner findings that turn the required check red ([#141](https://github.com/quynhonsemiconductor/app-platform/issues/141)) ([40749f7](https://github.com/quynhonsemiconductor/app-platform/commit/40749f70065df43a3776d1d3d96d0772dd0b5fc7))

## [0.2.0](https://github.com/quynhonsemiconductor/app-platform/compare/observability-v0.1.6...observability-v0.2.0) (2026-09-05)

### ⚠ BREAKING CHANGES

- package scope changed; update dependency names to the new scope.

### ✨ Features

- publish packages under the organization scope ([#91](https://github.com/quynhonsemiconductor/app-platform/issues/91)) ([cd3af62](https://github.com/quynhonsemiconductor/app-platform/commit/cd3af62cde67a78dda2798a4896cf902cf3c0a2a))

## [0.1.6](https://github.com/QNSC-VN/qnsc-app-platform/compare/observability-v0.1.5...observability-v0.1.6) (2026-08-31)

### ✨ Features

- **observability:** opt-in http.server.duration histogram boundaries ([#84](https://github.com/QNSC-VN/qnsc-app-platform/issues/84)) ([38aa1a2](https://github.com/QNSC-VN/qnsc-app-platform/commit/38aa1a296c5fbf21cdb2654171e7079d12dc46f0))

## [0.1.5](https://github.com/QNSC-VN/qnsc-app-platform/compare/observability-v0.1.4...observability-v0.1.5) (2026-08-30)

### ✨ Features

- **observability:** auth.login metric — is login itself working ([#82](https://github.com/QNSC-VN/qnsc-app-platform/issues/82)) ([807d2c1](https://github.com/QNSC-VN/qnsc-app-platform/commit/807d2c1957db6358d5aced021b1c04df5db7771c))

## [0.1.4](https://github.com/QNSC-VN/qnsc-app-platform/compare/observability-v0.1.3...observability-v0.1.4) (2026-07-27)

### 🐛 Bug Fixes

- **observability:** take deployment identity from DEPLOYMENT_ENV, not NODE_ENV ([#68](https://github.com/QNSC-VN/qnsc-app-platform/issues/68)) ([e0d6002](https://github.com/QNSC-VN/qnsc-app-platform/commit/e0d6002edd00a8ec61aa66f780acd103413b34d9))

## [0.1.3](https://github.com/QNSC-VN/qnsc-app-platform/compare/observability-v0.1.2...observability-v0.1.3) (2026-07-26)

### 🐛 Bug Fixes

- **observability:** pull-based pool gauges, one fail-open contract, shared ignore list ([#66](https://github.com/QNSC-VN/qnsc-app-platform/issues/66)) ([aac3b8e](https://github.com/QNSC-VN/qnsc-app-platform/commit/aac3b8e6faa99cad1ef26d2e6e592832816d1cf1))

## [0.1.2](https://github.com/QNSC-VN/qnsc-app-platform/compare/observability-v0.1.1...observability-v0.1.2) (2026-07-26)

### ✨ Features

- **observability:** metric instruments with bounded labels ([#64](https://github.com/QNSC-VN/qnsc-app-platform/issues/64)) ([b8eb80a](https://github.com/QNSC-VN/qnsc-app-platform/commit/b8eb80a0db24657b63850a097f920495218b4cc4))

## [0.1.1](https://github.com/QNSC-VN/qnsc-app-platform/compare/observability-v0.1.0...observability-v0.1.1) (2026-07-26)

### ✨ Features

- **observability:** shared OTel bootstrap, logger factory, and job context ([#62](https://github.com/QNSC-VN/qnsc-app-platform/issues/62)) ([c61765f](https://github.com/QNSC-VN/qnsc-app-platform/commit/c61765f09d87a97af873bd64aa720a7861bc51d5))
