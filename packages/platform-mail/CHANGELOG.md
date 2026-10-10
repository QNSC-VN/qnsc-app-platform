# Changelog

## [0.1.2](https://github.com/quynhonsemiconductor/app-platform/compare/platform-mail-v0.1.1...platform-mail-v0.1.2) (2026-10-10)


### ✨ Features

* **platform-jobs:** bound the time an unprocessed job may wait with retention.pending ([#204](https://github.com/quynhonsemiconductor/app-platform/issues/204)) ([b36f4b5](https://github.com/quynhonsemiconductor/app-platform/commit/b36f4b5aaa2ad56dd12cba0ac0f56cfc3ec9edbf))
* **platform-jobs:** redrive dead-letter jobs ([#188](https://github.com/quynhonsemiconductor/app-platform/issues/188)) ([434c2ba](https://github.com/quynhonsemiconductor/app-platform/commit/434c2bab91fe9bf67db31fd313e91e7b2a280565))


### 🐛 Bug Fixes

* **platform-mail:** make the NestJS example boot, and never start a send on an aborted attempt ([#202](https://github.com/quynhonsemiconductor/app-platform/issues/202)) ([6dd4515](https://github.com/quynhonsemiconductor/app-platform/commit/6dd4515d3547f4980c72e90ed217526eb680630d))

## [0.1.1](https://github.com/quynhonsemiconductor/app-platform/compare/platform-mail-v0.1.0...platform-mail-v0.1.1) (2026-10-10)


### ✨ Features

* **platform-mail:** add the email transport package ([#172](https://github.com/quynhonsemiconductor/app-platform/issues/172)) ([23d15ba](https://github.com/quynhonsemiconductor/app-platform/commit/23d15ba829a682d96efd465af1e336ff3f393cf9))


### 🐛 Bug Fixes

* **platform-mail:** refuse test senders in production, renew the claim, back off in place ([#187](https://github.com/quynhonsemiconductor/app-platform/issues/187)) ([49f4d0f](https://github.com/quynhonsemiconductor/app-platform/commit/49f4d0f4da26fd47400d1e3d93ff52a4b0f65de0))
