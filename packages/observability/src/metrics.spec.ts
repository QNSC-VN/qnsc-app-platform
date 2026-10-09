import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const record = vi.fn();
const add = vi.fn();
const createHistogram = vi.fn(() => ({ record }));
const createCounter = vi.fn(() => ({ add }));
const addCallback = vi.fn();
const createObservableGauge = vi.fn(() => ({ addCallback }));

vi.mock('@opentelemetry/api', () => ({
  ValueType: { INT: 1 },
  metrics: {
    getMeter: () => ({ createHistogram, createCounter, createObservableGauge }),
  },
}));

import {
  AuthMetrics,
  DbPoolMetrics,
  HttpMetrics,
  JobMetrics,
  LabelCardinalityGuard,
  METRIC_NAMES,
  OVERFLOW_LABEL_VALUE,
  QueueMetrics,
  SecurityMetrics,
  methodLabelOf,
  normalizeRoute,
  statusClassOf,
} from './metrics';

describe('label bounding', () => {
  it.each([
    [200, '2xx'],
    [204, '2xx'],
    [301, '3xx'],
    [404, '4xx'],
    [422, '4xx'],
    [500, '5xx'],
    [503, '5xx'],
  ])('buckets %i as %s', (code, expected) => {
    // Raw status codes are unbounded enough to hurt; three buckets answer the
    // questions dashboards actually ask.
    expect(statusClassOf(code)).toBe(expected);
  });

  it.each([
    ['get', 'GET'],
    ['POST', 'POST'],
    ['patch', 'PATCH'],
    ['PROPFIND', 'OTHER'],
    ['', 'OTHER'],
  ])('collapses method %o to %s', (method, expected) => {
    expect(methodLabelOf(method)).toBe(expected);
  });

  describe('normalizeRoute', () => {
    it('replaces uuid segments', () => {
      expect(normalizeRoute('/v1/work-items/019f8a11-2b3c-7d4e-8f90-a1b2c3d4e5f6')).toBe(
        '/v1/work-items/:id',
      );
    });

    it('replaces numeric segments', () => {
      expect(normalizeRoute('/v1/iterations/42/burndown')).toBe('/v1/iterations/:id/burndown');
    });

    it('replaces long opaque ids', () => {
      expect(normalizeRoute('/v1/files/AbCdEf0123456789xyz')).toBe('/v1/files/:id');
    });

    it('handles several ids in one path', () => {
      expect(
        normalizeRoute('/v1/work-items/019f8a11-2b3c-7d4e-8f90-a1b2c3d4e5f6/comments/7'),
      ).toBe('/v1/work-items/:id/comments/:id');
    });

    it('drops the query string, which is the worst cardinality offender', () => {
      expect(normalizeRoute('/v1/work-items?projectId=019f8a11&page=3')).toBe('/v1/work-items');
    });

    it('leaves genuine path segments alone', () => {
      expect(normalizeRoute('/v1/bff/login/start')).toBe('/v1/bff/login/start');
      expect(normalizeRoute('/v1/work-items')).toBe('/v1/work-items');
    });

    it('keeps hyphenated words that are long but not ids', () => {
      // `work-items` is 10 chars with a hyphen; the opaque-id rule must not eat it.
      expect(normalizeRoute('/v1/notification-preferences')).toBe('/v1/notification-preferences');
    });

    it('maps the root path to /', () => {
      expect(normalizeRoute('/')).toBe('/');
    });
  });
});

describe('HttpMetrics', () => {
  beforeEach(() => vi.clearAllMocks());

  it('records duration and count with bounded labels only', () => {
    new HttpMetrics().record({
      route: '/v1/work-items/:id',
      method: 'patch',
      statusCode: 200,
      durationMs: 12.5,
    });

    expect(record).toHaveBeenCalledWith(12.5, {
      route: '/v1/work-items/:id',
      method: 'PATCH',
      status_class: '2xx',
    });
    expect(add).toHaveBeenCalledWith(1, {
      route: '/v1/work-items/:id',
      method: 'PATCH',
      status_class: '2xx',
    });
  });

  it('does not count an error for a success', () => {
    new HttpMetrics().record({
      route: '/r',
      method: 'GET',
      statusCode: 200,
      durationMs: 1,
    });
    // one call for the request counter, none for errors
    expect(add).toHaveBeenCalledTimes(1);
  });

  it('counts an error with its domain code', () => {
    new HttpMetrics().record({
      route: '/r',
      method: 'GET',
      statusCode: 422,
      durationMs: 1,
      errorCode: 'ITERATION_CLOSED',
    });
    expect(add).toHaveBeenCalledWith(1, { route: '/r', error_code: 'ITERATION_CLOSED' });
  });

  it('labels an uncoded failure rather than dropping it', () => {
    new HttpMetrics().record({ route: '/r', method: 'GET', statusCode: 500, durationMs: 1 });
    expect(add).toHaveBeenCalledWith(1, { route: '/r', error_code: 'UNKNOWN' });
  });
});

describe('JobMetrics', () => {
  beforeEach(() => vi.clearAllMocks());

  it('records a successful run', () => {
    new JobMetrics().record('daily-cleanup', 250, 'success');
    expect(record).toHaveBeenCalledWith(250, { job: 'daily-cleanup', outcome: 'success' });
    expect(add).toHaveBeenCalledWith(1, { job: 'daily-cleanup', outcome: 'success' });
  });

  it('adds a failure counter on failure', () => {
    new JobMetrics().record('daily-cleanup', 10, 'failure');
    expect(add).toHaveBeenCalledWith(1, { job: 'daily-cleanup' });
  });

  it('times a successful callback and returns its value', async () => {
    await expect(new JobMetrics().time('job', async () => 7)).resolves.toBe(7);
    expect(add).toHaveBeenCalledWith(1, { job: 'job', outcome: 'success' });
  });

  it('records a failure and re-throws, so a job cannot fail silently', async () => {
    const metrics = new JobMetrics();
    await expect(metrics.time('job', () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    );
    expect(add).toHaveBeenCalledWith(1, { job: 'job', outcome: 'failure' });
  });
});

describe('QueueMetrics', () => {
  beforeEach(() => vi.clearAllMocks());

  it('records processed and failed counts', () => {
    const metrics = new QueueMetrics();
    metrics.recordProcessed('outbox', 5);
    metrics.recordFailure('outbox', 2);
    expect(add).toHaveBeenCalledWith(5, { queue: 'outbox' });
    expect(add).toHaveBeenCalledWith(2, { queue: 'outbox' });
  });

  it('skips zero-count batches instead of emitting noise', () => {
    const metrics = new QueueMetrics();
    metrics.recordProcessed('outbox', 0);
    metrics.recordFailure('outbox', 0);
    expect(add).not.toHaveBeenCalled();
  });

  it('records backlog age, which is what reveals a relay falling behind', () => {
    new QueueMetrics().recordLag('outbox', 42);
    expect(record).toHaveBeenCalledWith(42, { queue: 'outbox' });
  });

  it('ignores nonsense lag values', () => {
    const metrics = new QueueMetrics();
    metrics.recordLag('outbox', -1);
    metrics.recordLag('outbox', Number.NaN);
    expect(record).not.toHaveBeenCalled();
  });
});

describe('DbPoolMetrics', () => {
  beforeEach(() => vi.clearAllMocks());

  it('registers observable callbacks rather than pushing values', () => {
    // A pool reading is a gauge, not a counter: UpDownCounter.add(3) twice reports 6.
    // Observable gauges are pulled at collection time, so the value is always current
    // and the product owns no timer.
    new DbPoolMetrics().register(() => ({ inUse: 3, waiting: 1 }));
    expect(addCallback).toHaveBeenCalledTimes(2);
  });

  it('reads the pool through the callback on each collection', () => {
    let inUse = 2;
    new DbPoolMetrics().register(() => ({ inUse, waiting: 0 }));

    const observe = vi.fn();
    const inUseCallback = addCallback.mock.calls[0][0] as (r: { observe: typeof observe }) => void;

    inUseCallback({ observe });
    inUse = 7;
    inUseCallback({ observe });

    // Second collection sees the new value — the point of a pull-based gauge.
    expect(observe).toHaveBeenNthCalledWith(1, 2);
    expect(observe).toHaveBeenNthCalledWith(2, 7);
  });

  it('ignores a second register, which would double-report every value', () => {
    const metrics = new DbPoolMetrics();
    metrics.register(() => ({ inUse: 1, waiting: 0 }));
    metrics.register(() => ({ inUse: 1, waiting: 0 }));
    expect(addCallback).toHaveBeenCalledTimes(2);
  });
});

describe('SecurityMetrics', () => {
  beforeEach(() => vi.clearAllMocks());

  it('counts a fail-open by control name', () => {
    new SecurityMetrics().recordFailOpen('denylist');
    expect(add).toHaveBeenCalledWith(1, { control: 'denylist' });
  });

  it('counts a stale-token rejection', () => {
    new SecurityMetrics().recordStaleToken();
    expect(add).toHaveBeenCalledWith(1);
  });
});

describe('AuthMetrics', () => {
  beforeEach(() => vi.clearAllMocks());

  it('counts a successful SSO login', () => {
    new AuthMetrics().recordLogin('sso', 'success');
    expect(add).toHaveBeenCalledWith(1, { method: 'sso', outcome: 'success' });
  });

  it('counts a failed dev login', () => {
    new AuthMetrics().recordLogin('dev', 'failure');
    expect(add).toHaveBeenCalledWith(1, { method: 'dev', outcome: 'failure' });
  });
});

describe('METRIC_NAMES', () => {
  it('every declared name has a recorder that emits it', () => {
    // The previous approach declared 23 names and implemented none, which implied
    // coverage that did not exist. This asserts the inverse: nothing is declared
    // here unless something above creates an instrument for it.
    vi.clearAllMocks();
    new HttpMetrics();
    new JobMetrics();
    new QueueMetrics();
    new DbPoolMetrics();
    new SecurityMetrics();
    new AuthMetrics();

    const created = [
      ...createHistogram.mock.calls,
      ...createCounter.mock.calls,
      ...createObservableGauge.mock.calls,
    ].map((call) => call[0]);

    expect(new Set(created)).toEqual(new Set(Object.values(METRIC_NAMES)));
  });
});

describe('LabelCardinalityGuard', () => {
  it('passes values through untouched while under the limit', () => {
    const guard = new LabelCardinalityGuard({ route: 3 });
    expect(guard.bound('http.server', 'route', '/a')).toBe('/a');
    expect(guard.bound('http.server', 'route', '/b')).toBe('/b');
    expect(guard.bound('http.server', 'route', '/c')).toBe('/c');
  });

  it('merges every NEW value past the limit into one overflow bucket', () => {
    // The failure this guards against: an id in a label mints a series per value.
    const guard = new LabelCardinalityGuard({ route: 2 });
    guard.bound('http.server', 'route', '/a');
    guard.bound('http.server', 'route', '/b');

    expect(guard.bound('http.server', 'route', '/c')).toBe(OVERFLOW_LABEL_VALUE);
    expect(guard.bound('http.server', 'route', '/d')).toBe(OVERFLOW_LABEL_VALUE);
  });

  it('keeps recording values it already admitted after the limit is hit', () => {
    // Counts that were right must stay right; only the unbounded tail is merged.
    const guard = new LabelCardinalityGuard({ route: 1 });
    guard.bound('http.server', 'route', '/a');
    guard.bound('http.server', 'route', '/leak/1');

    expect(guard.bound('http.server', 'route', '/a')).toBe('/a');
  });

  it('counts each (scope, label) separately', () => {
    const guard = new LabelCardinalityGuard({}, 1);
    guard.bound('job', 'job', 'nightly');
    // A different recorder has its own budget.
    expect(guard.bound('queue', 'queue', 'outbox')).toBe('outbox');
  });

  it('falls back to the default limit for a label with no specific limit', () => {
    const guard = new LabelCardinalityGuard({}, 1);
    guard.bound('x', 'other', 'one');
    expect(guard.bound('x', 'other', 'two')).toBe(OVERFLOW_LABEL_VALUE);
  });

  it('cuts an over-long value instead of storing it whole', () => {
    const guard = new LabelCardinalityGuard();
    expect(guard.bound('x', 'route', 'a'.repeat(500))).toHaveLength(128);
  });

  it('warns once per label, not once per overflowing value', () => {
    const guard = new LabelCardinalityGuard({ route: 1 });
    const warn = vi.spyOn(
      (guard as unknown as { logger: { warn: (m: string) => void } }).logger,
      'warn',
    );
    guard.bound('http.server', 'route', '/a');
    for (let i = 0; i < 50; i += 1) guard.bound('http.server', 'route', `/leak/${i}`);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('"route"');
  });
});

describe('recorders apply the label guard', () => {
  beforeEach(() => vi.clearAllMocks());

  // The recorders share one process-wide guard, so these use names no other test uses.
  it('HttpMetrics stops a per-id route from minting a series per request', () => {
    const http = new HttpMetrics();
    for (let i = 0; i < 520; i += 1) {
      http.record({ route: `/leak/${i}`, method: 'GET', statusCode: 200, durationMs: 1 });
    }
    const routes = new Set(add.mock.calls.map(([, labels]) => (labels as { route: string }).route));

    // At most the 500 admitted routes plus the overflow bucket — never all 520. (Other
    // specs in this file share the process-wide guard, so the exact count would depend
    // on test order.)
    expect(routes.size).toBeLessThanOrEqual(501);
    expect(routes.size).toBeGreaterThan(400);
    expect(routes.has(OVERFLOW_LABEL_VALUE)).toBe(true);
  });

  it('JobMetrics stops a per-tenant job name from minting a series per tenant', () => {
    const jobs = new JobMetrics();
    for (let i = 0; i < 120; i += 1) jobs.record(`sync-tenant-${i}`, 1, 'success');
    const names = new Set(add.mock.calls.map(([, labels]) => (labels as { job: string }).job));

    expect(names.size).toBeLessThanOrEqual(101);
    expect(names.size).toBeGreaterThan(90);
    expect(names.has(OVERFLOW_LABEL_VALUE)).toBe(true);
  });

  it('QueueMetrics bounds the queue label on every instrument', () => {
    const queues = new QueueMetrics();
    for (let i = 0; i < 120; i += 1) {
      queues.recordProcessed(`q-${i}`);
      queues.recordFailure(`q-${i}`);
      queues.recordLag(`q-${i}`, 1);
    }
    const seen = new Set(
      [...add.mock.calls, ...record.mock.calls].map(
        ([, labels]) => (labels as { queue: string }).queue,
      ),
    );
    expect(seen.size).toBeLessThanOrEqual(101);
    expect(seen.has(OVERFLOW_LABEL_VALUE)).toBe(true);
  });
});

/**
 * Metrics are recorded from the request path. They must be total: no argument and no
 * failing instrument may turn into an exception in the caller (fail-open contract).
 */
describe('metrics never throw into the request path', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('LabelCardinalityGuard.bound is total', () => {
    const guard = new LabelCardinalityGuard();

    it.each([
      ['undefined', undefined, 'UNKNOWN'],
      ['null', null, 'UNKNOWN'],
      ['a number', 42, '42'],
      ['an object', { a: 1 }, '[object Object]'],
    ])('coerces %s', (_label, value, expected) => {
      expect(guard.bound('t', 'route', value)).toBe(expected);
    });

    it('returns the overflow label instead of throwing on a hostile value', () => {
      const hostile = {
        toString() {
          throw new Error('boom');
        },
      };
      expect(guard.bound('t', 'route', hostile)).toBe(OVERFLOW_LABEL_VALUE);
    });
  });

  it('HttpMetrics.record survives an undefined route (an unmatched request)', () => {
    expect(() =>
      new HttpMetrics().record({
        route: undefined as unknown as string,
        method: 'GET',
        statusCode: 404,
        durationMs: 1,
      }),
    ).not.toThrow();
    // A string label (`UNKNOWN`, or the overflow bucket if an earlier test filled the shared
    // guard) — never `undefined`, which the backend would reject.
    expect(add).toHaveBeenCalledWith(1, expect.objectContaining({ route: expect.any(String) }));
  });

  it('HttpMetrics.record survives an undefined method and errorCode', () => {
    expect(() =>
      new HttpMetrics().record({
        route: '/r',
        method: undefined as unknown as string,
        statusCode: 500,
        durationMs: 1,
      }),
    ).not.toThrow();
  });

  it('JobMetrics.record survives an undefined job name', () => {
    expect(() =>
      new JobMetrics().record(undefined as unknown as string, 1, 'success'),
    ).not.toThrow();
  });

  it('QueueMetrics survives an undefined queue name on every recorder', () => {
    const queues = new QueueMetrics();
    const none = undefined as unknown as string;
    expect(() => {
      queues.recordProcessed(none);
      queues.recordFailure(none);
      queues.recordLag(none, 1);
    }).not.toThrow();
  });

  it('a failing instrument costs a data point, not the caller', () => {
    add.mockImplementationOnce(() => {
      throw new Error('instrument exploded');
    });
    expect(() =>
      new HttpMetrics().record({ route: '/r', method: 'GET', statusCode: 200, durationMs: 1 }),
    ).not.toThrow();
  });

  it('JobMetrics.time still re-throws the job error when recording itself fails', async () => {
    add.mockImplementation(() => {
      throw new Error('instrument exploded');
    });
    try {
      await expect(
        new JobMetrics().time('job', () => Promise.reject(new Error('job failed'))),
      ).rejects.toThrow('job failed');
      await expect(new JobMetrics().time('job', async () => 7)).resolves.toBe(7);
    } finally {
      add.mockReset();
    }
  });

  describe('SecurityMetrics and AuthMetrics', () => {
    const exploding = () => {
      add.mockImplementation(() => {
        throw new Error('instrument exploded');
      });
    };
    afterEach(() => add.mockReset());

    it('SecurityMetrics.recordFailOpen costs a data point, not the caller', () => {
      exploding();
      expect(() => new SecurityMetrics().recordFailOpen('rate_limit')).not.toThrow();
    });

    it('SecurityMetrics.recordStaleToken costs a data point, not the caller', () => {
      exploding();
      expect(() => new SecurityMetrics().recordStaleToken()).not.toThrow();
    });

    it('AuthMetrics.recordLogin costs a data point, not the caller', () => {
      exploding();
      expect(() => new AuthMetrics().recordLogin('sso', 'failure')).not.toThrow();
    });

    it('still records normally when nothing is wrong', () => {
      new SecurityMetrics().recordFailOpen('denylist');
      new AuthMetrics().recordLogin('dev', 'success');
      expect(add).toHaveBeenCalledWith(1, { control: 'denylist' });
      expect(add).toHaveBeenCalledWith(1, { method: 'dev', outcome: 'success' });
    });
  });
});
