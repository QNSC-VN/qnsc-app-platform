import { requestCorrelationId, validCorrelationId } from './correlation';
import { AUTH_HANDLER_THREW, consoleLogger, errorFields, type IdentityLogger } from './events';

/**
 * The platform error envelope (contract section 7) ADDED to what Better Auth's handler answers.
 *
 * `/api/auth/*` follows Better Auth's wire protocol: `better-auth/client`, which the product
 * frontends use, reads the top-level `code` and `message` of an error body and the HTTP status. So
 * the body is not replaced; the envelope is added next to it. Every response with status 400 or
 * above becomes
 *
 * ```json
 * { "code": "…", "message": "…", ...whatever else Better Auth sent,
 *   "error": { "code": "…", "message": "…", "details": [], "correlationId": "…" } }
 * ```
 *
 * - **The status is Better Auth's, always** (a 400 stays 400). `AuthApiErrorFilter`, which maps an
 *   error raised through `auth.api` in a product's own controller, turns an unrecognised 4xx into
 *   422; that difference is intentional, the two paths speak different protocols.
 * - **4xx:** the top-level fields are Better Auth's own, untouched (`code` and `message` are added
 *   only if it sent none, from the status). `error.code` is the same machine code
 *   (`INVALID_EMAIL_OR_PASSWORD`, `ACCOUNT_LOCKED`, …) and `error.message` the same user-facing
 *   message; Better Auth's request-body validation (`VALIDATION_ERROR`) is `error.code:
 *   VALIDATION_FAILED` with the issues in `details`. A body that already has an `error` key
 *   (an OAuth-style `{ error, error_description }`) is left exactly as it is: it cannot be extended
 *   without changing the protocol.
 * - **5xx:** `code` and `error.code` are `INTERNAL_ERROR` and the message is the fixed
 *   "An unexpected error occurred", at the top level too. Nothing Better Auth said about the failure
 *   is on the wire (contract: internal detail MUST NOT reach it); it is in the log. Never a null
 *   body. (`503` is `SERVICE_UNAVAILABLE`, as the contract requires.)
 * - `correlationId` is the request's, `unknown` when none was seeded. Redirects (the OAuth and SSO
 *   callbacks, which carry `?error=`), successes and all headers are untouched.
 */
const STATUS_CODES: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  409: 'CONFLICT',
  412: 'PRECONDITION_FAILED',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'VALIDATION_FAILED',
  429: 'RATE_LIMITED',
  503: 'SERVICE_UNAVAILABLE',
};

const MACHINE_CODE = /^[A-Za-z0-9_:.-]{1,64}$/;
const MAX_MESSAGE = 300;

/** `[body.email] Invalid email address; [body.password] …` -> one issue per entry. */
function validationIssues(message: string): Array<{ path: string; message: string }> {
  return message
    .split(/;\s*(?=\[)/)
    .map((part) => /^\[([^\]]+)\]\s*(.*)$/.exec(part.trim()))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ path: m[1]!, message: m[2]! }));
}

type Body = Record<string, unknown>;

function isMachineCode(value: unknown): value is string {
  return typeof value === 'string' && MACHINE_CODE.test(value);
}

/** The body to answer, or `undefined` to leave the response as Better Auth made it. */
export function hybridErrorBody(status: number, original: string): Body | undefined {
  const correlationId = validCorrelationId(requestCorrelationId()) ?? 'unknown';
  const wrap = (code: string, message: string, details: unknown[] = []) => ({
    code,
    message,
    details,
    correlationId,
  });
  if (status >= 500) {
    const unavailable = status === 503;
    const code = unavailable ? 'SERVICE_UNAVAILABLE' : 'INTERNAL_ERROR';
    const message = unavailable
      ? 'The service is temporarily unavailable'
      : 'An unexpected error occurred';
    return { code, message, error: wrap(code, message) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(original);
  } catch {
    parsed = undefined;
  }
  const ba: Body =
    parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Body) : {};
  if ('error' in ba) return undefined;
  const fallback = STATUS_CODES[status] ?? 'BAD_REQUEST';
  const topCode = typeof ba['code'] === 'string' ? ba['code'] : undefined;
  const topMessage = typeof ba['message'] === 'string' && ba['message'] ? ba['message'] : undefined;
  const code = topCode ?? fallback;
  const message = topMessage ?? 'The request could not be completed';
  const envelopeCode = isMachineCode(topCode) ? topCode : fallback;
  const envelope =
    envelopeCode === 'VALIDATION_ERROR'
      ? wrap('VALIDATION_FAILED', 'Validation failed', validationIssues(message))
      : wrap(envelopeCode, message.slice(0, MAX_MESSAGE));
  return { ...ba, code, message, error: envelope };
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
    if (response.status < 400) return response;
    const original =
      response.status >= 500
        ? ''
        : await response
            .clone()
            .text()
            .catch(() => '');
    const body = hybridErrorBody(response.status, original);
    if (!body) return response;
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    headers.set('content-type', 'application/json; charset=utf-8');
    return new Response(JSON.stringify(body), { status: response.status, headers });
  };
}
