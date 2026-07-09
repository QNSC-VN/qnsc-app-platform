import { CATEGORY_HTTP_STATUS, type ErrorCategory, type ErrorCode } from './error-codes';

/**
 * Base exception for all domain/application errors.
 * The global exception filter maps this to the wire envelope.
 * Domain functions return Result<T,E>; they throw DomainException only at
 * use-case boundaries after losing the ability to continue.
 */
export class DomainException extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details?: unknown[];

  constructor(code: ErrorCode, message: string, category: ErrorCategory, details?: unknown[]) {
    super(message);
    this.name = 'DomainException';
    this.code = code;
    this.httpStatus = CATEGORY_HTTP_STATUS[category];
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class NotFoundException extends DomainException {
  constructor(code: ErrorCode, message: string) {
    super(code, message, 'NOT_FOUND');
  }
}

export class ConflictException extends DomainException {
  constructor(code: ErrorCode, message: string) {
    super(code, message, 'CONFLICT');
  }
}

export class PermissionDeniedException extends DomainException {
  constructor(codeOrMessage: string = 'PERMISSION_DENIED', message?: string) {
    // Support both: new PermissionDeniedException('PROJECT_PERMISSION_DENIED', 'msg')
    // and legacy: new PermissionDeniedException('msg')
    const isCode = message !== undefined;
    super(
      isCode ? (codeOrMessage as ErrorCode) : 'PERMISSION_DENIED',
      isCode ? message : codeOrMessage,
      'PERMISSION_DENIED',
    );
  }
}

export class UnauthorizedException extends DomainException {
  constructor(code: ErrorCode, message: string) {
    super(code, message, 'UNAUTHORIZED');
  }
}

export class PreconditionFailedException extends DomainException {
  constructor(code: ErrorCode, message: string) {
    super(code, message, 'PRECONDITION_FAILED');
  }
}

export class RateLimitedException extends DomainException {
  constructor(message = 'Rate limit exceeded') {
    super('RATE_LIMITED', message, 'RATE_LIMITED');
  }
}
