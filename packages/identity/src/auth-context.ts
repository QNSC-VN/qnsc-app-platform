/**
 * Writes the verified auth identity into the product's per-request context
 * (e.g. AsyncLocalStorage) so downstream tenant/user scoping works. Each product
 * provides an adapter; {@link JwtAuthGuard} calls it after a token verifies.
 */
export interface AuthContextSetter {
  setAuthContext(contextId: string | null, userId: string, sessionId: string): void;
}

/** DI token for the {@link AuthContextSetter}. */
export const AUTH_CONTEXT = Symbol('AUTH_CONTEXT');
