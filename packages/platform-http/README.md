# @quynhonsemiconductor/platform-http

Shared Fastify/NestJS HTTP bootstrap for QNSC product backends: CORS policy,
cookie configuration, security headers, standard error codes, and OpenTelemetry
wiring.

> **Phase 1 skeleton.** The concrete implementation is extracted from the product
> repos in Phase 2 of the Identity Platform Migration Plan.

## Install

```ini
# .npmrc
@qnsc:registry=https://npm.pkg.github.com
```

```bash
pnpm add @quynhonsemiconductor/platform-http
```


## Client address

```ts
import { clientIp } from '@quynhonsemiconductor/platform-http';

const ip = clientIp(req); // cf-connecting-ip → first x-forwarded-for → socket address
```

Used by request logging, the rate-limit keys and the anonymous idempotency key. Behind
Cloudflare Tunnel `req.ip` is `cloudflared`'s address, and the first `x-forwarded-for`
entry is whatever the client chose to send; Cloudflare overwrites `cf-connecting-ip`, so a
forged `x-forwarded-for` is ignored whenever it is present. A header value that is not a
literal IP address is skipped.

> **Assumption.** `cf-connecting-ip` is authoritative only if the pods are reachable
> **only** through the Cloudflare Tunnel and the gateway behind it (no public listener, no
> `NodePort`). Otherwise a caller can choose its own address, and with it its own
> rate-limit bucket.

`HttpLoggingInterceptor` no longer reads `x-real-ip`.

## Rate limiting and idempotency need a cache

`RateLimitGuard` and `IdempotencyInterceptor` store their state in Valkey through
`CacheService`. `CacheModule` in `optional` mode with no URL turns the cache off, and both
then do nothing — silently, which on EKS meant no application rate limiting at all.

With `NODE_ENV=production` the application **fails at startup** in that state. Outside
production nothing changes (local development and CI run without Valkey).

| Variable | Values | Effect |
|---|---|---|
| `RATE_LIMIT_MODE` | `cache` (default), `edge-only`, `disabled` | `edge-only`: limits are enforced by Cloudflare rules only; the guard allows every request without touching the cache and logs a warning at startup. `disabled`: no limiting (dev/CI) — see below |
| `IDEMPOTENCY_MODE` | `cache` (default), `disabled` | `disabled`: `Idempotency-Key` is not honoured; the interceptor passes every request through |

An unknown value fails at startup too — a typo never silently means the default.

`RATE_LIMIT_MODE=disabled` replaces `DISABLE_RATE_LIMIT=true`, which still works as a
**deprecated alias** (and logs a deprecation warning at startup); an explicit
`RATE_LIMIT_MODE` wins over it. In production a disabled limiter is a security control
turned off, so it is reported as a fail-open: a warning at startup carrying
`securityFailOpen: "rate_limit"`, and `SecurityMetrics.recordFailOpen('rate_limit')` at
startup and on every request it lets through, so an alert on either keeps firing while
it stays off. Outside production it is silent, as before.

A cache that exists but is unreachable *at request time* still fails open, as before; it is
now reported both ways — the log line carries `securityFailOpen: "rate_limit"`
(`failOpenLog`) and `SecurityMetrics.recordFailOpen('rate_limit')` is called, both from
`@quynhonsemiconductor/observability` — so the alert on either can see it. Recording the
metric can never fail the request.

### Upgrading

Not a breaking change: no export was removed or changed. A product that registers the
guard or interceptor and runs production without a cache will now stop at boot. Either
configure the cache (the intended fix) or set the variable above to say it is deliberate.

## Probe paths in access logs

`HttpLoggingInterceptor` skips `PROBE_PATHS` from `@quynhonsemiconductor/observability`
(plus `/favicon.ico`) by default — the same list tracing ignores — matched on the path with
the query string removed. Passing `skipPaths` replaces that default.

This makes `@quynhonsemiconductor/observability` (`>=0.2.1`) a peer dependency. All three
products already install it.
