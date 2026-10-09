import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  Inject,
  Injectable,
} from '@nestjs/common';
import { APIError } from 'better-auth/api';
import {
  ConflictException,
  DomainException,
  GlobalExceptionFilter,
  NotFoundException,
  PermissionDeniedException,
  RateLimitedException,
  REQUEST_CONTEXT,
  type RequestContextAccessor,
  UnauthorizedException,
} from '@quynhonsemiconductor/platform-http';

/**
 * Better Auth `APIError` -> `platform-http` `DomainException`, keeping Better Auth's machine code
 * (`ACCOUNT_LOCKED`, `EMAIL_NOT_VERIFIED`, …) as the wire code so frontends branch on it.
 * Used for errors thrown by `auth.api.*` calls inside a product's own controllers; requests that go
 * through the mounted handler keep Better Auth's own response.
 */
export function toDomainException(error: APIError): DomainException {
  const body = (error.body ?? {}) as { code?: string; message?: string };
  const code = body.code ?? 'AUTH_ERROR';
  const message = body.message ?? error.message;
  switch (Number(error.statusCode)) {
    case 401:
      return new UnauthorizedException(code, message);
    case 403:
      return new PermissionDeniedException(code, message);
    case 404:
      return new NotFoundException(code, message);
    case 409:
      return new ConflictException(code, message);
    case 429:
      return new RateLimitedException(message);
    default:
      return new DomainException(
        code,
        message,
        Number(error.statusCode) >= 500 ? 'INTERNAL' : 'VALIDATION_FAILED',
      );
  }
}

@Catch(APIError)
@Injectable()
export class AuthApiErrorFilter implements ExceptionFilter {
  private readonly inner: GlobalExceptionFilter;

  constructor(@Inject(REQUEST_CONTEXT) ctx: RequestContextAccessor) {
    this.inner = new GlobalExceptionFilter(ctx);
  }

  catch(error: APIError, host: ArgumentsHost): void {
    this.inner.catch(toDomainException(error), host);
  }
}
