/**
 * OpenTelemetry bootstrap — the single implementation, shared by every app.
 *
 * Every product had one copy of this per process (api, worker), byte-for-byte the
 * same except for the service name — so sampling policy, exporter tuning, resource
 * attributes and shutdown logic were maintained N times per repo and again in each
 * repo. Each entrypoint is now a thin shim that calls {@link startOtel} with its
 * own name.
 *
 * IMPORT DISCIPLINE — this file must only import `@opentelemetry/*` and node
 * built-ins, and consumers must import it via the `@quynhonsemiconductor/observability/otel`
 * subpath rather than the package root. Auto-instrumentation patches modules as
 * they are required, so anything that pulls in Nest, pg, or ioredis *before*
 * `startOtel()` runs would be loaded unpatched and silently produce no spans.
 *
 * A no-op unless `OTEL_ENABLED=true`, so adopting this package changes nothing
 * until a collector endpoint exists to receive the data.
 */
import { randomUUID } from 'node:crypto';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import {
  AggregationType,
  PeriodicExportingMetricReader,
  type ViewOptions,
} from '@opentelemetry/sdk-metrics';
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-base';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { IGNORED_REQUEST_PATHS, isIgnoredRequestPath } from './ignored-paths';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
} from '@opentelemetry/semantic-conventions';

export interface OtelBootstrapOptions {
  /**
   * Fallback service name, used when the env var below is unset. Each app passes
   * its own (`rally-api`, `rally-worker`).
   */
  defaultServiceName: string;
  /**
   * Env var carrying the service name. The worker reads `OTEL_WORKER_SERVICE_NAME`
   * so a single task definition can host both without them colliding.
   */
  serviceNameEnvVar?: string;
  /**
   * Explicit bucket boundaries, in MILLISECONDS, for the `http.server.duration`
   * histogram. Omit it and the instrument keeps the OpenTelemetry default buckets —
   * that is the path every existing consumer is on, and it must stay unchanged.
   *
   * WHY THIS EXISTS. The OTel JS default explicit-histogram boundaries end at 10000:
   * `[0, 5, 10, 25, 50, 75, 100, 250, 500, 750, 1000, 2500, 5000, 7500, 10000]`
   * (`Aggregation.DEFAULT_INSTANCE` in `@opentelemetry/sdk-metrics`). Everything
   * slower than 10s lands in the same overflow bucket, and `histogram_quantile`
   * clamps to the largest finite boundary — so a p99 alert on a product whose slow
   * requests take three minutes fires with the value `10000`, which is not a latency
   * at all, and a 12s request is arithmetically indistinguishable from a 180s one.
   *
   * That blind spot is real for a consumer whose request path wraps calls in
   * resilience presets with timeout budgets of 60s x 3 attempts: those requests
   * return 200, so the 5xx alert never sees them either. Such a product needs
   * boundaries that reach past its own worst-case budget.
   *
   * OPT-IN ON PURPOSE, not a new default. Changing the buckets changes the shape of
   * the exported `_bucket` series — an existing recording rule, dashboard or alert
   * built on the old boundaries goes stale the moment the new ones ship. That is a
   * per-product rollout decision with a per-product blast radius, so it is a
   * per-product option rather than a package-wide default.
   */
  httpDurationBoundaries?: number[];
}

/**
 * Instrument name the histogram View selects.
 *
 * A LITERAL, deliberately, and not `METRIC_NAMES.HTTP_SERVER_DURATION`. `METRIC_NAMES`
 * lives in `./metrics`, which imports `@nestjs/common` and `./fail-open`; importing it
 * here would make this file — the one file that must be required before anything else —
 * pull Nest in ahead of `sdk.start()`. Auto-instrumentation patches modules as they are
 * required, so a Nest (and, transitively, an http/pg/ioredis) module loaded before the
 * instrumentation installs is loaded unpatched and silently emits no spans. That is the
 * exact failure the IMPORT DISCIPLINE note at the top of this file forbids, and the
 * reason `ignored-paths.ts` exists as a dependency-free leaf.
 *
 * Promoting the name into that leaf was the alternative. It was not worth it for one
 * string: `ignored-paths` is about request paths, and a second unrelated constant there
 * makes the leaf a junk drawer. Instead the spec asserts this literal equals
 * `METRIC_NAMES.HTTP_SERVER_DURATION` — a test file may import both freely, so the two
 * cannot drift without a red test.
 */
const HTTP_SERVER_DURATION_INSTRUMENT = 'http.server.duration';

/**
 * Reject a boundaries array that would produce a histogram which looks healthy and
 * lies. Throwing at boot is the correct failure mode here: this option exists because a
 * silently-wrong bucket set already cost us a p99 alert that reported `10000`, and a
 * second silently-wrong bucket set would be just as invisible. A crashed deploy is
 * loud; a mis-bucketed latency metric is not.
 *
 * Strict ascent is checked rather than tolerated because the SDK's own histogram
 * aggregator SORTS and de-duplicates whatever it is handed (`Aggregation.js` does
 * `boundaries.sort()`). A typo'd or out-of-order array is therefore accepted upstream
 * and quietly turned into a *different* bucket set than the operator wrote — one with a
 * different boundary count, so the `_bucket` series will not match the dashboard they
 * built alongside it. Better to name the offending value.
 */
function validateHttpDurationBoundaries(boundaries: number[]): void {
  if (boundaries.length === 0) {
    throw new Error(
      'startOtel: httpDurationBoundaries must not be empty. Omit the option entirely to keep the OpenTelemetry default buckets.',
    );
  }

  for (let i = 0; i < boundaries.length; i += 1) {
    const value = boundaries[i];

    // Covers NaN and +/-Infinity in one check. `Infinity` is especially worth
    // rejecting: the SDK strips it, so the array silently loses an entry.
    if (!Number.isFinite(value)) {
      throw new Error(
        `startOtel: httpDurationBoundaries[${i}] is not a finite number (received ${String(value)}). Boundaries must be finite millisecond values.`,
      );
    }

    // Negative latency is not a thing; a negative boundary is a sign-flip or a unit
    // mix-up, and it produces a bucket no observation can ever fall into.
    if (value < 0) {
      throw new Error(
        `startOtel: httpDurationBoundaries[${i}] is negative (received ${value}). Boundaries are milliseconds and cannot be below zero.`,
      );
    }

    if (i > 0) {
      const previous = boundaries[i - 1];
      if (value <= previous) {
        throw new Error(
          `startOtel: httpDurationBoundaries must be strictly ascending, but ${previous} at index ${i - 1} is not below ${value} at index ${i}.`,
        );
      }
    }
  }
}

/**
 * Resolve the root sampling ratio. An unparseable override must not silently turn
 * tracing off: `TraceIdRatioBasedSampler` normalises NaN to 0, so
 * `OTEL_SAMPLING_PROBABILITY=ten-percent` would drop every trace with no error anywhere.
 * Fall back to the environment default and say so instead. Out-of-range numbers keep the
 * sampler's own clamping to [0, 1]. (Telemetry config never crashes the process — only a
 * bad `httpDurationBoundaries` option does, because that is code, not deployment.)
 */
function resolveSamplingProbability(raw: string | undefined, isProd: boolean): number {
  const fallback = isProd ? 0.1 : 1.0;
  if (raw === undefined) return fallback;

  const parsed = Number.parseFloat(raw);
  if (Number.isNaN(parsed)) {
    process.emitWarning(
      `OTEL_SAMPLING_PROBABILITY=${JSON.stringify(raw)} is not a number; using ${fallback}.`,
      'OtelSamplingWarning',
    );
    return fallback;
  }
  return parsed;
}

/**
 * Kubernetes identity for the resource, from the downward API variables the chart
 * injects (`K8S_POD_NAME`, `K8S_NAMESPACE`, `K8S_NODE_NAME`). An attribute is added only
 * when its variable is non-empty, so a non-Kubernetes run (local, CI) emits none rather
 * than three empty strings. If the collector's Kubernetes attributes processor also adds
 * them the values are identical, so there is nothing to reconcile.
 */
function k8sResourceAttributes(env: NodeJS.ProcessEnv): Record<string, string> {
  const attributes: Record<string, string> = {};
  const mapping: ReadonlyArray<readonly [string, string]> = [
    ['k8s.pod.name', 'K8S_POD_NAME'],
    ['k8s.namespace.name', 'K8S_NAMESPACE'],
    ['k8s.node.name', 'K8S_NODE_NAME'],
  ];
  for (const [attribute, variable] of mapping) {
    const value = env[variable]?.trim();
    if (value) attributes[attribute] = value;
  }
  return attributes;
}

let sdk: NodeSDK | undefined;

/**
 * Start the SDK when `OTEL_ENABLED=true`; otherwise do nothing at all (the OTel
 * API returns no-op instruments, so `@Span()` and any metric calls stay safe).
 *
 * Returns `true` when tracing actually started — the caller can log it, which is
 * the only cheap way to tell "observability is off" from "observability is broken".
 */
export function startOtel(options: OtelBootstrapOptions): boolean {
  // Validated BEFORE the OTEL_ENABLED gate, on purpose. The boundaries are static
  // config, not runtime state, so their correctness does not depend on whether the
  // collector is switched on — and every environment where OTel is off (local dev, CI,
  // a product that has not adopted it yet) is exactly where a typo in this array should
  // be caught. Gating the check behind OTEL_ENABLED would let a bad array ship all the
  // way to the one environment that has telemetry enabled: production.
  if (options.httpDurationBoundaries !== undefined) {
    validateHttpDurationBoundaries(options.httpDurationBoundaries);
  }

  if (process.env['OTEL_ENABLED'] !== 'true') return false;
  if (sdk) return true; // idempotent — a second call must not double-register

  // DEPLOYMENT_ENV, not NODE_ENV. NODE_ENV is a RUNTIME MODE, not a deployment
  // identity, and products deliberately pin it to "production" outside production:
  // rally's develop does so because `devLoginAllowed` is `nodeEnv !== 'production'`,
  // and a public host must not expose passwordless dev-login. Deriving deployment
  // identity from it would label every develop span, metric and log
  // `deployment.environment.name=production` — indistinguishable from real
  // production, breaking the per-environment backend split, cost attribution, and
  // every production alert. It also silently flipped the default sampling ratio to
  // the production 0.1 in develop.
  //
  // Falls back to NODE_ENV so a deployment that has not set DEPLOYMENT_ENV yet keeps
  // its previous behaviour rather than reporting "unknown".
  const deploymentEnv = process.env['DEPLOYMENT_ENV'] ?? process.env['NODE_ENV'] ?? 'development';
  const isProd = deploymentEnv === 'production';
  const serviceName =
    process.env[options.serviceNameEnvVar ?? 'OTEL_SERVICE_NAME'] ?? options.defaultServiceName;
  const endpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] ?? 'http://localhost:4318';

  // Head-sampling ratio: `parentbased_traceidratio`, default 0.1 in production and 1.0
  // elsewhere, overridable with OTEL_SAMPLING_PROBABILITY (the variable the products'
  // infrastructure already sets). This is all the SDK can do alone: keeping 100% of
  // errors and slow traces requires a collector-side TAIL sampler, because the decision
  // needs the finished trace. Until a gateway exists, a prod ratio below 1.0 drops most
  // error traces — prefer tail sampling over lowering this.
  const samplingProbability = resolveSamplingProbability(
    process.env['OTEL_SAMPLING_PROBABILITY'],
    isProd,
  );

  // NOTE ON THE API SHAPE: `@opentelemetry/sdk-metrics` v2 removed the 1.x
  // `new View({ aggregation: new ExplicitBucketHistogramAggregation([...]) })` form.
  // Neither `View` nor `ExplicitBucketHistogramAggregation` is exported from the
  // package root any more; `NodeSDK` takes `views?: ViewOptions[]`, plain declarative
  // objects, and the aggregation is the tagged union below. This package's peer range
  // is `@opentelemetry/sdk-metrics >=2`, so this is the only form that compiles.
  //
  // The array is copied. The SDK keeps the reference we hand it, so a caller that
  // mutates its own boundaries array after startup would otherwise re-bucket a live
  // histogram — and the validation above would already have passed.
  const httpDurationView: { views?: ViewOptions[] } =
    options.httpDurationBoundaries === undefined
      ? {}
      : {
          views: [
            {
              instrumentName: HTTP_SERVER_DURATION_INSTRUMENT,
              aggregation: {
                type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
                options: { boundaries: [...options.httpDurationBoundaries] },
              },
            },
          ],
        };

  sdk = new NodeSDK({
    serviceName,
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: process.env['SERVICE_VERSION'] ?? 'dev',
      [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: deploymentEnv,
      // Namespace ties every product's signals together under one company label,
      // so a shared-dependency incident can be queried across products.
      'service.namespace': process.env['OTEL_SERVICE_NAMESPACE'] ?? 'qnsc',
      // Unique per task/container — correlates a trace to one instance.
      'service.instance.id': randomUUID(),
      ...k8sResourceAttributes(process.env),
    }),

    // ParentBased respects an upstream sampling decision, so a trace that starts
    // in the browser or another service stays whole.
    sampler: new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(samplingProbability),
    }),

    spanProcessors: [
      new BatchSpanProcessor(new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }), {
        maxExportBatchSize: isProd ? 200 : 50,
        exportTimeoutMillis: isProd ? 5_000 : 2_000,
        scheduledDelayMillis: isProd ? 2_000 : 1_000,
      }),
    ],

    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
      exportIntervalMillis: isProd ? 30_000 : 10_000,
    }),

    // Spread, not `views: views` — when the caller omits the option the key must be
    // ABSENT from the config object, not present-and-empty. `views: []` is not the same
    // thing as no views: it hands the MeterProvider a (currently ignored, but not
    // contractually inert) view registry, and it changes what every other product's SDK
    // config looks like. Every consumer that does not opt in has to see byte-identical
    // configuration to what it got before this option existed.
    ...httpDurationView,

    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-http': {
          enabled: true,
          ignoreIncomingRequestHook: (req) => isIgnoredRequestPath(req.url),
        },
        '@opentelemetry/instrumentation-pg': { enabled: true },
        '@opentelemetry/instrumentation-ioredis': { enabled: true },
        // OFF. AWS is leaving the estate; the products' S3 client now talks to R2 and
        // every call is already a span from the http instrumentation. This one adds a
        // second span per SDK call (and the SDK's own retry spans) for no extra signal,
        // inside the span budget of the Grafana Cloud free tier.
        '@opentelemetry/instrumentation-aws-sdk': { enabled: false },
        // High-volume, low-value: these bury the spans that matter.
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
        '@opentelemetry/instrumentation-net': { enabled: false },
      }),
    ],
  });

  sdk.start();
  return true;
}

/**
 * Flush pending spans and shut the SDK down. Call from the process's signal
 * handler BEFORE closing the Nest app, so in-flight spans are exported rather
 * than dropped. Safe to call when OTel never started.
 */
export async function shutdownOtel(): Promise<void> {
  if (sdk) await sdk.shutdown();
}

/** Test seam: forget the started SDK so a spec can exercise startOtel again. */
export function resetOtelForTesting(): void {
  sdk = undefined;
}

/** @deprecated Use {@link IGNORED_REQUEST_PATHS}. Retained for the existing spec. */
export const __ignoredRequestPaths = IGNORED_REQUEST_PATHS;
