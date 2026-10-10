import { requestCorrelationId, validCorrelationId } from './correlation';
import { AUTH_HANDLER_THREW, consoleLogger, errorFields, type IdentityLogger } from './events';

/**
 * The platform error envelope (contract §7) ADDED to a **5xx** from Better Auth's own handler.
 *
 * Better Auth answers an unhandled exception, a failed `COMMIT` for one, with a bare 500 and no body
 * at all. `/api/auth/*` follows Better Auth's wire protocol (`better-auth/client` reads the top-level
 * `code` and `message`), so the body is not replaced by the envelope; the envelope is added next to
 * the fields that protocol reads:
 *
 * ```json
 * { "code": "INTERNAL_ERROR", "message": "An unexpected error occurred",
 *   "error": { "code": "INTERNAL_ERROR", "message": "An unexpected error occurred",
 *              "details": [], "correlationId": "…" } }
 * ```
 *
 * Never a bare envelope and never an empty body. `503` is `SERVICE_UNAVAILABLE` (a dependency is
 * not available), everything else `INTERNAL_ERROR`. The detail is not on the wire (contract:
 * internal detail MUST NOT reach it); it is in the log. `correlationId` is the request's, `unknown`
 * when none was seeded.
 */
export function internalErrorBody(status: number): string {
  const unavailable = status === 503;
  const code = unavailable ? 'SERVICE_UNAVAILABLE' : 'INTERNAL_ERROR';
  const message = unavailable
    ? 'The service is temporarily unavailable'
    : 'An unexpected error occurred';
  return JSON.stringify({
    code,
    message,
    error: {
      code,
      message,
      details: [],
      correlationId: validCorrelationId(requestCorrelationId()) ?? 'unknown',
    },
  });
}

export function withErrorEnvelope(
  handler: (request: Request) => Promise<Response>,
  logger: IdentityLogger = consoleLogger,
): (request: Request) => Promise<Response> {
  return async (request) => {
    let response: Response;
    try {
      response = await handler(request);
    } catch (error) {
      // Better Auth's router answers its own errors; a throw that gets this far is a bug somewhere
      // around it. Say so (class and code, never the message) before answering, not after.
      logger.error(`${AUTH_HANDLER_THREW}: the authentication handler threw`, {
        code: AUTH_HANDLER_THREW,
        ...errorFields(error),
      });
      response = new Response(null, { status: 500 });
    }
    if (response.status < 500) return response;
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    headers.set('content-type', 'application/json; charset=utf-8');
    return new Response(internalErrorBody(response.status), { status: response.status, headers });
  };
}
