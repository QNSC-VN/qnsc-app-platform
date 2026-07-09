import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable } from '@nestjs/common';

/** Request-scoped context carried through the async call graph. */
export interface RequestContext {
  workspaceId: string | undefined;
  userId: string | undefined;
  sessionId: string | undefined;
  correlationId: string;
  /** W3C `traceparent` from the inbound request, if present. */
  traceparent: string | undefined;
}

/**
 * Exported so a logger mixin can read the request context without going through
 * DI. Do NOT write to this directly — use {@link RequestContextService}.
 */
export const requestContextStorage = new AsyncLocalStorage<RequestContext>();

/**
 * AsyncLocalStorage-backed request context.
 *
 * A product wires this once and can bind it to the {@link RequestContextAccessor}
 * (`REQUEST_CONTEXT`) and `AuthContextSetter` tokens consumed elsewhere in the
 * platform, since it structurally satisfies both.
 */
@Injectable()
export class RequestContextService {
  run<T>(context: RequestContext, fn: () => T): T {
    return requestContextStorage.run(context, fn);
  }

  get(): RequestContext | undefined {
    return requestContextStorage.getStore();
  }

  getOrThrow(): RequestContext {
    const ctx = requestContextStorage.getStore();
    if (!ctx) throw new Error('No request context in AsyncLocalStorage');
    return ctx;
  }

  getWorkspaceId(): string | undefined {
    return requestContextStorage.getStore()?.workspaceId;
  }

  getUserId(): string | undefined {
    return requestContextStorage.getStore()?.userId;
  }

  getCorrelationId(): string | undefined {
    return requestContextStorage.getStore()?.correlationId;
  }

  /** Populate workspace/user/session once resolved from the JWT in the auth guard. */
  setAuthContext(workspaceId: string | undefined, userId: string, sessionId: string): void {
    const ctx = requestContextStorage.getStore();
    if (ctx) {
      ctx.workspaceId = workspaceId;
      ctx.userId = userId;
      ctx.sessionId = sessionId;
    }
  }
}
