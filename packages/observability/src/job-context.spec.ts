import { describe, expect, it } from 'vitest';
import { requestContextStorage } from './request-context';
import { withJobContext } from './job-context';

/**
 * Background work used to run with an empty AsyncLocalStorage, so cron jobs, outbox
 * relays and queue consumers logged with no `correlationId` and no `workspaceId` —
 * you could not follow one business action from the request that queued it into the
 * worker that finished it.
 */
describe('withJobContext', () => {
  it('provides a context where there was none', async () => {
    expect(requestContextStorage.getStore()).toBeUndefined();

    await withJobContext('outbox-relay', () => {
      expect(requestContextStorage.getStore()).toBeDefined();
    });
  });

  it('prefixes the generated correlation id with the job name', async () => {
    // Self-describing: an id that surfaces in a log search or an outbound payload
    // says which job produced it, with no extra field to join on.
    await withJobContext('daily-cleanup', () => {
      expect(requestContextStorage.getStore()?.correlationId).toMatch(/^daily-cleanup:[0-9a-f-]{36}$/);
    });
  });

  it('generates a distinct id per run', async () => {
    const ids: string[] = [];
    const capture = () => void ids.push(requestContextStorage.getStore()!.correlationId);
    await withJobContext('job', capture);
    await withJobContext('job', capture);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('carries the originating request context when the job has one', async () => {
    // This is what joins the two halves of an async flow: the relay processes a row
    // that remembers which request queued it.
    await withJobContext('notification-relay', () => {
      const context = requestContextStorage.getStore();
      expect(context).toMatchObject({
        correlationId: 'corr-from-request',
        workspaceId: 'ws-1',
        userId: 'user-1',
        traceparent: '00-abc-def-01',
      });
    }, {
      correlationId: 'corr-from-request',
      workspaceId: 'ws-1',
      userId: 'user-1',
      traceparent: '00-abc-def-01',
    });
  });

  it('keeps the context across await boundaries', async () => {
    // AsyncLocalStorage's whole value: nested service calls inherit it without
    // anything being threaded through the call signature.
    await withJobContext('job', async () => {
      const before = requestContextStorage.getStore()?.correlationId;
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(requestContextStorage.getStore()?.correlationId).toBe(before);
    });
  });

  it('returns the callback result', async () => {
    await expect(withJobContext('job', () => Promise.resolve(42))).resolves.toBe(42);
  });

  it('propagates a rejection rather than swallowing it', async () => {
    await expect(
      withJobContext('job', () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
  });

  it('does not leak the context after the job finishes', async () => {
    await withJobContext('job', () => undefined);
    expect(requestContextStorage.getStore()).toBeUndefined();
  });

  it('leaves session id unset — jobs have no session', async () => {
    await withJobContext('job', () => {
      expect(requestContextStorage.getStore()?.sessionId).toBeUndefined();
    });
  });
});
