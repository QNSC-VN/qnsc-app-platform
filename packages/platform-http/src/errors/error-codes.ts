/**
 * Framework-level error taxonomy shared by QNSC product backends.
 *
 * `ErrorCode` is intentionally an open `string`: each product owns its own
 * append-only catalog of machine-readable codes (surfaced in OpenAPI, branched
 * on by the frontend). This package only defines the *transport-level* codes it
 * emits itself (validation, cursor, and the HTTP-status fallbacks used by the
 * global exception filter).
 */
export type ErrorCode = string;

export type ErrorCategory =
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'VALIDATION_FAILED'
  | 'PERMISSION_DENIED'
  | 'PRECONDITION_FAILED'
  | 'RATE_LIMITED'
  | 'UNAUTHORIZED'
  | 'INTERNAL';

export const CATEGORY_HTTP_STATUS: Record<ErrorCategory, number> = {
  NOT_FOUND: 404,
  CONFLICT: 409,
  VALIDATION_FAILED: 422,
  PERMISSION_DENIED: 403,
  PRECONDITION_FAILED: 412,
  RATE_LIMITED: 429,
  UNAUTHORIZED: 401,
  INTERNAL: 500,
};

/**
 * Transport-level error codes emitted by this package (the exception filter's
 * HTTP-status fallbacks, Zod validation, and cursor decoding). Products extend
 * these with their own domain codes.
 */
export const HttpErrorCodes = {
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  RATE_LIMITED: 'RATE_LIMITED',
  INVALID_CURSOR: 'INVALID_CURSOR',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  BAD_REQUEST: 'BAD_REQUEST',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  CONFLICT: 'CONFLICT',
  PRECONDITION_FAILED: 'PRECONDITION_FAILED',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  /**
   * 503. A dependency or optional integration is unavailable — including
   * "not configured", which is the common case: both products throw
   * `ServiceUnavailableException` when an optional integration has no
   * credentials (opshub's AI assistant, rally's SCM webhook secret).
   *
   * It exists because the fallback below labelled those INTERNAL_ERROR, which
   * says "this service is broken" about a service that is working correctly and
   * merely switched off. On rally's inbound webhook that reached GitHub's
   * delivery log, making a configuration gap read as a rally fault.
   */
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
} as const;

/** Map a raw HTTP status (from a framework HttpException) to a stable error code. */
export function httpStatusToErrorCode(status: number): string {
  switch (status) {
    case 400:
      return HttpErrorCodes.BAD_REQUEST;
    case 401:
      return HttpErrorCodes.UNAUTHORIZED;
    case 403:
      return HttpErrorCodes.FORBIDDEN;
    case 404:
      return HttpErrorCodes.NOT_FOUND;
    case 405:
      return HttpErrorCodes.METHOD_NOT_ALLOWED;
    case 409:
      return HttpErrorCodes.CONFLICT;
    case 412:
      return HttpErrorCodes.PRECONDITION_FAILED;
    case 413:
      return HttpErrorCodes.PAYLOAD_TOO_LARGE;
    case 415:
      return HttpErrorCodes.UNSUPPORTED_MEDIA_TYPE;
    case 422:
      return HttpErrorCodes.VALIDATION_FAILED;
    case 429:
      return HttpErrorCodes.RATE_LIMITED;
    case 503:
      return HttpErrorCodes.SERVICE_UNAVAILABLE;
    default:
      return HttpErrorCodes.INTERNAL_ERROR;
  }
}
