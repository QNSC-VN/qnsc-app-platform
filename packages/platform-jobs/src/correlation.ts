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

/**
 * The correlation id a handler runs under: the one the sender put in the payload as
 * `correlationId`, if it is a string that satisfies the contract; otherwise `queue:jobId`, a job
 * that did not start in a request gets its own, prefixed with the queue. An invalid id is dropped,
 * never logged.
 */
export function correlationIdFor(queue: string, jobId: string, data: unknown): string {
  if (typeof data === 'object' && data !== null) {
    const candidate = (data as { correlationId?: unknown }).correlationId;
    if (typeof candidate === 'string' && SAFE_CORRELATION_ID.test(candidate)) return candidate;
  }
  return `${queue}:${jobId}`;
}
