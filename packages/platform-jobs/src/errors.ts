/**
 * Marks a failure that retrying cannot fix: a payload that will never parse, a recipient that does
 * not exist, a precondition that is permanently gone. A handler that throws it sends the job
 * STRAIGHT to the dead-letter queue, with no retries left to spend and no backoff to wait out.
 *
 * ```ts
 * if (!user) throw new PermanentJobError(`user ${job.data.userId} no longer exists`);
 * ```
 *
 * Anything else a handler throws is retried (up to `retryLimit`, with backoff). The message is
 * stored on the job, truncated: put no secret in it.
 */
const PERMANENT = Symbol.for('@quynhonsemiconductor/platform-jobs:permanent');

export class PermanentJobError extends Error {
  readonly [PERMANENT] = true;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PermanentJobError';
  }
}

/** By marker rather than `instanceof`, so two copies of this package in a tree still agree. */
export function isPermanent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as Record<symbol, unknown>)[PERMANENT] === true
  );
}
