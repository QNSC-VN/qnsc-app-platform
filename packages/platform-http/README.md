# @quynhonsemiconductor/platform-http

The HTTP contract every QNSC product backend shares, and that the frontends depend on: the **error
taxonomy and its status mapping**, the **global exception filter** that renders one error envelope,
**pagination**, the **client address**, the **rate-limit guard** and **idempotency interceptor**, the
HTTP **access-log interceptor**, the request-context accessor, and input sanitising.

| in this package                                                                                       | in your product                                                                                                                |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `DomainException` + subclasses, `ErrorCategory` → status table, transport-level codes                 | your domain error **codes** (an append-only catalogue)                                                                         |
| `GlobalExceptionFilter`: the one wire envelope `{ error: { code, message, details, correlationId } }` | which exceptions your code throws                                                                                              |
| cursor and offset pagination (`PageQuerySchema`, `buildPageResult`, `encodeCursor` …)                 | which endpoints paginate, and their sort keys                                                                                  |
| `clientIp(req)`: `cf-connecting-ip` → `x-forwarded-for` → socket                                      | nothing: stop reading `req.ip` / `x-real-ip`                                                                                   |
| `RateLimitGuard`, `@RateLimit(tier)`, tiers (`DEFAULT`, `STRICT`, `AUTH_LOGIN`, `AUTH_REFRESH`)       | **which route gets which tier**                                                                                                |
| `IdempotencyInterceptor` (`Idempotency-Key` on `POST`/`PUT`)                                          | which routes opt in                                                                                                            |
| `enableCorrelationId(app)`: the request's correlation id, validated, echoed, in the request context   | your own middleware, once its logger and exception filter read `observability`'s store (see [Rolling it out](#rolling-it-out)) |
| `HttpLoggingInterceptor` (one summary line per request; skips probe paths)                            | your log field names for anything else                                                                                         |
| `sanitizeString` / `sanitizeObject` (XSS stripping ahead of validation)                               | where it is applied                                                                                                            |

Divergence here is a **cross-repo contract break**: both frontends branch on the error `code`, so a 409 in
one product that is a 422 in another is a bug, not a style difference
([ADMISSION-TEST.md](../../docs/ADMISSION-TEST.md)). The wire behaviour is specified in
[PLATFORM-CONTRACT.md](../../docs/PLATFORM-CONTRACT.md) §7–§9.

## Install

```ini
# .npmrc
@quynhonsemiconductor:registry=https://npm.pkg.github.com
```

The token (`read:packages`) goes in your **user-level** `~/.npmrc`, **not** in this file: pnpm 11 ignores a token
in a project `.npmrc`. See [Authenticating to GitHub Packages](../../README.md#authenticating-to-github-packages).

```bash
pnpm add @quynhonsemiconductor/platform-http
```

Peer dependencies: `@nestjs/common`, `@nestjs/core`, `@nestjs/swagger` (`>=11`); `fastify` (`>=5`);
`ioredis`, `nestjs-zod`, `zod`; `@quynhonsemiconductor/platform-cache` (`>=2.0.0`) and
`@quynhonsemiconductor/observability` (`>=0.2.1`).

## Subpaths

None: a single entry point (`.`). The two pagination styles share names (`buildPageResult`, `PagedResult`),
so they are exported as namespaces: `cursorPagination` and `offsetPagination`.

## Error envelope

```ts
throw new NotFoundException('WORK_ITEM_NOT_FOUND', 'Work item not found'); // → 404
```

```json
{
  "error": {
    "code": "WORK_ITEM_NOT_FOUND",
    "message": "Work item not found",
    "details": [],
    "correlationId": "…"
  }
}
```

The category fixes the status (`NOT_FOUND` 404, `CONFLICT` 409, `VALIDATION_FAILED` 422,
`PERMISSION_DENIED` 403, `PRECONDITION_FAILED` 412, `RATE_LIMITED` 429, `UNAUTHORIZED` 401, `INTERNAL`
500). Register `GlobalExceptionFilter` once as `APP_FILTER`. Internal detail never reaches the wire.
A framework `HttpException` maps to the code of the same name (`HttpErrorCodes`); `503` is
`SERVICE_UNAVAILABLE`, not `INTERNAL_ERROR`.

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

## Correlation id

```ts
// main.ts, after creating the application and before listen()
enableCorrelationId(app);
```

On every request, before any module middleware, guard or filter:

1. `X-Correlation-Id` is kept **only if** it is one value of **1 to 128 characters from `[A-Za-z0-9._:-]`**.
   Anything else (empty, longer, a space, a quote, a control character, CR/LF, a repeated header, which Node joins
   into one comma-separated value) is
   replaced by `crypto.randomUUID()`. A replacement is logged at DEBUG with the **reason and the length**,
   never the value. An absent header is simply generated.
2. The id is **echoed** on the response as `X-Correlation-Id`, including on 404s and error responses.
3. It is put in `observability`'s request context (with the `traceparent`, when well formed), so
   `correlationId` is on every log line, in the error envelope, and in
   `RequestContextService.getCorrelationId()`.

The character class is deliberate. A UUID-only rule would drop the ULIDs, hex trace ids and
`service:request` composites that upstream systems send and break correlation across a call chain. What
has to be excluded is anything that can inject: CR, LF, control characters, whitespace, quotes.

The browser can only read the response header if the product's CORS config lists it in
`exposedHeaders`.

### One fresh context per request

A new context is made for **every** request and nothing is copied from whatever context is active when
the middleware runs. That matters when the server was started inside a context (a bootstrap wrapped in
`withJobContext`, for instance): every request handled afterwards inherits it, and reusing it would hand
one mutable object to all of them, so they would share an id and a guard's `setAuthContext()` would write
one user into everybody's context. Register `enableCorrelationId` before any other middleware that enters
a context; it does not merge into one that is already there.

### Upgrading

`requestContextStorage` and `RequestContextService` exported by this package are now **`observability`'s
instance** (before, this package carried a second, private copy). The names, shapes and class are
unchanged, so nothing needs editing; a product that seeded this package's copy now seeds the one its
logger reads. `observability` (`>=0.2.1`) was already a peer dependency.

### Rolling it out

1. Upgrade, add `enableCorrelationId(app)`. If the product's own middleware still seeds the context, **it
   keeps working and there is still one id**: the id settled on here is written back to the request's
   `x-correlation-id`, so that middleware adopts it (and one that used to trust the raw header no longer
   reflects bad input). If it enters its own context, its id is the effective one and its `setHeader`
   wins, exactly as before.
2. Delete the product's middleware when convenient, **after checking which store the product reads.**
   This package seeds `observability`'s request context. The logger mixin, `RequestContextService` and the
   `REQUEST_CONTEXT` binding of `GlobalExceptionFilter` must read that same store, or the id is seeded
   where nothing looks:

   | product | reads today                                                                      | can delete its middleware                                   |
   | ------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------- |
   | rova    | `observability`'s store (its `request-context.ts` re-exports it)                 | yes                                                         |
   | opshub  | **its own** `AsyncLocalStorage` (`libs/platform/src/context/request-context.ts`) | **not yet**: first re-export `observability`'s, as rova did |

   What is tested, and what is not. The tests in this repository use **copies shaped like** the products'
   middleware, not the products' own classes: one with rova's pattern and header handling, one that trusts
   the raw header and validates nothing (the shape solodesk had, before it was retired on 2026-10-10), and
   one shaped like opshub's that enters **its own private store**.
   They pin: with the middleware kept there is one id in the response and in the product's own context for
   every kind of input; with it removed, opshub's private store sees nothing (the prerequisite above).
   Separately, rova's and opshub's actual middleware classes were booted once by hand, in throwaway specs
   inside clones of those repositories, against a tarball of this package. That run is not committed and is
   not in CI, so treat it as a one-off check and not as a guarantee.

3. A deployment that must not change yet sets **`CORRELATION_ID_MODE=disabled`**: nothing is registered.
   An unknown value fails the boot.

What changes for a product that deletes its own middleware (each product's rule today is different):

| product | accepts today                                                       | also reads `X-Request-ID`     | after this package                            |
| ------- | ------------------------------------------------------------------- | ----------------------------- | --------------------------------------------- |
| rova    | `[A-Za-z0-9_-]{8,64}`                                               | yes, when the other is absent | wider class; `X-Request-ID` is no longer read |
| opshub  | UUID-shaped only (`[0-9a-f-]{32,36}`); anything else is regenerated | no                            | non-UUID ids (ULIDs, `svc:req`) are now kept  |

A product that trusts the raw header, validates nothing and echoes nothing (solodesk did; retired 2026-10-10)
would go from "anything" to validated and echoed on the response. The tests keep that shape.

`X-Request-ID` is not read here: the contract names one header.

### Background work

A job does not run inside the request, so it must be handed the id. Put it in the payload when you
enqueue, and restore it when the handler starts. No dependency on `platform-jobs` is needed, and the
convention is the same whichever queue carries it:

```ts
// where the work is enqueued, inside the request
const correlationId = this.requestContext.getCorrelationId(); // RequestContextService
await jobs.send('mail.send', { ...message, correlationId }, { tx });

// in the handler
import { withJobContext } from '@quynhonsemiconductor/observability';

await withJobContext('mail.send', () => this.deliver(job.data), {
  correlationId: job.data.correlationId, // omit it and the job gets its own: `mail.send:<uuid>`
});
```

Every log line the handler writes then carries the request's id. The payload value came from this
package, so it is already validated; a handler fed from anywhere else should validate before trusting it.

## Rate limiting and idempotency need a cache

`RateLimitGuard` and `IdempotencyInterceptor` store their state in Valkey through
`CacheService`. `CacheModule` in `optional` mode with no URL turns the cache off, and both
then do nothing — silently, which on EKS meant no application rate limiting at all.

With `NODE_ENV=production` the application **fails at startup** in that state. Outside
production nothing changes (local development and CI run without Valkey).

| Variable           | Values                                     | Effect                                                                                                                                                                                           |
| ------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `RATE_LIMIT_MODE`  | `cache` (default), `edge-only`, `disabled` | `edge-only`: limits are enforced by Cloudflare rules only; the guard allows every request without touching the cache and logs a warning at startup. `disabled`: no limiting (dev/CI) — see below |
| `IDEMPOTENCY_MODE` | `cache` (default), `disabled`              | `disabled`: `Idempotency-Key` is not honoured; the interceptor passes every request through                                                                                                      |

An unknown value fails at startup too — a typo never silently means the default.

`RATE_LIMIT_MODE=disabled` replaces `DISABLE_RATE_LIMIT=true`, which still works as a
**deprecated alias** (and logs a deprecation warning at startup); an explicit
`RATE_LIMIT_MODE` wins over it, in which case the startup warning says the variable was
**ignored** and which mode is in force, so nobody keeps believing it still switches the
limiter off. In production a disabled limiter is a security control
turned off, so it is reported as a fail-open: a warning at startup carrying
`securityFailOpen: "rate_limit"`, and `SecurityMetrics.recordFailOpen('rate_limit')` at
startup and on every request it lets through, so an alert on either keeps firing while
it stays off. Outside production it is silent, as before.

A cache that exists but is unreachable _at request time_ still fails open, as before; it is
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

## Testing your code

The guard, the interceptor and the filter are plain Nest providers. Unit-test a guard by constructing it
with a stub `CacheService` (`consumeRateLimit` is the only method it calls); test the interceptor the same
way with `{ instance: { get, set } }`. For behaviour against a real server (the sliding window itself),
see `platform-cache`. There is no `/testing` subpath.

## Known limits

- **NestJS + Fastify only.** The guard and interceptors are Nest constructs; the Express adapter is not
  supported.
- **Rate limiting and idempotency need a reachable cache.** A cache that goes away at request time
  **fails open** (reported as `securityFailOpen: "rate_limit"`); in production the application refuses to
  start without one unless `RATE_LIMIT_MODE` / `IDEMPOTENCY_MODE` say so.
- **`cf-connecting-ip` is trusted.** That is correct only if the pods are reachable solely through
  Cloudflare Tunnel (see the assumption above).
- The rate-limit tiers are fixed (`DEFAULT`, `STRICT`, `AUTH_LOGIN`, `AUTH_REFRESH`). `@RateLimit(tier)`
  selects one by name and `@SkipRateLimit()` opts a route out; a product cannot define a tier of its own
  without a change here. Which route gets which tier is the product's.
