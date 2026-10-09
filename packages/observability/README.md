# @quynhonsemiconductor/observability

Shared observability primitives for QNSC product backends: one OpenTelemetry
bootstrap, one pino configuration, and the AsyncLocalStorage context that ties log
lines to the request or job that produced them.

Every product previously carried its own copy of each of these, once per process.
The copies drifted — in one product the worker's logger config had lost the `redact`
list entirely, so a logged SDK error could have written credentials to the log sink.
That class of bug is the reason this package exists.

## Install

```bash
pnpm add @quynhonsemiconductor/observability
```

Peer dependencies are the OpenTelemetry SDK packages and `nestjs-pino`, which the
consuming app already has.

## OpenTelemetry bootstrap

```ts
// apps/api/src/otel.ts — MUST be the very first import in main.ts
import { startOtel, shutdownOtel } from '@quynhonsemiconductor/observability/otel';

export { shutdownOtel };

startOtel({ defaultServiceName: 'rova-api' });
```

```ts
// apps/worker/src/otel.ts
import { startOtel, shutdownOtel } from '@quynhonsemiconductor/observability/otel';

export { shutdownOtel };

startOtel({
  defaultServiceName: 'rova-worker',
  serviceNameEnvVar: 'OTEL_WORKER_SERVICE_NAME',
});
```

> **Import from the `/otel` subpath, not the package root.** Auto-instrumentation
> patches modules as they are required, so pulling in the package barrel (which
> reaches Nest and pino) before `startOtel()` would leave those modules unpatched and
> silently produce no spans. The subpath export exists to make that impossible.

Call `shutdownOtel()` from the process signal handler **before** closing the Nest
app, so in-flight spans are exported rather than dropped.

`startOtel` is a **no-op unless `OTEL_ENABLED=true`**, so adopting this package
changes nothing until a collector endpoint exists. It returns `true` when tracing
actually started — worth logging, since it is the cheapest way to tell
"observability is off" from "observability is broken".

### Environment

| Variable                      | Default                 | Purpose                                                                                                                                                                           |
| ----------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OTEL_ENABLED`                | `false`                 | Must be exactly `"true"` to start                                                                                                                                                 |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | Collector, usually a sidecar                                                                                                                                                      |
| `OTEL_SERVICE_NAME`           | `defaultServiceName`    | Overridable per env var name                                                                                                                                                      |
| `OTEL_SERVICE_NAMESPACE`      | `qnsc`                  | Groups products for cross-product queries                                                                                                                                         |
| `SERVICE_VERSION`             | `dev`                   | Set from the release tag in CI, or telemetry is unattributable                                                                                                                    |
| `OTEL_SAMPLING_PROBABILITY`   | `1.0` dev / `0.1` prod  | Head sampling (`parentbased_traceidratio`) — see the caveat below. A value that is not a number falls back to the default with a process warning, instead of dropping every trace |
| `DEPLOYMENT_ENV`              | `NODE_ENV`              | Deployment identity and the sampling default (`production` ⇒ `0.1`)                                                                                                               |
| `NODE_ENV`                    | `development`           | Batching/export tuning                                                                                                                                                            |
| `K8S_POD_NAME`                | —                       | `k8s.pod.name` resource attribute (downward API)                                                                                                                                  |
| `K8S_NAMESPACE`               | —                       | `k8s.namespace.name` resource attribute (downward API)                                                                                                                            |
| `K8S_NODE_NAME`               | —                       | `k8s.node.name` resource attribute (downward API)                                                                                                                                 |

The `K8S_*` variables are added to the resource only when set and non-blank, so a local
or CI run carries no empty `k8s.*` attributes. If the collector's Kubernetes attributes
processor adds the same attributes, the values are identical.

**Standard sampler variables are ignored.** `OTEL_TRACES_SAMPLER` and
`OTEL_TRACES_SAMPLER_ARG` have no effect: `startOtel` passes its own sampler to the SDK,
which takes precedence over them. `OTEL_SAMPLING_PROBABILITY` is the only override.

**Sampling caveat.** Head sampling is all the SDK can do alone, and a prod ratio
below `1.0` drops most **error** traces, which are the ones you need. Prefer
collector-side _tail_ sampling (100% of errors and slow traces, a fraction of the
rest) and leave this at `1.0`.

Health, readiness and favicon requests are skipped outright — no span is created, so
they consume no sampling budget and no quota.

### Probe paths

`PROBE_PATHS` (`/livez`, `/readyz`, `/v1/readyz`, `/healthz`, `/v1/healthz`) is the one
list. The tracing ignore hook and the request-log skip list in
`@quynhonsemiconductor/platform-http` are both derived from it, so a path added here is
dropped from spans **and** access logs at once. `isIgnoredRequestPath(url)` is the shared
matcher: whole-path match, query string ignored, never a prefix.

```ts
import { PROBE_PATHS, isIgnoredRequestPath } from '@quynhonsemiconductor/observability';
```

### Instrumentations

Auto-instrumentation is on for HTTP, `pg` and `ioredis`, and off for `fs`, `dns`, `net`
and the **AWS SDK**. The products' object-storage client talks to R2 over HTTP, which the
HTTP instrumentation already traces; the AWS SDK instrumentation only added a second
span per call.

### Latency histogram buckets (`httpDurationBoundaries`)

```ts
startOtel({
  defaultServiceName: 'rova-api',
  // Milliseconds. Strictly ascending, finite, non-negative.
  httpDurationBoundaries: [0, 100, 500, 1_000, 5_000, 10_000, 30_000, 60_000, 120_000, 300_000],
});
```

|            |                                                                             |
| ---------- | --------------------------------------------------------------------------- |
| Option     | `httpDurationBoundaries?: number[]` on `startOtel`                          |
| Unit       | **milliseconds**                                                            |
| Applies to | the `http.server.duration` instrument only                                  |
| Omitted    | the OpenTelemetry defaults are kept, and the SDK configuration is unchanged |

**Why you might want it.** The OTel JS default explicit-histogram boundaries end at
`10000`:

```
[0, 5, 10, 25, 50, 75, 100, 250, 500, 750, 1000, 2500, 5000, 7500, 10000]
```

Everything slower than 10s falls into one overflow bucket, and `histogram_quantile()`
clamps to the largest finite boundary — so a p99 alert on a service with genuinely slow
requests fires with the value `10000`, which is not a latency, and a 12s request is
arithmetically indistinguishable from a 180s one. If your request path wraps calls in
resilience presets whose timeout budgets run to 60s × 3 attempts, and those requests
return `200`, then neither the latency alert nor the 5xx alert can see them. Widen the
buckets past your own worst-case timeout budget and they become visible.

> **⚠️ Rolling this out invalidates existing latency series.** Bucket boundaries are part
> of the exported time series' identity: each one is a separate `..._bucket{le="…"}`
> series. Changing them does not re-label the old data — it stops writing those series
> and starts writing different ones. Everything downstream that was built on the old
> boundaries goes stale at the moment of deploy:
>
> - `histogram_quantile()` over a window straddling the change mixes two bucket layouts
>   and returns a meaningless number until the window clears
> - recording rules, dashboard panels and alert thresholds pinned to a specific `le`
>   value (`le="1000"`, `le="10000"`) will silently return no data if that boundary is
>   not in the new set
> - historical comparisons ("p99 vs. last week") break across the boundary change
>
> Keep the old boundaries as a subset of the new ones wherever you can — appending
> `30000, 60000, 120000, 300000` to the defaults preserves every existing `le` — and
> schedule it like a metric migration, not a config tweak.

**Validation is fatal at startup.** An empty array, a non-finite value (`NaN`,
`Infinity`), a negative value, or anything not strictly ascending throws from
`startOtel`, with the offending index and value in the message. This is deliberate: the
SDK's aggregator silently sorts and de-duplicates whatever it is handed, so a typo'd
array is accepted upstream and quietly becomes a _different_ bucket set than you wrote —
producing a histogram that looks healthy and lies, which is the exact failure this
option exists to fix. The check runs **before** the `OTEL_ENABLED` gate, so a bad array
fails in local dev and CI rather than waiting for the one environment that has
telemetry switched on.

Only `http.server.duration` is affected. `job.duration` and every other instrument keep
their defaults, and a product that does not pass the option sees no change at all.

## Logger

```ts
LoggerModule.forRootAsync({
  inject: [AppConfigService],
  useFactory: (config: AppConfigService) =>
    createLoggerOptions({
      serviceName: 'rova-api',
      nodeEnv: config.get('NODE_ENV'),
      serviceVersion: config.get('SERVICE_VERSION'),
      level: config.get('LOG_LEVEL'),
      pretty: config.get('LOG_PRETTY'),
    }),
});
```

What you get on every line, without any call site passing it:

- `trace.id` / `span.id` from the active span, so a log links to its trace
- `workspaceId` / `userId` / `correlationId` from AsyncLocalStorage
- `service` / `env` / `version`
- credentials redacted — `authorization`, `cookie`, `set-cookie`, `x-api-key`,
  `x-csrf-token`, and the same headers nested inside SDK error objects
- `autoLogging: false`, on the assumption the app emits its own request-summary line

Pretty-printed outside production, raw JSON in deployed environments.

## Request and job context

`RequestContextService` + `requestContextStorage` carry per-request context. HTTP
requests seed it in middleware; **background work must seed it explicitly**, or its
logs carry no correlation id:

```ts
// A cron job or relay pass
await withJobContext('daily-cleanup', () => this.runCleanup());

// Work that originated in a request — pass the ids through so the halves join up
await withJobContext('notification-relay', () => this.send(row), {
  correlationId: row.correlationId,
  workspaceId: row.workspaceId,
});
```

The generated id is prefixed with the job name (`daily-cleanup:8f3a…`), so a log
search can scope to one job without another field, and an id that escapes into a
payload is self-describing.

## Metrics

```ts
// RED, from a global interceptor — every route, no per-controller wiring
httpMetrics.record({ route: '/v1/work-items/:id', method, statusCode, durationMs, errorCode });

// Jobs: records outcome AND re-throws, so instrumenting cannot swallow a failure
await jobMetrics.time('daily-cleanup', () => this.run());

// Queues: lag is what reveals a relay falling behind; throughput alone looks fine
queueMetrics.recordProcessed(name, n);
queueMetrics.recordFailure(name, n);
queueMetrics.recordLag(name, seconds);

// Pool: register ONCE with a closure over the driver's pool. OTel pulls it on
// collection, so there is no timer to own and no stale reading.
dbPoolMetrics.register(() => ({
  inUse: pool.totalCount - pool.idleCount,
  waiting: pool.waitingCount,
}));

// Security: pair with failOpenLog() — same FailOpenControl union, so the metric label
// and the log-based alarm pattern cannot drift apart
securityMetrics.recordFailOpen('denylist');

// Auth: "is login itself working", separate from the generic HTTP error rate — the
// BFF login callback deliberately collapses every failure into one 401 (never
// surfaces OIDC/internal detail to the browser), so the status code alone cannot
// tell a broken IdP integration from a user mistyping an email.
authMetrics.recordLogin('sso', 'success');
```

The `http.server.duration` histogram uses the OpenTelemetry default buckets, which stop
at 10s — see [`httpDurationBoundaries`](#latency-histogram-buckets-httpdurationboundaries)
if your p99 is being clamped to `10000`.

**Labels are bounded by construction.** Status codes collapse to `2xx/3xx/4xx/5xx`,
methods to a fixed set plus `OTHER`, error labels take a domain code. Passing an id is
a type error. IDs belong on spans and logs. `normalizeRoute()` is the safety net for
when a framework cannot supply a route template.

**…and by a runtime guard where the type cannot help.** `route`, `error_code`, `job` and
`queue` are plain strings — the vocabulary is the product's — so a per-id route or a job
named after a tenant type-checks and mints a series per value. `LabelCardinalityGuard`
remembers the distinct values each recorder has seen per label and, past a limit, records
new ones as `__other__` instead (values already admitted keep their own series). It logs
once per label, so the leak is visible without becoming a log flood.

| Label          | Limit (distinct values) |
| -------------- | ----------------------- |
| `route`        | 500                     |
| `error_code`   | 200                     |
| `job`, `queue` | 100                     |

**Label unmatched requests with a constant.** A request that matches no route (every 404
from a scanner or a typo) has no template. If the product then labels it with the raw URL,
each probed path becomes a new `route` value and scanner traffic alone spends the whole
route budget, after which real routes added later would be recorded as `__other__`. Pass a
fixed value such as `route: 'unmatched'` (or `normalizeRoute()` at the very least) for
those requests.

**Recording never throws.** `LabelCardinalityGuard.bound` accepts any value (`undefined`
becomes `UNKNOWN`, other types are stringified) and returns the overflow label rather than
fail, and `HttpMetrics.record`, `JobMetrics.record` and the `QueueMetrics` recorders catch
anything thrown while recording and log it once; `SecurityMetrics` (`recordFailOpen`,
`recordStaleToken`) and `AuthMetrics.recordLogin` do the same. A metric can cost a data point, never a
response — the same fail-open contract as the rest of the package. (`JobMetrics.time` still
re-throws the _job's_ error.)

These are tripwires, not budgets: reaching one means an id or a raw path is being used as
a label, and the fix is at the call site. Values longer than 128 characters are cut. The
limits are fixed — there is deliberately no setting to raise them per product.

## `@Span` policy

Auto-instrumentation already spans every HTTP request (including outbound ones, such as
object-storage calls), database query and cache call. `@Span` is for **deliberate**
additions on top of that:

- a method with meaningful internal fan-out, where one flat span hides the shape
- a hot path whose duration you would want to see separately
- a long-running domain operation

It is **not** for CRUD passthroughs — a span that merely wraps one query duplicates the
pg span underneath it. Uneven `@Span` coverage across services is expected and fine;
the auto-instrumented baseline is what guarantees nothing is blind.

## What this package deliberately does not do

- **No log shipping.** Logs go to stdout; the platform decides where from there.
- **No sampling policy beyond head sampling.** Keeping 100% of errors requires a
  collector-side tail sampler, because the decision needs the finished trace.
- **No health controller.** Readiness checks are product-specific and would drag
  Terminus in as a peer dependency.
