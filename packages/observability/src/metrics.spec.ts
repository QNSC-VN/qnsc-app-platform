import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  DbPoolMetrics,
  HttpMetrics,
  JobMetrics,
  METRIC_NAMES,
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

    const created = [
      ...createHistogram.mock.calls,
      ...createCounter.mock.calls,
      ...createObservableGauge.mock.calls,
    ].map((call) => call[0]);

    expect(new Set(created)).toEqual(new Set(Object.values(METRIC_NAMES)));
  });
});
