import { requestContextStorage } from '@quynhonsemiconductor/observability';

/**
 * The platform contract's rule for a correlation id (section 7): 1 to 128 characters from
 * `[A-Za-z0-9._:-]`. The id is untrusted input wherever it came from; a value with a space, a
 * quote or CR/LF would forge log records, so anything else is replaced.
 */
const SAFE_CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * The correlation id of the code that is running now (the request that is being served, or the job
 * that is being run), or `undefined` when there is none or it is not a valid id. A SENDER puts it in
 * the payload so the job continues the request's id:
 *
 * ```ts
 * await jobs.send('invoice.render', { orderId, correlationId: currentCorrelationId() }, { tx });
 * ```
 *
 * It is explicit on purpose. `platform-jobs` never adds a key to your payload: a strictly validated
 * payload (an `EmailMessage`, a webhook body) must not grow fields it did not declare.
 */
export function currentCorrelationId(): string | undefined {
  const id = requestContextStorage.getStore()?.correlationId;
  return typeof id === 'string' && SAFE_CORRELATION_ID.test(id) ? id : undefined;
}

/** Longest id the contract allows, and the characters it allows. */
const MAX_LENGTH = 128;
const UNSAFE = /[^A-Za-z0-9._:-]/g;

/**
 * The id a job gets when its payload carries none: `queue:jobId`, made VALID per the contract.
 *
 * Queue names may contain `/` and run to 100 characters, and a job id is 36, so the plain
 * `queue:jobId` can break both rules (137 characters; a slash). An id that is not valid is refused by
 * `currentCorrelationId()`, which silently ends the chain at the next job. So characters outside
 * `[A-Za-z0-9._:-]` become `.`, and the QUEUE part is truncated so the whole id fits in 128 (the
 * job id, the part that makes it unique, is never cut).
 */
export function fallbackCorrelationId(queue: string, jobId: string): string {
  const id = jobId.replace(UNSAFE, '.').slice(0, 64);
  const room = MAX_LENGTH - 1 - id.length;
  return `${queue.replace(UNSAFE, '.').slice(0, Math.max(1, room))}:${id}`;
}

/**
 * The correlation id a handler runs under: the one the sender put in the payload as
 * `correlationId`, if it is a string that satisfies the contract; otherwise a valid `queue:jobId`
 * ({@link fallbackCorrelationId}), as a job that did not start in a request gets its own, prefixed
 * with the queue. An invalid id is dropped, never logged.
 */
export function correlationIdFor(queue: string, jobId: string, data: unknown): string {
  if (typeof data === 'object' && data !== null) {
    const candidate = (data as { correlationId?: unknown }).correlationId;
    if (typeof candidate === 'string' && SAFE_CORRELATION_ID.test(candidate)) return candidate;
  }
  return fallbackCorrelationId(queue, jobId);
}
