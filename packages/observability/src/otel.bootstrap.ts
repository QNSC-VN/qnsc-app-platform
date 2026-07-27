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
 * built-ins, and consumers must import it via the `@qnsc-vn/observability/otel`
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
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-base';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { IGNORED_REQUEST_PATHS } from './ignored-paths';
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
  const deploymentEnv =
    process.env['DEPLOYMENT_ENV'] ?? process.env['NODE_ENV'] ?? 'development';
  const isProd = deploymentEnv === 'production';
  const serviceName =
    process.env[options.serviceNameEnvVar ?? 'OTEL_SERVICE_NAME'] ?? options.defaultServiceName;
  const endpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] ?? 'http://localhost:4318';

  // Head-sampling ratio. This is all the SDK can do alone: keeping 100% of errors
  // and slow traces requires a collector-side TAIL sampler, because the decision
  // needs the finished trace. Until a gateway exists, a prod ratio below 1.0 drops
  // most error traces — prefer tail sampling over lowering this.
  const samplingProbability = Number.parseFloat(
    process.env['OTEL_SAMPLING_PROBABILITY'] ?? (isProd ? '0.1' : '1.0'),
  );

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

    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-http': {
          enabled: true,
          ignoreIncomingRequestHook: (req) => IGNORED_REQUEST_PATHS.has(req.url ?? ''),
        },
        '@opentelemetry/instrumentation-pg': { enabled: true },
        '@opentelemetry/instrumentation-ioredis': { enabled: true },
        '@opentelemetry/instrumentation-aws-sdk': { enabled: true },
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
