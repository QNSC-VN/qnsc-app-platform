/**
 * Per-request context the {@link GlobalExceptionFilter} needs to enrich the
 * error envelope. Each product provides an adapter over its own request-context
 * mechanism (e.g. AsyncLocalStorage), so this package stays free of any
 * particular context implementation.
 */
export interface RequestContextAccessor {
  getCorrelationId(): string | undefined;
  getUserId(): string | undefined;
}

/** DI token for the {@link RequestContextAccessor}. */
export const REQUEST_CONTEXT = Symbol('REQUEST_CONTEXT');
