import { requestContextStorage } from '@quynhonsemiconductor/observability';
import { describe, expect, it } from 'vitest';
import { correlationIdFor, currentCorrelationId, fallbackCorrelationId } from './correlation';

const inRequest = <T>(correlationId: unknown, fn: () => T): T =>
  requestContextStorage.run({ correlationId } as never, fn);

describe('correlationIdFor: the id a handler runs under', () => {
  it.each([
    'req-123',
    '8f3a2c1e-0b7d-4c55-9a11-2f6d3e9b7c01',
    'api:POST:orders',
    'A.b_c-d:9',
    'x',
    'a'.repeat(128),
  ])('keeps a valid payload id (%s)', (id) => {
    expect(correlationIdFor('mail.send', 'job-1', { correlationId: id })).toBe(id);
  });

  it.each([
    ['empty', ''],
    ['too long', 'a'.repeat(129)],
    ['a space', 'two words'],
    ['a quote', 'say"hi'],
    ['CR/LF (log forging)', 'abc\r\nfake: line'],
    ['a control character', 'abc\u0007'],
    ['non-ASCII', 'héllo'],
    ['a slash', 'a/b'],
  ])('replaces an invalid id (%s) with queue:jobId', (_why, id) => {
    expect(correlationIdFor('mail.send', 'job-1', { correlationId: id })).toBe('mail.send:job-1');
  });

  it.each([42, true, null, undefined, ['req-1'], { id: 'req-1' }])(
    'ignores a payload id that is not a string (%j)',
    (id) => {
      expect(correlationIdFor('q', 'j', { correlationId: id })).toBe('q:j');
    },
  );

  it.each([null, undefined, 'text', 7, []])('falls back when the payload is %j', (data) => {
    expect(correlationIdFor('q', 'j', data)).toBe('q:j');
  });

  it('falls back when the payload has no correlationId', () => {
    expect(correlationIdFor('q', 'j', { orderId: 1 })).toBe('q:j');
  });
});

describe('currentCorrelationId: for the sender', () => {
  it('is undefined outside any context', () => {
    expect(currentCorrelationId()).toBeUndefined();
  });

  it("returns the request's id", () => {
    expect(inRequest('req-123', currentCorrelationId)).toBe('req-123');
  });

  it('continues a job: inside a handler it returns the job id it runs under', () => {
    expect(inRequest('mail.send:abc', currentCorrelationId)).toBe('mail.send:abc');
  });

  it.each(['', 'has space', 'a\r\nb', 'a'.repeat(129), 42, undefined])(
    'refuses to hand a sender an invalid id (%j): undefined, so it never reaches a payload',
    (id) => {
      expect(inRequest(id, currentCorrelationId)).toBeUndefined();
    },
  );
});

describe('the fallback id is itself a VALID correlation id (contract section 7)', () => {
  const VALID = /^[A-Za-z0-9._:-]{1,128}$/;
  const jobId = '0511712b-4d19-4a0d-94af-2889cf900c74';
  const longQueue = `billing/${'x'.repeat(92)}`; // 100 characters, with a slash: the worst a queue name may be

  it('is just queue:jobId for an ordinary queue name', () => {
    expect(fallbackCorrelationId('mail.send', jobId)).toBe(`mail.send:${jobId}`);
  });

  it('a queue name with a slash and 100 characters still yields a valid id of at most 128 characters', () => {
    expect(longQueue).toHaveLength(100);
    const id = fallbackCorrelationId(longQueue, jobId);
    expect(id).toMatch(VALID);
    expect(id.length).toBeLessThanOrEqual(128);
    // The part that makes it unique is never cut; the queue part gives way.
    expect(id.endsWith(`:${jobId}`)).toBe(true);
    expect(id.startsWith('billing.xxx')).toBe(true);
  });

  it('is what correlationIdFor returns for such a queue, and currentCorrelationId() accepts it (the chain does not break)', () => {
    const id = correlationIdFor(longQueue, jobId, { orderId: 1 });
    expect(id).toMatch(VALID);
    expect(inRequest(id, currentCorrelationId)).toBe(id);
  });

  it.each(['a/b', 'a b', 'a"b', 'a\r\nb', 'héllo', 'a#b'])(
    'replaces %j so the result is valid',
    (queue) => {
      expect(fallbackCorrelationId(queue, jobId)).toMatch(VALID);
    },
  );

  it('two jobs on the same long queue still get different ids', () => {
    const other = '9f2c1b00-0000-4000-8000-000000000001';
    expect(fallbackCorrelationId(longQueue, jobId)).not.toBe(
      fallbackCorrelationId(longQueue, other),
    );
  });
});
