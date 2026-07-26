import { randomUUID } from 'node:crypto';
import { requestContextStorage, type RequestContext } from './request-context';

/**
 * Give background work the same request context an HTTP request gets.
 *
 * `AsyncLocalStorageMiddleware` seeds the store for HTTP requests only, so every
 * cron job, outbox relay, and queue consumer ran with an empty store — their log
 * lines carried no `correlationId` and no `workspaceId`. The practical effect is
 * that you cannot follow one business action from the API request that triggered it
 * into the worker that finished it, which is exactly when you most want to.
 *
 * Wrap a job body in this and every log line inside it — including nested service
 * calls — gains a correlation id for free:
 *
 * ```ts
 * await withJobContext('outbox-relay', () => this.runOnce());
 * ```
 *
 * When a job is processing work that originated in a request, pass the ids through
 * so the two halves join up:
 *
 * ```ts
 * await withJobContext('notification-relay', () => this.send(row), {
 *   workspaceId: row.workspaceId,
 *   correlationId: row.correlationId,
 * });
 * ```
 */
export interface JobContextSeed {
  /** Carry the originating request's correlation id when the job has one. */
  correlationId?: string;
  workspaceId?: string;
  /** The user whose action queued this work, when known. */
  userId?: string;
  /** W3C traceparent from the queued row, once Phase 3 propagates it. */
  traceparent?: string;
}

/**
 * Run `fn` inside a fresh request context tagged with the job name.
 *
 * The generated correlation id is prefixed with the job name (`outbox-relay:8f3a…`)
 * so a log search can scope to one job without a separate field, and so an id that
 * leaks into an outbound payload is self-describing.
 */
export function withJobContext<T>(
  jobName: string,
  fn: () => T | Promise<T>,
  seed: JobContextSeed = {},
): T | Promise<T> {
  const context: RequestContext = {
    workspaceId: seed.workspaceId,
    userId: seed.userId,
    sessionId: undefined,
    correlationId: seed.correlationId ?? `${jobName}:${randomUUID()}`,
    traceparent: seed.traceparent,
  };
  return requestContextStorage.run(context, fn);
}
