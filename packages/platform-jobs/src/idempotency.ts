import { createHash } from 'node:crypto';

/**
 * RFC 9562 namespace for this package's idempotency keys. A fixed constant, not a secret, and
 * FROZEN: changing it changes every derived job id, which silently ends deduplication for jobs
 * that are already queued or retained.
 */
const NAMESPACE = Buffer.from('4c9d0f3ea6b24f6d9a5e1b7c2d8f3a60', 'hex');

/**
 * The job id for an idempotency key: a deterministic UUID (version 5) of `(queue, key)`.
 *
 * pg-boss lets the caller choose a job's `id`, and `(name, id)` is the primary key, so a second
 * `send` with the same id inserts nothing and returns `null` (ADR 0001, F6). It also holds across
 * transactions: a concurrent duplicate blocks until the first commits or rolls back. `singletonKey`
 * does NOT dedupe on a standard queue, which is why this is not used.
 *
 * The queue is part of the input, so one key may be reused on different queues.
 */
export function idempotencyId(queue: string, key: string): string {
  const hash = createHash('sha1').update(NAMESPACE).update(`${queue}\u0000${key}`).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
