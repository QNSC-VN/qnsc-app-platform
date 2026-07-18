import 'reflect-metadata';
import { HttpException } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { ZodValidationException } from 'nestjs-zod';
import { describe, expect, it } from 'vitest';
import { HttpErrorCodes, httpStatusToErrorCode } from './errors/error-codes';
import {
  ConflictException,
  DomainException,
  NotFoundException,
  PermissionDeniedException,
  PreconditionFailedException,
  RateLimitedException,
  UnauthorizedException,
} from './errors/exceptions';
import { GlobalExceptionFilter } from './http/global-exception.filter';
import type { RequestContextAccessor } from './http/request-context';
import {
  buildPageArgs,
  buildPageResult,
  decodeCursor,
  encodeCursor,
  PageQuerySchema,
  type CursorPayload,
} from './http/pagination/cursor';

describe('error taxonomy', () => {
  it('maps HTTP statuses to stable codes with an INTERNAL fallback', () => {
    expect(httpStatusToErrorCode(404)).toBe(HttpErrorCodes.NOT_FOUND);
    expect(httpStatusToErrorCode(412)).toBe(HttpErrorCodes.PRECONDITION_FAILED);
    expect(httpStatusToErrorCode(429)).toBe(HttpErrorCodes.RATE_LIMITED);
    expect(httpStatusToErrorCode(418)).toBe(HttpErrorCodes.INTERNAL_ERROR);
  });

  it('derives httpStatus from the category', () => {
    expect(new DomainException('X', 'x', 'CONFLICT').httpStatus).toBe(409);
    expect(new NotFoundException('A_NOT_FOUND', 'nope').httpStatus).toBe(404);
    expect(new ConflictException('A_TAKEN', 'dup').httpStatus).toBe(409);
    expect(new UnauthorizedException('AUTH_X', 'no').httpStatus).toBe(401);
    expect(new PreconditionFailedException('PRE_X', 'stale').httpStatus).toBe(412);
    expect(new RateLimitedException().httpStatus).toBe(429);
  });

  it('supports both PermissionDeniedException overloads', () => {
    const withCode = new PermissionDeniedException('PROJECT_PERMISSION_DENIED', 'denied');
    expect(withCode.code).toBe('PROJECT_PERMISSION_DENIED');
    expect(withCode.httpStatus).toBe(403);

    const legacy = new PermissionDeniedException('denied');
    expect(legacy.code).toBe('PERMISSION_DENIED');
    expect(legacy.message).toBe('denied');
  });
});

describe('cursor pagination', () => {
  const cursor: CursorPayload = {
    v: 1,
    k: ['2024-01-01'],
    id: '123e4567-e89b-12d3-a456-426614174000',
    d: 'asc',
  };

  it('round-trips a cursor', () => {
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('rejects a tampered cursor', () => {
    expect(() => decodeCursor('not-a-real-cursor')).toThrow(PreconditionFailedException);
    try {
      decodeCursor('not-a-real-cursor');
    } catch (err) {
      expect((err as PreconditionFailedException).code).toBe(HttpErrorCodes.INVALID_CURSOR);
    }
  });

  it('signals hasNextPage from the limit+1 sentinel', () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const result = buildPageResult(items, 2, (i) => [i.id]);
    expect(result.data).toHaveLength(2);
    expect(result.pageInfo.hasNextPage).toBe(true);
    expect(result.pageInfo.nextCursor).not.toBeNull();
  });

  it('has no next page when items fit the limit', () => {
    const result = buildPageResult([{ id: 'a' }], 2, (i) => [i.id]);
    expect(result.pageInfo.hasNextPage).toBe(false);
    expect(result.pageInfo.nextCursor).toBeNull();
  });

  it('buildPageArgs decodes the cursor only when present', () => {
    expect(buildPageArgs({ limit: 10 }).cursor).toBeNull();
    const withCursor = buildPageArgs({ limit: 10, cursor: encodeCursor(cursor) });
    expect(withCursor.cursor).toEqual(cursor);
  });
});

describe('GlobalExceptionFilter', () => {
  const ctx: RequestContextAccessor = {
    getCorrelationId: () => 'cid-1',
    getUserId: () => 'user-1',
  };

  function run(exception: unknown): { status?: number; body?: { error: Record<string, unknown> } } {
    const captured: { status?: number; body?: { error: Record<string, unknown> } } = {};
    const reply = {
      status(code: number) {
        captured.status = code;
        return {
          send(body: { error: Record<string, unknown> }) {
            captured.body = body;
          },
        };
      },
    };
    const host = {
      switchToHttp: () => ({ getResponse: () => reply, getRequest: () => ({}) }),
    } as unknown as ArgumentsHost;

    new GlobalExceptionFilter(ctx).catch(exception, host);
    return captured;
  }

  it('renders a DomainException with its code, status and correlationId', () => {
    const out = run(new NotFoundException('USER_NOT_FOUND', 'missing'));
    expect(out.status).toBe(404);
    expect(out.body?.error.code).toBe('USER_NOT_FOUND');
    expect(out.body?.error.correlationId).toBe('cid-1');
  });

  it('renders a Zod validation error as 422 with field details', () => {
    const parsed = PageQuerySchema.safeParse({ limit: 9999 });
    expect(parsed.success).toBe(false);
    const out = run(new ZodValidationException(parsed.success ? undefined! : parsed.error));
    expect(out.status).toBe(422);
    expect(out.body?.error.code).toBe(HttpErrorCodes.VALIDATION_FAILED);
    expect(Array.isArray(out.body?.error.details)).toBe(true);
  });

  it('maps a framework HttpException status to a stable code', () => {
    const out = run(new HttpException('nope', 401));
    expect(out.status).toBe(401);
    expect(out.body?.error.code).toBe(HttpErrorCodes.UNAUTHORIZED);
  });

  it('renders an unknown error as a safe 500', () => {
    const out = run(new Error('boom'));
    expect(out.status).toBe(500);
    expect(out.body?.error.code).toBe(HttpErrorCodes.INTERNAL_ERROR);
    expect(out.body?.error.message).toBe('An unexpected error occurred');
  });
});
