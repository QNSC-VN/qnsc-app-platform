# @quynhonsemiconductor/platform-cache

The one Valkey/Redis client for QNSC product backends: an `ioredis` wrapper with a key prefix, an
atomic sliding-window rate limiter and `SET NX PX` locks.

| in this package                                                         | in your product                                               |
| ----------------------------------------------------------------------- | ------------------------------------------------------------- |
| connection lifecycle (eager connect, auto-pipelining, quit on shutdown) | the connection URL and key prefix (passed to `CacheModule`)   |
| `get` / `set` / `getJson` / `setJson` / `del`, key-prefixed             | what is cached, and its TTLs                                  |
| `consumeRateLimit(key, limit, windowSeconds)` — atomic sliding window   | the limits, tiers and which routes use them (`platform-http`) |
| `acquireLock(key, ttlMs)` / `releaseLock(key)`                          | which work needs a lock                                       |

It carries **no domain policy**. Token denylists and session semantics live in
[`identity`](../identity); rate-limit tiers live in [`platform-http`](../platform-http). It is a
**peer** of both because two copies of this package mean two Valkey clients: a BFF session written by
one holder is invisible to the other.

Runtime state is per product. Each backend wires its own connection, so importing this package never
implies a shared Valkey instance.

## Install

```ini
# .npmrc
@quynhonsemiconductor:registry=https://npm.pkg.github.com
```

The token (`read:packages`) goes in your **user-level** `~/.npmrc`, **not** in this file: pnpm 11 ignores a token
in a project `.npmrc`. See [Authenticating to GitHub Packages](../../README.md#authenticating-to-github-packages).

```bash
pnpm add @quynhonsemiconductor/platform-cache ioredis
```

Peer dependencies: `@nestjs/common` (`>=11`), `ioredis` (`>=5`).

## Usage

```ts
import { CacheModule, CacheService } from '@quynhonsemiconductor/platform-cache';

@Module({
  imports: [
    CacheModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        url: config.get('REDIS_URL'), // the product reads its own variable — see Environment
        keyPrefix: 'rova:',
        mode: 'required',
      }),
    }),
  ],
})
export class AppModule {}
```

`CacheModule` is `@Global()`; inject `CacheService` anywhere.

```ts
await cache.set('session:42', 'v', 60); // TTL in seconds
await cache.getJson<User>('user:42'); // null if missing, disabled, or corrupt
const { allowed, remaining, resetAt } = await cache.consumeRateLimit('login:1.2.3.4', 5, 900);
if (await cache.acquireLock('nightly-sweep', 60_000)) {
  /* … */
}
```

## Modes

| `mode`               | no URL                                             | use when                                                   |
| -------------------- | -------------------------------------------------- | ---------------------------------------------------------- |
| `required` (default) | **startup error**                                  | the cache is on a critical path (auth denylist, sessions)  |
| `optional`           | cache disabled; every call no-ops or returns empty | the product treats the cache as best-effort and fails open |

In `optional` mode with no URL `consumeRateLimit` returns `allowed: true` and `acquireLock` returns
`false`. **That quiet state is a hazard in production**: rate limiting and idempotency would do nothing.
`platform-http` therefore refuses to start in production in that state unless the deployment says so
(`RATE_LIMIT_MODE`, `IDEMPOTENCY_MODE`).

## Environment

This package **reads no environment variable itself**: the product passes `url`, `keyPrefix` and `mode`.
The contract name for the URL is **`REDIS_URL`** (what rova and opshub already read and the chart
injects; [PLATFORM-CONTRACT.md](../../docs/PLATFORM-CONTRACT.md) §6). The product reads it and passes it to
`CacheModule`.

## Shutdown order

The client quits in **`onApplicationShutdown`**, not `onModuleDestroy`. Nest runs `onModuleDestroy` →
`beforeApplicationShutdown` → (HTTP server drains) → `onApplicationShutdown`; anything that stops work
using the cache (a job runner) or serves requests that use it must finish first. `onModuleDestroy()` is
kept as a **deprecated no-op** so a caller that invoked it keeps compiling; it will be removed in the
next major. This is why `platform-runtime`'s graceful shutdown needs `platform-cache` **>=3.1.1**.

## Subpaths

None: a single entry point (`.`).

## Testing your code

`CacheService` takes a real URL. Test against a real Valkey: the rate limiter is a server-side Lua
script and the lock is `SET NX PX`, so an in-memory double does not exercise what matters. This
repository's own tests use `@quynhonsemiconductor/testing` (`startValkey()`; a private workspace
package, never published). A product can use any Valkey container, or its CI service container.

## Known limits

- One Valkey node; no cluster or sentinel awareness beyond what `ioredis` does from a URL.
- The rate limiter's window and member scheme are fixed. Tiers and thresholds are the product's.
- Locks are single-key `SET NX PX` ("Redlock-lite"): safe against a crashed holder, not against a
  paused one whose TTL expired. Work behind a lock MUST be idempotent.
- With a per-instance cache (not shared across replicas) sessions and revocations are visible to only
  some replicas.
