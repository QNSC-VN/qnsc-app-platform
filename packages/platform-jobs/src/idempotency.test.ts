import { describe, expect, it } from 'vitest';
import { idempotencyId } from './idempotency';

describe('idempotencyId', () => {
  it('is deterministic', () => {
    expect(idempotencyId('mail.send', 'reset:u1:abc')).toBe(
      idempotencyId('mail.send', 'reset:u1:abc'),
    );
  });

  it('is a version-5, variant-1 UUID', () => {
    expect(idempotencyId('q', 'k')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('differs per key and per queue, so one key may be reused on another queue', () => {
    expect(idempotencyId('q', 'a')).not.toBe(idempotencyId('q', 'b'));
    expect(idempotencyId('q1', 'a')).not.toBe(idempotencyId('q2', 'a'));
  });

  it('cannot be confused by moving the boundary between queue and key', () => {
    expect(idempotencyId('ab', 'c')).not.toBe(idempotencyId('a', 'bc'));
  });

  it('is FROZEN: a change here silently ends deduplication of every retained job', () => {
    // Computed independently with Python's uuid.uuid5(namespace, 'queue\x00key'). If this fails you
    // changed the namespace or the derivation. Do not "fix" the expectation.
    expect(idempotencyId('mail.send', 'password-reset:user-1:token-hash')).toBe(
      'd717b7c5-509a-5f57-ae00-209800e46857',
    );
  });
});
