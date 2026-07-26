import { beforeEach, describe, expect, it } from 'vitest';
import { requestContextStorage } from './request-context';
import { __redactedPaths, createLoggerOptions } from './logger.factory';

const base = {
  serviceName: 'rally-api',
  nodeEnv: 'test',
  serviceVersion: '1.2.3',
  level: 'info',
};

/**
 * `pinoHttp` is typed as a union that includes a DestinationStream, so reading the
 * option fields needs one narrowing here rather than a cast at every assertion.
 */
interface PinoHttpShape {
  level?: string;
  transport?: unknown;
  redact?: { paths: string[]; censor: string };
  autoLogging?: boolean;
  customProps?: () => Record<string, unknown>;
  mixin?: () => Record<string, unknown>;
}

function optionsOf(params: ReturnType<typeof createLoggerOptions>): PinoHttpShape {
  return params.pinoHttp as PinoHttpShape;
}

/** The mixin is the only part with logic; reach it the way pino would. */
function mixinOf(params: ReturnType<typeof createLoggerOptions>) {
  const mixin = optionsOf(params).mixin;
  if (typeof mixin !== 'function') throw new Error('mixin is not configured');
  return mixin;
}

describe('createLoggerOptions', () => {
  it('redacts every credential-bearing path', () => {
    // The worker's hand-rolled copy of this config had NO redact list at all, which
    // is the defect this factory exists to make impossible. Pin the list.
    expect(optionsOf(createLoggerOptions(base)).redact).toMatchObject({ censor: '[REDACTED]' });
    for (const path of [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      'req.headers["x-api-key"]',
      'req.headers["x-csrf-token"]',
    ]) {
      expect(__redactedPaths).toContain(path);
    }
  });

  it('also redacts credentials nested in SDK error objects', () => {
    // The worker's realistic leak path: an AWS/GitHub SDK error carrying the
    // original request headers.
    expect(__redactedPaths).toContain('err.config.headers.authorization');
    expect(__redactedPaths).toContain('err.request.headers.authorization');
  });

  it('stamps service, env and version on every line', () => {
    const props = optionsOf(createLoggerOptions(base)).customProps?.();
    expect(props).toEqual({ service: 'rally-api', env: 'test', version: '1.2.3' });
  });

  it('takes the service name from the caller, so api and worker differ', () => {
    const worker = optionsOf(
      createLoggerOptions({ ...base, serviceName: 'rally-worker' }),
    ).customProps?.();
    expect(worker?.['service']).toBe('rally-worker');
  });

  it('disables autoLogging so the interceptor owns the request line', () => {
    expect(optionsOf(createLoggerOptions(base)).autoLogging).toBe(false);
  });

  describe('pretty printing', () => {
    it('is on outside production', () => {
      expect(
        optionsOf(createLoggerOptions({ ...base, nodeEnv: 'development' })).transport,
      ).toBeDefined();
    });

    it('is off in production, so aggregators get raw JSON', () => {
      expect(
        optionsOf(createLoggerOptions({ ...base, nodeEnv: 'production' })).transport,
      ).toBeUndefined();
    });

    it('honours an explicit override', () => {
      expect(
        optionsOf(createLoggerOptions({ ...base, nodeEnv: 'production', pretty: true })).transport,
      ).toBeDefined();
    });
  });

  describe('mixin', () => {
    let mixin: () => Record<string, unknown>;

    beforeEach(() => {
      mixin = mixinOf(createLoggerOptions(base));
    });

    it('adds nothing when there is no context', () => {
      expect(mixin()).toEqual({});
    });

    it('lifts the business context out of AsyncLocalStorage', () => {
      // This is what lets a log line be attributed without any call site passing it.
      requestContextStorage.run(
        {
          workspaceId: 'ws-1',
          userId: 'user-1',
          sessionId: 'sess-1',
          correlationId: 'corr-1',
          traceparent: undefined,
        },
        () => {
          expect(mixin()).toEqual({
            workspaceId: 'ws-1',
            userId: 'user-1',
            correlationId: 'corr-1',
          });
        },
      );
    });

    it('omits absent context fields rather than logging undefined', () => {
      requestContextStorage.run(
        {
          workspaceId: undefined,
          userId: undefined,
          sessionId: undefined,
          correlationId: 'corr-2',
          traceparent: undefined,
        },
        () => {
          expect(mixin()).toEqual({ correlationId: 'corr-2' });
        },
      );
    });
  });
});
