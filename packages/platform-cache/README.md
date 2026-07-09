# @qnsc/platform-cache

Shared Valkey/Redis cache service for QNSC product backends — an `ioredis`
wrapper providing key-prefixing, fail-open behaviour, and the session/denylist
helpers used by `@qnsc/identity`.

> **Phase 1 skeleton.** The concrete implementation is extracted from the product
> repos in Phase 2 of the Identity Platform Migration Plan.

## Install

```ini
# .npmrc
@qnsc:registry=https://npm.pkg.github.com
```

```bash
pnpm add @qnsc/platform-cache
```
