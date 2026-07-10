# Changelog

## [4.0.0](https://github.com/QNSC-VN/qnsc-app-platform/compare/identity-v3.0.0...identity-v4.0.0) (2026-07-10)


### ⚠ BREAKING CHANGES

* **identity:** consumers must install @qnsc-vn/platform-http (>=2.0.0) and @qnsc-vn/platform-cache (>=1.0.0) directly.

### ✨ Features

* **identity:** make platform-http and platform-cache peer dependencies ([1741221](https://github.com/QNSC-VN/qnsc-app-platform/commit/1741221417e6d9ef49af892717e20bc2c84188e9))

## [3.0.0](https://github.com/QNSC-VN/qnsc-app-platform/compare/identity-v2.0.0...identity-v3.0.0) (2026-07-10)


### ⚠ BREAKING CHANGES

* **identity:** WORKSPACE_SERVICE, ACCESS_SERVICE and SSO_CONNECTION_REPOSITORY are now @Optional(). When unbound, ssoLogin/devLogin mint a null-context session with no membership list, enabling single-tenant products (opshub) to adopt the shared AuthService. Adds ISsoProvisioningHook seam (SSO_PROVISIONING_HOOK) called after user resolution so products can reconcile Entra App Roles onto their RBAC, and exposes roles[] on EntraClaims. LoginResult.memberships is now optional.

### ✨ Features

* **identity:** make workspace/access services optional for single-tenant products ([c5eb996](https://github.com/QNSC-VN/qnsc-app-platform/commit/c5eb996591b33959efc68033f43d0b355f5537e5))

## [2.0.0](https://github.com/QNSC-VN/qnsc-app-platform/compare/identity-v1.0.1...identity-v2.0.0) (2026-07-10)


### ⚠ BREAKING CHANGES

* **identity:** JwtPayload.workspaceId, SignAccessTokenParams.workspaceId, AuthSession.workspaceId, CreateSessionInput.workspaceId and AuthContextSetter.setAuthContext's first parameter are renamed to contextId and typed `string | null`. Consumers must rename these fields and handle null.
* **identity:** JwtPayload.permissions is replaced by JwtPayload.claims; AuthService now requires a CLAIMS_PROVIDER binding; PermissionGuard reads claims.permissions.

### ✨ Features

* **identity:** add IClaimsProvider port for product-defined authz claims ([#26](https://github.com/QNSC-VN/qnsc-app-platform/issues/26)) ([c7cf7d3](https://github.com/QNSC-VN/qnsc-app-platform/commit/c7cf7d3be97957ed5dbb1a78d95cd03db9bf2f81))


### ♻️ Refactors

* **identity:** rename session/token workspaceId to nullable contextId ([#28](https://github.com/QNSC-VN/qnsc-app-platform/issues/28)) ([0efbbb3](https://github.com/QNSC-VN/qnsc-app-platform/commit/0efbbb32e7ce552bd0ba003f4000e503ec1253ae))

## [1.0.1](https://github.com/QNSC-VN/qnsc-app-platform/compare/identity-v1.0.0...identity-v1.0.1) (2026-07-10)


### 🐛 Bug Fixes

* **release:** rename npm scope [@qnsc](https://github.com/qnsc) to [@qnsc-vn](https://github.com/qnsc-vn) to match GitHub Packages org ([#20](https://github.com/QNSC-VN/qnsc-app-platform/issues/20)) ([7c82f2c](https://github.com/QNSC-VN/qnsc-app-platform/commit/7c82f2c94f26efd02f232d5a3c7784b88fab154c))

## 1.0.0 (2026-07-10)

### ✨ Features

- **identity:** add access/workspace/audit service ports + transaction runner ([#11](https://github.com/QNSC-VN/qnsc-app-platform/issues/11)) ([87c7529](https://github.com/QNSC-VN/qnsc-app-platform/commit/87c75290f5a75b52c58a0c2e9f5ca40d396b47e3))
- **identity:** add auth-service options + access-token signing ([#12](https://github.com/QNSC-VN/qnsc-app-platform/issues/12)) ([907e6fa](https://github.com/QNSC-VN/qnsc-app-platform/commit/907e6fa994ec6777f59ecf638a448089770f2389))
- **identity:** add AuthModule.forRoot DI wiring helper ([#19](https://github.com/QNSC-VN/qnsc-app-platform/issues/19)) ([5b89a13](https://github.com/QNSC-VN/qnsc-app-platform/commit/5b89a135b30576e75fbd873e4992380693b6f92f))
- **identity:** add AuthService getMe + updateProfile ([#16](https://github.com/QNSC-VN/qnsc-app-platform/issues/16)) ([8123353](https://github.com/QNSC-VN/qnsc-app-platform/commit/8123353f0d83e951cfde1ea6a18834b801560add))
- **identity:** add AuthService login paths (SSO + dev-login) with JIT provisioning ([#13](https://github.com/QNSC-VN/qnsc-app-platform/issues/13)) ([35ceaa9](https://github.com/QNSC-VN/qnsc-app-platform/commit/35ceaa9bd7dc756e760a8cef1f1ac50ba94dffe7))
- **identity:** add AuthService logout, logout-all + workspace switch ([#15](https://github.com/QNSC-VN/qnsc-app-platform/issues/15)) ([87da981](https://github.com/QNSC-VN/qnsc-app-platform/commit/87da981f56e7d9f2d5aed0608d4193180328abbd))
- **identity:** add AuthService refresh rotation + theft detection ([#14](https://github.com/QNSC-VN/qnsc-app-platform/issues/14)) ([5c44bcb](https://github.com/QNSC-VN/qnsc-app-platform/commit/5c44bcbecbf29eb4f773658f64a0f63fdff13705))
- **identity:** add cookie-based auth HTTP controller + DTOs ([#18](https://github.com/QNSC-VN/qnsc-app-platform/issues/18)) ([6be16b3](https://github.com/QNSC-VN/qnsc-app-platform/commit/6be16b3b45be736714a3db1427685ecdcfe89948))
- **identity:** add domain types + persistence repository ports ([#10](https://github.com/QNSC-VN/qnsc-app-platform/issues/10)) ([20a3a42](https://github.com/QNSC-VN/qnsc-app-platform/commit/20a3a42929832649ba7eba8a340b1ba11a0091c4))
- **identity:** add Entra SSO token verifier + refresh-token crypto ([#9](https://github.com/QNSC-VN/qnsc-app-platform/issues/9)) ([21554eb](https://github.com/QNSC-VN/qnsc-app-platform/commit/21554eb14826c1a5d2a05a64946b619786d7a9a8))
- **identity:** extract JWT strategy, guards & auth decorators from rally ([#7](https://github.com/QNSC-VN/qnsc-app-platform/issues/7)) ([9a8a4c5](https://github.com/QNSC-VN/qnsc-app-platform/commit/9a8a4c5c63b37364cb3272b5939901e8b686cd2c))
- scaffold qnsc-app-platform shared package repo ([cafd6b5](https://github.com/QNSC-VN/qnsc-app-platform/commit/cafd6b5bc7a905eb49c97627ff949eba7f27185e))
