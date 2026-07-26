# @qnsc-vn/observability

Shared observability primitives for QNSC product backends: one OpenTelemetry
bootstrap, one pino configuration, and the AsyncLocalStorage context that ties log
lines to the request or job that produced them.

Every product previously carried its own copy of each of these, once per process.
The copies drifted — in one product the worker's logger config had lost the `redact`
list entirely, so a logged SDK error could have written credentials to the log sink.
That class of bug is the reason this package exists.

## Install

```bash
pnpm add @qnsc-vn/observability
```

Peer dependencies are the OpenTelemetry SDK packages and `nestjs-pino`, which the
consuming app already has.

## OpenTelemetry bootstrap

```ts
// apps/api/src/otel.ts — MUST be the very first import in main.ts
import { startOtel, shutdownOtel } from '@qnsc-vn/observability/otel';

export { shutdownOtel };

startOtel({ defaultServiceName: 'rally-api' });
```

```ts
// apps/worker/src/otel.ts
import { startOtel, shutdownOtel } from '@qnsc-vn/observability/otel';

export { shutdownOtel };

startOtel({
  defaultServiceName: 'rally-worker',
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

| Variable | Default | Purpose |
|---|---|---|
| `OTEL_ENABLED` | `false` | Must be exactly `"true"` to start |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | Collector, usually a sidecar |
| `OTEL_SERVICE_NAME` | `defaultServiceName` | Overridable per env var name |
| `OTEL_SERVICE_NAMESPACE` | `qnsc` | Groups products for cross-product queries |
| `SERVICE_VERSION` | `dev` | Set from the release tag in CI, or telemetry is unattributable |
| `OTEL_SAMPLING_PROBABILITY` | `1.0` dev / `0.1` prod | Head sampling — see the caveat below |
| `NODE_ENV` | `development` | Batching/export tuning and `deployment.environment` |

**Sampling caveat.** Head sampling is all the SDK can do alone, and a prod ratio
below `1.0` drops most **error** traces, which are the ones you need. Prefer
collector-side *tail* sampling (100% of errors and slow traces, a fraction of the
rest) and leave this at `1.0`.

Health, readiness and favicon requests are skipped outright — no span is created, so
they consume no sampling budget and no quota.

## Logger

```ts
LoggerModule.forRootAsync({
  inject: [AppConfigService],
  useFactory: (config: AppConfigService) =>
    createLoggerOptions({
      serviceName: 'rally-api',
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

## What this package deliberately does not do

- **No metrics registry yet.** Declaring metric names without implementing them is
  worse than nothing: it implies coverage that does not exist. Added when the first
  product emits them.
- **No log shipping.** Logs go to stdout; the platform decides where from there.
- **No sampling policy beyond head sampling.** That belongs in the collector.
