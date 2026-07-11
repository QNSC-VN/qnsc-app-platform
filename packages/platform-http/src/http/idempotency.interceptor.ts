import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  Logger,
  type NestInterceptor,
  UseInterceptors,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { type Observable, from, of } from 'rxjs';
import { switchMap, tap } from 'rxjs/operators';
import { CacheService } from '@qnsc-vn/platform-cache';

/** TTL for cached idempotent responses (24 hours). */
const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

/** Only mutating methods carry idempotency semantics. */
const IDEMPOTENCY_METHODS = new Set(['POST', 'PUT']);

/**
 * IdempotencyInterceptor
 *
 * Reads the `Idempotency-Key` header on POST/PUT requests. On the first call
 * the response is stored in Valkey; subsequent calls with the same key return
 * the cached response immediately, making the operation safe to retry.
 *
 * Cache key: `idem:{userId}:{method}:{url}:{idempotency-key}`
 *
 * Usage (opt-in per route): `@UseIdempotency()`
 * Usage (global):           register as `APP_INTERCEPTOR`.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(@Inject(CacheService) private readonly cache: CacheService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const req = context
      .switchToHttp()
      .getRequest<FastifyRequest & { user?: { id?: string; sub?: string } }>();

    if (!IDEMPOTENCY_METHODS.has(req.method)) return next.handle();

    const headerVal = req.headers['idempotency-key'];
    const idempotencyKey = Array.isArray(headerVal) ? headerVal[0] : headerVal;
    if (!idempotencyKey) return next.handle();

    const userId =
      req.user?.sub ??
      createHash('sha256')
        .update(`${req.ip ?? ''}:${req.headers['user-agent'] ?? ''}`)
        .digest('hex')
        .slice(0, 16);
    const redisKey = `idem:${userId}:${req.method}:${req.url}:${idempotencyKey}`;

    return from(this.cache.instance.get(redisKey)).pipe(
      switchMap((cached: string | null) => {
        if (cached !== null) {
          this.logger.debug({ msg: 'idempotency: cache hit', redisKey });
          return of(JSON.parse(cached) as unknown);
        }

        return next.handle().pipe(
          tap(async (response: unknown) => {
            try {
              await this.cache.instance.set(
                redisKey,
                JSON.stringify(response),
                'EX',
                IDEMPOTENCY_TTL_SECONDS,
              );
            } catch (err) {
              // Cache failure must NOT fail the request.
              this.logger.warn({ msg: 'idempotency: failed to cache response', err });
            }
          }),
        );
      }),
    );
  }
}

/** Convenience decorator — apply {@link IdempotencyInterceptor} to a single route. */
export const UseIdempotency = () => UseInterceptors(IdempotencyInterceptor);
