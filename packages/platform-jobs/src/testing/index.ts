import { randomUUID } from 'node:crypto';
import { JobsImpl } from '../engine';
import type { JobContext, Jobs } from '../types';

function impl(jobs: Jobs): JobsImpl {
  if (!(jobs instanceof JobsImpl)) {
    throw new Error(
      'platform-jobs/testing works with the Jobs created by createJobs() / JobsModule.',
    );
  }
  return jobs;
}

/**
 * Run a queue's handler on `data` right now, in this process, without the database or a worker:
 * for a unit test of the handler. `ROLE` does not matter. Rejects with what the handler throws.
 *
 * The job gets a fresh id, `attempt: 1` and an un-aborted signal. Use `drainQueue` to exercise the
 * real thing (retries, retention) against a database.
 */
export async function runInline<T extends object>(
  jobs: Jobs,
  queue: string,
  data: T,
  overrides: Partial<Pick<JobContext<T>, 'id' | 'attempt'>> = {},
): Promise<void> {
  const handler = impl(jobs).handlerFor(queue);
  if (!handler)
    throw new Error(`No handler is registered for queue "${queue}": call jobs.handle() first.`);
  const controller = new AbortController();
  await handler.fn({
    id: overrides.id ?? randomUUID(),
    data,
    attempt: overrides.attempt ?? 1,
    signal: controller.signal,
  });
}

/**
 * Process every job that is READY on `queue` now, to completion, in this process, through the same
 * path a worker uses: a real pg-boss worker runs the same batch code as production, so the handler
 * gets a real `AbortSignal`, a failure stores the output a worker stores, a `PermanentJobError`
 * dead-letters at once, and retention and retries behave as they do there. `ROLE` does not matter
 * and your own polling is not involved: a test that enqueues and then calls this is deterministic.
 *
 * Jobs scheduled for later (`startAfter`, a retry's backoff) are not ready and are left alone.
 * Rejects with the first handler error, after settling every job it had fetched. **Also rejects
 * if the queue is still not quiet after 60 seconds** (a handler that never returns, or one that
 * keeps enqueuing work for its own queue), rather than returning as if it had drained. Requires
 * `jobs.start()` (the database).
 */
export async function drainQueue(jobs: Jobs, queue: string): Promise<void> {
  await impl(jobs).drain(queue);
}
