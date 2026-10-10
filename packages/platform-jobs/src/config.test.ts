import { describe, expect, it } from 'vitest';
import {
  DEFAULTS,
  JobsConfigError,
  assertQueueName,
  assertTimeZone,
  resolveHandler,
  resolveQueue,
  resolveRetention,
} from './config';

const DAY = 86_400;

describe('resolveQueue: the documented defaults', () => {
  const q = resolveQueue('orders.sync');

  it.each([
    ['expireInSeconds', q.queue.expireInSeconds, 900],
    ['retryLimit', q.queue.retryLimit, 3],
    ['retryDelay', q.queue.retryDelay, 5],
    ['retryDelayMax', q.queue.retryDelayMax, 300],
    ['retryBackoff', q.queue.retryBackoff, true],
    ['completed retention', q.queue.deleteAfterSeconds, 7 * DAY],
    ['dead-letter retention', q.deadLetterQueue.retentionSeconds, 30 * DAY],
  ])('%s is %s', (_name, actual, expected) => {
    expect(actual).toBe(expected);
  });

  it('creates a dead-letter queue named after the queue', () => {
    expect(q.deadLetter).toBe('orders.sync.dlq');
    expect(q.queue.deadLetter).toBe('orders.sync.dlq');
  });

  it('has no heartbeat for a job of 15 minutes or less of lease... except above 300 s', () => {
    // 900 s lease > 300 s: the default queue DOES get a heartbeat.
    expect(q.queue.heartbeatSeconds).toBe(DEFAULTS.heartbeatSeconds);
    expect(resolveQueue('short', { expireInSeconds: 120 }).queue.heartbeatSeconds).toBeNull();
    expect(resolveQueue('edge', { expireInSeconds: 300 }).queue.heartbeatSeconds).toBeNull();
    expect(resolveQueue('long', { expireInSeconds: 301 }).queue.heartbeatSeconds).toBe(30);
  });

  it('keeps successes by default (no immediate delete)', () => {
    expect(q.deleteOnSuccess).toBe(false);
  });
});

describe('retryLimit: minimum 1 (a pod drain spends an attempt)', () => {
  it('refuses 0 and says why', () => {
    expect(() => resolveQueue('q', { retryLimit: 0 })).toThrow(JobsConfigError);
    expect(() => resolveQueue('q', { retryLimit: 0 })).toThrow(/pod drain.*dead-letter/s);
  });

  it('accepts 0 only when the queue says it accepts dead-lettering on drain', () => {
    const q = resolveQueue('q', { retryLimit: 0, acceptDeadLetterOnDrain: true });
    expect(q.queue.retryLimit).toBe(0);
  });

  it('accepts 1', () => {
    expect(resolveQueue('q', { retryLimit: 1 }).queue.retryLimit).toBe(1);
  });

  it.each([-1, 1.5, 101])('rejects %s', (value) => {
    expect(() => resolveQueue('q', { retryLimit: value, acceptDeadLetterOnDrain: true })).toThrow(
      /retryLimit/,
    );
  });
});

describe('heartbeat', () => {
  it('is explicit when given, minimum 10', () => {
    expect(resolveQueue('q', { heartbeatSeconds: 10 }).queue.heartbeatSeconds).toBe(10);
    expect(() => resolveQueue('q', { heartbeatSeconds: 9 })).toThrow(/heartbeatSeconds/);
  });
  it('an explicit heartbeat applies even to a short lease', () => {
    expect(
      resolveQueue('q', { expireInSeconds: 60, heartbeatSeconds: 20 }).queue.heartbeatSeconds,
    ).toBe(20);
  });
});

describe('retention is per queue', () => {
  it('mail.send: completed deleted immediately, failed and dead-lettered kept at most 24 h', () => {
    const q = resolveQueue('mail.send', {
      retention: { completed: 'immediate', failed: DAY, deadLetter: DAY },
    });
    expect(q.deleteOnSuccess).toBe(true);
    // The rows that remain are failures; they live 24 h.
    expect(q.queue.deleteAfterSeconds).toBe(DAY);
    expect(q.deadLetterQueue.retentionSeconds).toBe(DAY);
    expect(q.deadLetterQueue.deleteAfterSeconds).toBe(DAY);
  });

  it('a number applies to completed and failed rows alike (one clock)', () => {
    const q = resolveQueue('q', { retention: { completed: 3600 } });
    expect(q.queue.deleteAfterSeconds).toBe(3600);
    expect(q.deleteOnSuccess).toBe(false);
  });

  it('failed alone sets the clock too', () => {
    expect(resolveQueue('q', { retention: { failed: 7200 } }).queue.deleteAfterSeconds).toBe(7200);
  });

  it('the same number twice is fine', () => {
    expect(
      resolveQueue('q', { retention: { completed: 3600, failed: 3600 } }).queue.deleteAfterSeconds,
    ).toBe(3600);
  });

  it('two different numbers are refused, explaining the single clock and the way out', () => {
    expect(() => resolveQueue('q', { retention: { completed: 3600, failed: 86_400 } })).toThrow(
      /one clock.*immediate/s,
    );
  });

  it("'immediate' without failed keeps failures for the default", () => {
    expect(resolveRetention('q', { completed: 'immediate' }).finishedSeconds).toBe(7 * DAY);
  });

  it.each([0, -5, 1.5])('rejects a retention of %s seconds', (value) => {
    expect(() => resolveRetention('q', { completed: value })).toThrow(/retention.completed/);
    expect(() => resolveRetention('q', { deadLetter: value })).toThrow(/retention.deadLetter/);
  });

  it('different queues have different retention', () => {
    const a = resolveQueue('a', { retention: { completed: 60 } });
    const b = resolveQueue('b');
    expect(a.queue.deleteAfterSeconds).not.toBe(b.queue.deleteAfterSeconds);
  });
});

describe('retention.pending: how long a job nobody processed may wait', () => {
  it("defaults to pg-boss's 14 days, written explicitly so a queue converges to it", () => {
    const q = resolveQueue('q');
    expect(q.queue.retentionSeconds).toBe(14 * DAY);
    expect(q.pendingWatch, 'a queue that did not ask is not watched').toBe(false);
  });

  it('maps to the queue retention and asks the worker to watch the queue', () => {
    const q = resolveQueue('mail.send', { retention: { pending: DAY } });
    expect(q.queue.retentionSeconds).toBe(DAY);
    expect(q.pendingWatch).toBe(true);
  });

  it('is part of the definition: two different windows are two definitions', () => {
    expect(resolveQueue('q', { retention: { pending: DAY } }).fingerprint).not.toBe(
      resolveQueue('q', { retention: { pending: 2 * DAY } }).fingerprint,
    );
    expect(resolveQueue('q').fingerprint).not.toBe(
      resolveQueue('q', { retention: { pending: 14 * DAY } }).fingerprint,
    );
  });

  it.each([0, 59, -1, 1.5, 24])(
    'refuses %s: a typo for 24 hours would delete jobs before anyone fetched them',
    (value) => {
      expect(() => resolveQueue('q', { retention: { pending: value } })).toThrow(
        /retention.pending/,
      );
    },
  );

  it('refuses a window shorter than the retries can take, because a retry does not extend the deadline', () => {
    // (retryLimit + 1) x (expire + 75) + retryLimit x retryDelayMax = 4 x 975 + 3 x 300 = 4800 s by default
    expect(() => resolveQueue('q', { retention: { pending: 4_799 } })).toThrow(
      /shorter than the least that covers the retries.*4800 s.*75 s.*does not extend/s,
    );
    expect(() => resolveQueue('q', { retention: { pending: 4_800 } })).not.toThrow();
    // The margin counts once per attempt: without it 4500 s would have been accepted.
    expect(() => resolveQueue('q', { retention: { pending: 4_500 } })).toThrow(/4800 s/);
    expect(() =>
      resolveQueue('q', {
        retention: { pending: 3600 },
        retryLimit: 1,
        expireInSeconds: 600,
        retryDelayMaxSeconds: 60,
      }),
    ).not.toThrow();
  });

  it('a queue that did not ask is not checked against its retries (it keeps the 14 days)', () => {
    expect(() =>
      resolveQueue('q', { retryLimit: 100, retryDelayMaxSeconds: 86_400 }),
    ).not.toThrow();
  });
});

describe('queue and dead-letter names', () => {
  it.each(['mail.send', 'a', 'billing/invoice-run', 'x_1.y-2'])('accepts %s', (name) => {
    expect(() => assertQueueName(name)).not.toThrow();
  });
  it.each(['', ' ', 'a b', '-lead', 'semi;colon', "quote'", 'x'.repeat(101)])(
    'rejects %j',
    (name) => {
      expect(() => assertQueueName(name)).toThrow(/not valid/);
    },
  );
  it('a queue whose DEFAULT dead-letter name would exceed 100 characters is refused with the way out', () => {
    const name = 'q'.repeat(97);
    expect(() => assertQueueName(name)).not.toThrow();
    expect(() => resolveQueue(name)).toThrow(
      /default dead-letter queue .* longer than 100 characters.*at most 96/s,
    );
    expect(() => resolveQueue('q'.repeat(96))).not.toThrow();
    expect(() => resolveQueue(name, { deadLetter: 'short.dlq' })).not.toThrow();
  });
  it('a queue cannot be its own dead-letter queue', () => {
    expect(() => resolveQueue('q', { deadLetter: 'q' })).toThrow(/itself/);
  });
  it('a custom dead-letter queue is used', () => {
    expect(resolveQueue('q', { deadLetter: 'shared.dead' }).deadLetter).toBe('shared.dead');
  });
});

describe('resolveHandler', () => {
  it('defaults: concurrency 4, polling 1 s', () => {
    expect(resolveHandler('q')).toEqual({ concurrency: 4, pollingIntervalSeconds: 1 });
  });
  it('polling has a floor of 0.5 s', () => {
    expect(resolveHandler('q', { pollingIntervalSeconds: 0.5 }).pollingIntervalSeconds).toBe(0.5);
    expect(() => resolveHandler('q', { pollingIntervalSeconds: 0.4 })).toThrow(
      /pollingIntervalSeconds/,
    );
  });
  it.each([0, -1, 1.5, 1001])('rejects concurrency %s', (value) => {
    expect(() => resolveHandler('q', { concurrency: value })).toThrow(/concurrency/);
  });
});

describe('the fingerprint tells two definitions of one queue apart', () => {
  it('is equal for equal config and different otherwise', () => {
    expect(resolveQueue('q', { retryLimit: 2 }).fingerprint).toBe(
      resolveQueue('q', { retryLimit: 2 }).fingerprint,
    );
    expect(resolveQueue('q', { retryLimit: 2 }).fingerprint).not.toBe(
      resolveQueue('q', { retryLimit: 3 }).fingerprint,
    );
  });
});

describe('time zones', () => {
  it('accepts IANA names', () => {
    expect(() => assertTimeZone('Asia/Ho_Chi_Minh')).not.toThrow();
    expect(() => assertTimeZone('UTC')).not.toThrow();
  });
  it('rejects a typo', () => {
    expect(() => assertTimeZone('Asia/Saigonn')).toThrow(/IANA/);
  });
});
