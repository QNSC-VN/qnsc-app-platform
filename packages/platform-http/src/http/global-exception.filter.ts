import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ZodValidationException } from 'nestjs-zod';
import type { ZodError } from 'zod';
import { DomainException } from '../errors/exceptions';
import { HttpErrorCodes, httpStatusToErrorCode } from '../errors/error-codes';
import { REQUEST_CONTEXT, type RequestContextAccessor } from './request-context';

/**
 * Global exception filter — maps every thrown error to one stable wire envelope:
 * { error: { code, message, details, correlationId } }
 *
 * code is the FE contract — machine-readable, switches on code not message.
 * Internal error details (stack, SQL) never leak to the wire.
 */
@Catch()
@Injectable()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  constructor(@Inject(REQUEST_CONTEXT) private readonly ctx: RequestContextAccessor) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const reply = http.getResponse<FastifyReply>();
    const correlationId = this.ctx.getCorrelationId() ?? 'unknown';

    // Zod validation error → 422 + field-level details
    if (exception instanceof ZodValidationException) {
      void reply.status(422).send({
        error: {
          code: HttpErrorCodes.VALIDATION_FAILED,
          message: 'Validation failed',
          details: (exception.getZodError() as ZodError).issues,
          correlationId,
        },
      });
      return;
    }

    // Domain / application errors (typed, expected)
    if (exception instanceof DomainException) {
      // Log security-relevant failures so anomaly detection tooling can alert.
      // (OWASP REST Security Cheat Sheet — Audit logs section)
      if (
        exception.httpStatus === 401 ||
        exception.httpStatus === 403 ||
        exception.httpStatus === 429
      ) {
        this.logger.warn(
          { correlationId, code: exception.code, userId: this.ctx.getUserId() },
          `Security event [${exception.httpStatus}]: ${exception.message}`,
        );
      }
      void reply.status(exception.httpStatus).send({
        error: {
          code: exception.code,
          message: exception.message,
          details: exception.details ?? [],
          correlationId,
        },
      });
      return;
    }

    // NestJS HttpException (guards, pipes, etc.)
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const res = exception.getResponse();
      // Throttler (429) and Passport unauthorized (401) come through here.
      if (status === 401 || status === 403 || status === 429) {
        this.logger.warn(
          { correlationId, status },
          `Security event [${status}]: ${typeof res === 'string' ? res : JSON.stringify(res)}`,
        );
      }
      void reply.status(status).send({
        error: {
          code: httpStatusToErrorCode(status),
          message:
            typeof res === 'string'
              ? res
              : (((res as Record<string, unknown>)['message'] as string) ?? 'Error'),
          details: [],
          correlationId,
        },
      });
      return;
    }

    // Unhandled — log full detail server-side, return safe shape
    this.logger.error({ correlationId, err: exception }, 'Unhandled exception');
    void reply.status(500).send({
      error: {
        code: HttpErrorCodes.INTERNAL_ERROR,
        message: 'An unexpected error occurred',
        details: [],
        correlationId,
      },
    });
  }
}
