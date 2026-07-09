import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  Logger,
  type NestInterceptor,
  Optional,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

/**
 * Options for {@link HttpLoggingInterceptor}. Supplied by the product so the
 * package stays free of any particular config service.
 */
export interface HttpLoggingOptions {
  /** Include the (redacted) request body for POST/PUT/PATCH. Default `false`. */
  logBodies?: boolean;
  /** Exact paths whose access logs are suppressed. Default: health probes + favicon. */
  skipPaths?: readonly string[];
}

/** DI token for {@link HttpLoggingOptions}. */
export const HTTP_LOGGING_OPTIONS = Symbol('HTTP_LOGGING_OPTIONS');

/** Routes whose access logs are suppressed by default (probes + favicon spam). */
const DEFAULT_SKIP_PATHS = ['/v1/healthz', '/v1/readyz', '/favicon.ico'] as const;

/** Body fields that must never appear in logs. */
const REDACTED_BODY_FIELDS = new Set([
  'password',
  'confirmPassword',
  'currentPassword',
  'newPassword',
  'token',
  'refreshToken',
  'secret',
  'privateKey',
  'creditCard',
]);

const MAX_COLLECTION_ITEMS = 20;
const MAX_STRING_LENGTH = 256;

function isSensitiveKey(key: string): boolean {
  return (
    REDACTED_BODY_FIELDS.has(key) || /(token|secret|password|cookie|authorization|key)$/i.test(key)
  );
}

function sanitizeValue(value: unknown, key?: string): unknown {
  if (key && isSensitiveKey(key)) return '[REDACTED]';

  if (Array.isArray(value)) {
    return value.slice(0, MAX_COLLECTION_ITEMS).map((item) => sanitizeValue(item));
  }

  if (value && typeof value === 'object') {
    const sanitized: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      sanitized[childKey] = sanitizeValue(childValue, childKey);
    }
    return sanitized;
  }

  if (typeof value === 'string' && value.length > MAX_STRING_LENGTH) {
    return `${value.slice(0, MAX_STRING_LENGTH)}...[truncated]`;
  }

  return value;
}

/**
 * HttpLoggingInterceptor
 *
 * Emits ONE structured log per request on completion:
 *   `<-- POST /v1/auth/login 200 45ms userId=xxx correlationId=xxx`
 *
 * Logs at WARN for 4xx, ERROR for 5xx, LOG for the rest. Body is included for
 * POST/PUT/PATCH (with sensitive fields redacted) when `logBodies` is enabled.
 * Disable pino-http `autoLogging` when this interceptor is active.
 */
@Injectable()
export class HttpLoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');
  private readonly logBodies: boolean;
  private readonly skipPaths: Set<string>;

  constructor(@Optional() @Inject(HTTP_LOGGING_OPTIONS) options?: HttpLoggingOptions) {
    this.logBodies = options?.logBodies ?? false;
    this.skipPaths = new Set(options?.skipPaths ?? DEFAULT_SKIP_PATHS);
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const req = context.switchToHttp().getRequest<FastifyRequest & { user?: { id?: string } }>();
    const method = req.method;
    const url =
      ((req as unknown as Record<string, unknown>)['originalUrl'] as string | undefined) ?? req.url;

    if (this.skipPaths.has(url)) {
      return next.handle();
    }

    const startTime = Date.now();
    const correlationId = req.headers['x-correlation-id'] as string | undefined;
    const ip =
      (req.headers['x-real-ip'] as string) ||
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      req.ip ||
      'unknown';

    return next.handle().pipe(
      tap({
        next: () => {
          const statusCode = context
            .switchToHttp()
            .getResponse<{ statusCode: number }>().statusCode;
          const duration = Date.now() - startTime;
          const userId = req.user?.id;

          this.log(statusCode, {
            msg: `<-- ${method} ${url} ${statusCode} ${duration}ms`,
            method,
            url,
            statusCode,
            duration,
            userId,
            correlationId,
            ip,
            query: this.extractQuery(req),
          });
        },
        error: (err: unknown) => {
          const duration = Date.now() - startTime;
          const statusCode = (err as { getStatus?: () => number }).getStatus?.() ?? 500;
          const errorCode =
            (err as { getResponse?: () => { code?: string } }).getResponse?.()?.code ?? 'INTERNAL';
          const userId = req.user?.id;

          this.log(statusCode, {
            msg: `<-- ${method} ${url} ${statusCode} ${duration}ms [${errorCode}]`,
            method,
            url,
            statusCode,
            duration,
            errorCode,
            userId,
            correlationId,
            ip,
            query: this.extractQuery(req),
            body: this.extractBody(req),
          });
        },
      }),
    );
  }

  private log(statusCode: number, fields: Record<string, unknown>): void {
    if (statusCode >= 500) {
      this.logger.error(fields);
    } else if (statusCode >= 400) {
      this.logger.warn(fields);
    } else {
      this.logger.log(fields);
    }
  }

  private extractQuery(req: FastifyRequest): Record<string, unknown> | undefined {
    const q = req.query as Record<string, unknown> | undefined;
    if (!q || Object.keys(q).length === 0) return undefined;
    return sanitizeValue(q) as Record<string, unknown>;
  }

  private extractBody(req: FastifyRequest): Record<string, unknown> | undefined {
    if (!this.logBodies) return undefined;
    if (!['POST', 'PUT', 'PATCH'].includes(req.method)) return undefined;
    const body = req.body as Record<string, unknown> | undefined;
    if (!body || typeof body !== 'object') return undefined;
    return sanitizeValue(body) as Record<string, unknown>;
  }
}
