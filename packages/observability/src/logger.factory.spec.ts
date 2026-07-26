import { beforeEach, describe, expect, it } from 'vitest';
import { requestContextStorage } from './request-context';
import { __redactedPaths, createLoggerOptions } from './logger.factory';

const base = {
  serviceName: 'rally-api',
  nodeEnv: 'test',
  serviceVersion: '1.2.3',
  level: 'info',
};

/** The mixin is the only part with logic; reach it the way pino would. */
function mixinOf(options: ReturnType<typeof createLoggerOptions>) {
  const mixin = options.pinoHttp?.mixin;
  if (typeof mixin !== 'function') throw new Error('mixin is not configured');
  return () => mixin({}, 0, {} as never);
}

describe('createLoggerOptions', () => {
  it('redacts every credential-bearing path', () => {
    // The worker's hand-rolled copy of this config had NO redact list at all, which
    // is the defect this factory exists to make impossible. Pin the list.
    const { pinoHttp } = createLoggerOptions(base);
    const paths = pinoHttp?.redact;

    expect(paths).toMatchObject({ censor: '[REDACTED]' });
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
    const { pinoHttp } = createLoggerOptions(base);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const props = (pinoHttp as any).customProps();
    expect(props).toEqual({ service: 'rally-api', env: 'test', version: '1.2.3' });
  });

  it('takes the service name from the caller, so api and worker differ', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const worker = (createLoggerOptions({ ...base, serviceName: 'rally-worker' }).pinoHttp as any)
      .customProps();
    expect(worker.service).toBe('rally-worker');
  });

  it('disables autoLogging so the interceptor owns the request line', () => {
    expect(createLoggerOptions(base).pinoHttp?.autoLogging).toBe(false);
  });

  describe('pretty printing', () => {
    it('is on outside production', () => {
      expect(createLoggerOptions({ ...base, nodeEnv: 'development' }).pinoHttp?.transport).toBeDefined();
    });

    it('is off in production, so aggregators get raw JSON', () => {
      expect(
        createLoggerOptions({ ...base, nodeEnv: 'production' }).pinoHttp?.transport,
      ).toBeUndefined();
    });

    it('honours an explicit override', () => {
      expect(
        createLoggerOptions({ ...base, nodeEnv: 'production', pretty: true }).pinoHttp?.transport,
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
