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

import {
  __ignoredRequestPaths,
  resetOtelForTesting,
  shutdownOtel,
  startOtel,
} from './otel.bootstrap';

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
      startOtel({ defaultServiceName: 'rally-api' });
      expect(nodeSdkConstructor.mock.calls[0][0]).toMatchObject({ serviceName: 'rally-api' });
    });

    it('reads the env var the caller nominates, so worker and api can differ', () => {
      // A single task definition can host both processes; without a distinct var
      // they would report as the same service.
      process.env['OTEL_WORKER_SERVICE_NAME'] = 'rally-worker';
      startOtel({
        defaultServiceName: 'fallback',
        serviceNameEnvVar: 'OTEL_WORKER_SERVICE_NAME',
      });
      expect(nodeSdkConstructor.mock.calls[0][0]).toMatchObject({ serviceName: 'rally-worker' });
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

  it('never traces health, readiness, or favicon requests', () => {
    // Probes run on a fixed schedule and would otherwise dominate both the trace
    // volume and the bill. Readiness was previously missing from this list.
    expect([...__ignoredRequestPaths]).toEqual(
      expect.arrayContaining(['/v1/healthz', '/v1/readyz', '/healthz', '/readyz', '/favicon.ico']),
    );
  });
});

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
