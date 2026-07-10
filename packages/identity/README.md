# @qnsc-vn/identity

Shared identity/auth for QNSC product backends. Single source of truth for:

- JWT (ES256) strategy + guards
- Single-use refresh-token rotation with family theft-detection
- CSRF handling
- SSO / Microsoft Entra ID token validation + JIT provisioning
- BFF (Backend-For-Frontend) session handlers (`/bff/login|callback|me|logout`)

> **Phase 1 skeleton.** The concrete implementation is extracted from the product
> repos in Phase 2 of the Identity Platform Migration Plan; BFF handlers land in
> later phases behind a feature flag.

Depends on [`@qnsc-vn/platform-cache`](../platform-cache) and
[`@qnsc-vn/platform-http`](../platform-http).

## Install

```ini
# .npmrc
@qnsc-vn:registry=https://npm.pkg.github.com
```

```bash
pnpm add @qnsc-vn/identity
```
