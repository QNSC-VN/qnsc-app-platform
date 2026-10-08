import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The SDK is stubbed: starting a real NodeSDK would install global
 * auto-instrumentation into the test process and try to reach a collector. What
 * matters here is the *policy* — when we start, what we name ourselves, what we
 * refuse to trace — not that OpenTelemetry works.
 */
const start = vi.fn();
const shutdown = vi.fn().mockResolvedValue(undefined);
const nodeSdkConstructor = vi.fn();

vi.mock('@opentelemetry/sdk-node', () => ({
  NodeSDK: class {
    constructor(config: unknown) {
      nodeSdkConstructor(config);
    }
    start = start;
    shutdown = shutdown;
  },
}));

import { AggregationType } from '@opentelemetry/sdk-metrics';
import { PROBE_PATHS } from './ignored-paths';
import {
  __ignoredRequestPaths,
  resetOtelForTesting,
  shutdownOtel,
  startOtel,
} from './otel.bootstrap';
// Imported for ONE assertion. `otel.bootstrap` cannot import `./metrics` — that module
// reaches `@nestjs/common`, and the bootstrap must not pull Nest in before
// `sdk.start()` — so the instrument name is a literal there. A spec has no such
// constraint, so this is where the literal and the canonical name are pinned together.
import { METRIC_NAMES } from './metrics';

const ORIGINAL_ENV = { ...process.env };

describe('startOtel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetOtelForTesting();
    process.env = { ...ORIGINAL_ENV };
    delete process.env['OTEL_ENABLED'];
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('does nothing unless OTEL_ENABLED is exactly "true"', () => {
    expect(startOtel({ defaultServiceName: 'svc' })).toBe(false);
    expect(start).not.toHaveBeenCalled();
  });

  it.each(['false', 'TRUE', '1', ''])('treats OTEL_ENABLED=%o as off', (value) => {
    // Only the literal "true" enables it — no truthiness surprises.
    process.env['OTEL_ENABLED'] = value;
    expect(startOtel({ defaultServiceName: 'svc' })).toBe(false);
  });

  it('starts when enabled', () => {
    process.env['OTEL_ENABLED'] = 'true';
    expect(startOtel({ defaultServiceName: 'svc' })).toBe(true);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('is idempotent — a second call does not double-register instrumentation', () => {
    process.env['OTEL_ENABLED'] = 'true';
    startOtel({ defaultServiceName: 'svc' });
    startOtel({ defaultServiceName: 'svc' });
    expect(start).toHaveBeenCalledTimes(1);
  });

  describe('service identity', () => {
    beforeEach(() => {
      process.env['OTEL_ENABLED'] = 'true';
    });

    it('falls back to the caller-supplied name', () => {
      startOtel({ defaultServiceName: 'rova-api' });
      expect(nodeSdkConstructor.mock.calls[0][0]).toMatchObject({ serviceName: 'rova-api' });
    });

    it('reads the env var the caller nominates, so worker and api can differ', () => {
      // A single task definition can host both processes; without a distinct var
      // they would report as the same service.
      process.env['OTEL_WORKER_SERVICE_NAME'] = 'rova-worker';
      startOtel({
        defaultServiceName: 'fallback',
        serviceNameEnvVar: 'OTEL_WORKER_SERVICE_NAME',
      });
      expect(nodeSdkConstructor.mock.calls[0][0]).toMatchObject({ serviceName: 'rova-worker' });
    });

    it('stamps namespace, version, environment and instance id on the resource', () => {
      process.env['SERVICE_VERSION'] = '1.4.2';
      process.env['NODE_ENV'] = 'production';
      startOtel({ defaultServiceName: 'svc' });

      const { resource } = nodeSdkConstructor.mock.calls[0][0] as {
        resource: { attributes: Record<string, unknown> };
      };
      expect(resource.attributes).toMatchObject({
        'service.name': 'svc',
        'service.version': '1.4.2',
        'deployment.environment.name': 'production',
        'service.namespace': 'qnsc',
      });
      // Per-task, so a trace can be pinned to one container.
      expect(resource.attributes['service.instance.id']).toEqual(expect.any(String));
    });

    // Regression guard. NODE_ENV is a runtime MODE, not a deployment identity, and
    // products deliberately pin it to "production" outside production — rally's
    // develop does, because `devLoginAllowed` is `nodeEnv !== 'production'` and a
    // public host must not expose passwordless dev-login. Deriving deployment
    // identity from it labelled every develop signal as production.
    it('takes the deployment environment from DEPLOYMENT_ENV, not NODE_ENV', () => {
      process.env['NODE_ENV'] = 'production'; // as rally's develop really runs
      process.env['DEPLOYMENT_ENV'] = 'develop';
      startOtel({ defaultServiceName: 'svc' });

      const { resource } = nodeSdkConstructor.mock.calls[0][0] as {
        resource: { attributes: Record<string, unknown> };
      };
      expect(resource.attributes['deployment.environment.name']).toBe('develop');
    });

    it('falls back to NODE_ENV when DEPLOYMENT_ENV is unset', () => {
      // Keeps a deployment that has not adopted DEPLOYMENT_ENV on its old behaviour
      // rather than reporting "unknown".
      process.env['NODE_ENV'] = 'production';
      delete process.env['DEPLOYMENT_ENV'];
      startOtel({ defaultServiceName: 'svc' });

      const { resource } = nodeSdkConstructor.mock.calls[0][0] as {
        resource: { attributes: Record<string, unknown> };
      };
      expect(resource.attributes['deployment.environment.name']).toBe('production');
    });

    // The same root cause reached sampling: `isProd` gated the DEFAULT ratio, so a
    // develop pinned to NODE_ENV=production silently sampled at the production 0.1
    // and dropped 90% of the traces it was collecting them for.
    it.each([
      ['develop', 'TraceIdRatioBased{1}'],
      ['production', 'TraceIdRatioBased{0.1}'],
    ])('defaults the sampling ratio from DEPLOYMENT_ENV=%s', (env, expected) => {
      process.env['NODE_ENV'] = 'production'; // identical in both deployments
      process.env['DEPLOYMENT_ENV'] = env;
      delete process.env['OTEL_SAMPLING_PROBABILITY'];
      startOtel({ defaultServiceName: 'svc' });

      const { sampler } = nodeSdkConstructor.mock.calls[0][0] as { sampler: unknown };
      expect(String(sampler)).toContain(expected);
    });
  });

  /**
   * The p99 alert on rally reported `10000`. That is not a latency — it is the largest
   * finite boundary of the OTel JS default explicit histogram, which `histogram_quantile`
   * clamps to, so a 12s request and a 180s request were the same number. Those requests
   * return 200 (the resilience presets budget 60s x 3 attempts), so the 5xx alert could
   * not see them either. Widening the buckets is opt-in, because it restates the
   * exported `_bucket` series and invalidates whatever was built on the old ones.
   */
  describe('httpDurationBoundaries', () => {
    beforeEach(() => {
      process.env['OTEL_ENABLED'] = 'true';
    });

    // The load-bearing test for every OTHER product in the monorepo. Omitting the
    // option must not merely produce an equivalent config — it must produce the SAME
    // config, with no `views` key at all. `views: []` would fail this deliberately.
    it('adds no views key at all when the option is omitted', () => {
      startOtel({ defaultServiceName: 'svc' });

      const config = nodeSdkConstructor.mock.calls[0][0] as Record<string, unknown>;
      expect('views' in config).toBe(false);
      expect(config['views']).toBeUndefined();
    });

    it('registers one view on http.server.duration with exactly the given boundaries', () => {
      const boundaries = [0, 100, 1_000, 10_000, 30_000, 60_000, 120_000, 300_000];
      startOtel({ defaultServiceName: 'svc', httpDurationBoundaries: boundaries });

      const { views } = nodeSdkConstructor.mock.calls[0][0] as { views: unknown[] };
      expect(views).toHaveLength(1);
      expect(views[0]).toEqual({
        instrumentName: 'http.server.duration',
        aggregation: {
          type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
          options: { boundaries },
        },
      });
    });

    // Guards the one duplicated string in the package. `otel.bootstrap` may not import
    // `./metrics` (Nest), so the instrument name is a literal there; if someone renames
    // the metric in METRIC_NAMES the View would silently select nothing and the buckets
    // would revert to the defaults with no error anywhere. This is that error.
    it('selects the same instrument name METRIC_NAMES declares', () => {
      startOtel({ defaultServiceName: 'svc', httpDurationBoundaries: [1, 2, 3] });

      const { views } = nodeSdkConstructor.mock.calls[0][0] as {
        views: { instrumentName: string }[];
      };
      expect(views[0].instrumentName).toBe(METRIC_NAMES.HTTP_SERVER_DURATION);
    });

    // The SDK keeps the reference it is handed, so a caller mutating its own array
    // afterwards would re-bucket a live histogram past validation.
    it('copies the array so a later caller mutation cannot re-bucket a live histogram', () => {
      const boundaries = [10, 20, 30];
      startOtel({ defaultServiceName: 'svc', httpDurationBoundaries: boundaries });
      boundaries.push(-1);

      const { views } = nodeSdkConstructor.mock.calls[0][0] as {
        views: { aggregation: { options: { boundaries: number[] } } }[];
      };
      expect(views[0].aggregation.options.boundaries).toEqual([10, 20, 30]);
    });

    describe('rejects a bucket set that would look fine and lie', () => {
      it('throws on an empty array, pointing at omitting the option instead', () => {
        expect(() => startOtel({ defaultServiceName: 'svc', httpDurationBoundaries: [] })).toThrow(
          /must not be empty/,
        );
        expect(start).not.toHaveBeenCalled();
      });

      // Infinity matters as much as NaN: the SDK strips it, so the array silently
      // loses an entry and the series has one fewer bucket than the operator wrote.
      it.each([
        ['NaN', [0, Number.NaN, 100]],
        ['Infinity', [0, 100, Number.POSITIVE_INFINITY]],
        ['-Infinity', [Number.NEGATIVE_INFINITY, 100]],
      ])('throws on %s, naming the offending value', (label, boundaries) => {
        expect(() =>
          startOtel({ defaultServiceName: 'svc', httpDurationBoundaries: boundaries }),
        ).toThrow(new RegExp(`not a finite number \\(received ${label}\\)`));
        expect(start).not.toHaveBeenCalled();
      });

      it('throws on a negative boundary, naming the offending value', () => {
        expect(() =>
          startOtel({ defaultServiceName: 'svc', httpDurationBoundaries: [0, -5, 100] }),
        ).toThrow(/httpDurationBoundaries\[1\] is negative \(received -5\)/);
        expect(start).not.toHaveBeenCalled();
      });

      // Not merely "unsorted": the SDK's aggregator sorts and de-duplicates whatever it
      // gets, so an out-of-order or repeated boundary is accepted upstream and quietly
      // becomes a different bucket set — one that no longer matches the dashboard built
      // beside it. Equal neighbours are as wrong as descending ones.
      it.each([
        ['descending', [0, 500, 100, 1_000], /500 at index 1 is not below 100 at index 2/],
        ['a repeated boundary', [0, 100, 100], /100 at index 1 is not below 100 at index 2/],
      ])('throws on %s', (_label, boundaries, expected) => {
        expect(() =>
          startOtel({ defaultServiceName: 'svc', httpDurationBoundaries: boundaries }),
        ).toThrow(expected);
        expect(start).not.toHaveBeenCalled();
      });

      // Validation runs BEFORE the OTEL_ENABLED gate. Local dev and CI run with OTel
      // off, and that is precisely where a typo in this array should surface — not in
      // the single environment that has telemetry switched on: production.
      it('throws even when OTEL_ENABLED is off, so a typo fails in dev and CI too', () => {
        delete process.env['OTEL_ENABLED'];
        expect(() =>
          startOtel({ defaultServiceName: 'svc', httpDurationBoundaries: [100, 50] }),
        ).toThrow(/strictly ascending/);
      });
    });
  });

  it('never traces health, readiness, or favicon requests', () => {
    // Probes run on a fixed schedule and would otherwise dominate both the trace
    // volume and the bill. `/livez` — the kubelet liveness path — was missing.
    expect([...__ignoredRequestPaths]).toEqual(
      expect.arrayContaining([...PROBE_PATHS, '/favicon.ico']),
    );
  });

  describe('probe filtering', () => {
    beforeEach(() => {
      process.env['OTEL_ENABLED'] = 'true';
    });

    // The hook the HTTP instrumentation really calls — not just the constant — so a
    // future edit that stops using the shared list fails here.
    it.each([...PROBE_PATHS, '/favicon.ico', '/livez?verbose=1'])('ignores incoming %s', (url) => {
      startOtel({ defaultServiceName: 'svc' });
      expect(ignoreHook()({ url })).toBe(true);
    });

    it('keeps real routes', () => {
      startOtel({ defaultServiceName: 'svc' });
      expect(ignoreHook()({ url: '/v1/users' })).toBe(false);
      expect(ignoreHook()({})).toBe(false);
    });
  });

  describe('instrumentations', () => {
    beforeEach(() => {
      process.env['OTEL_ENABLED'] = 'true';
    });

    it('does not include the AWS SDK instrumentation', () => {
      startOtel({ defaultServiceName: 'svc' });
      expect(instrumentationNames()).not.toContain('@opentelemetry/instrumentation-aws-sdk');
    });

    it('still includes the instrumentations the products rely on', () => {
      startOtel({ defaultServiceName: 'svc' });
      expect(instrumentationNames()).toEqual(
        expect.arrayContaining([
          '@opentelemetry/instrumentation-http',
          '@opentelemetry/instrumentation-pg',
          '@opentelemetry/instrumentation-ioredis',
        ]),
      );
    });
  });

  describe('Kubernetes resource attributes', () => {
    beforeEach(() => {
      process.env['OTEL_ENABLED'] = 'true';
      delete process.env['K8S_POD_NAME'];
      delete process.env['K8S_NAMESPACE'];
      delete process.env['K8S_NODE_NAME'];
    });

    it('maps the downward-API variables onto k8s.* resource attributes', () => {
      process.env['K8S_POD_NAME'] = 'rova-api-7d9f-x2k4q';
      process.env['K8S_NAMESPACE'] = 'rova';
      process.env['K8S_NODE_NAME'] = 'qnsc-node-1';
      startOtel({ defaultServiceName: 'svc' });

      expect(resourceAttributes()).toMatchObject({
        'k8s.pod.name': 'rova-api-7d9f-x2k4q',
        'k8s.namespace.name': 'rova',
        'k8s.node.name': 'qnsc-node-1',
      });
    });

    it('emits none of them outside Kubernetes, rather than empty strings', () => {
      startOtel({ defaultServiceName: 'svc' });
      const attributes = resourceAttributes();

      expect(Object.keys(attributes).filter((key) => key.startsWith('k8s.'))).toEqual([]);
    });

    it('skips a variable that is set but blank', () => {
      process.env['K8S_POD_NAME'] = '   ';
      process.env['K8S_NAMESPACE'] = 'rova';
      startOtel({ defaultServiceName: 'svc' });
      const attributes = resourceAttributes();

      expect(attributes).not.toHaveProperty('k8s.pod.name');
      expect(attributes['k8s.namespace.name']).toBe('rova');
    });
  });

  describe('sampling', () => {
    beforeEach(() => {
      process.env['OTEL_ENABLED'] = 'true';
      delete process.env['OTEL_SAMPLING_PROBABILITY'];
    });

    const samplerOf = () =>
      String((nodeSdkConstructor.mock.calls[0][0] as { sampler: unknown }).sampler);

    it('is parentbased_traceidratio at 0.1 in production by default', () => {
      process.env['DEPLOYMENT_ENV'] = 'production';
      startOtel({ defaultServiceName: 'svc' });

      expect(samplerOf()).toContain('ParentBased');
      expect(samplerOf()).toContain('TraceIdRatioBased{0.1}');
    });

    it('is overridable with OTEL_SAMPLING_PROBABILITY', () => {
      process.env['DEPLOYMENT_ENV'] = 'production';
      process.env['OTEL_SAMPLING_PROBABILITY'] = '0.25';
      startOtel({ defaultServiceName: 'svc' });

      expect(samplerOf()).toContain('TraceIdRatioBased{0.25}');
    });

    // `TraceIdRatioBasedSampler` turns NaN into 0 — every trace dropped, no error.
    it.each(['', 'ten-percent'])('falls back to the default for %o and says so', (value) => {
      process.env['DEPLOYMENT_ENV'] = 'production';
      process.env['OTEL_SAMPLING_PROBABILITY'] = value;
      const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);

      startOtel({ defaultServiceName: 'svc' });

      expect(samplerOf()).toContain('TraceIdRatioBased{0.1}');
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining('OTEL_SAMPLING_PROBABILITY'),
        'OtelSamplingWarning',
      );
      warning.mockRestore();
    });
  });
});

/** The `ignoreIncomingRequestHook` handed to the HTTP instrumentation. */
function ignoreHook(): (req: { url?: string }) => boolean {
  const http = instrumentations().find(
    (i) => i.instrumentationName === '@opentelemetry/instrumentation-http',
  );
  const config = http?.getConfig() as {
    ignoreIncomingRequestHook: (req: { url?: string }) => boolean;
  };
  return config.ignoreIncomingRequestHook;
}

function instrumentations(): {
  instrumentationName: string;
  getConfig(): unknown;
}[] {
  const { instrumentations: list } = nodeSdkConstructor.mock.calls[0][0] as {
    instrumentations: ({ instrumentationName: string; getConfig(): unknown } | unknown[])[];
  };
  return list.flat() as { instrumentationName: string; getConfig(): unknown }[];
}

function instrumentationNames(): string[] {
  return instrumentations().map((i) => i.instrumentationName);
}

function resourceAttributes(): Record<string, unknown> {
  const { resource } = nodeSdkConstructor.mock.calls[0][0] as {
    resource: { attributes: Record<string, unknown> };
  };
  return resource.attributes;
}

describe('shutdownOtel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetOtelForTesting();
  });

  it('is safe when OTel never started', async () => {
    await expect(shutdownOtel()).resolves.toBeUndefined();
    expect(shutdown).not.toHaveBeenCalled();
  });

  it('flushes the SDK when it did start', async () => {
    process.env['OTEL_ENABLED'] = 'true';
    startOtel({ defaultServiceName: 'svc' });
    await shutdownOtel();
    expect(shutdown).toHaveBeenCalledTimes(1);
    delete process.env['OTEL_ENABLED'];
  });
});
