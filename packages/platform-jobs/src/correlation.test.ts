import { requestContextStorage } from '@quynhonsemiconductor/observability';
import { describe, expect, it } from 'vitest';
import { correlationIdFor, currentCorrelationId } from './correlation';

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
