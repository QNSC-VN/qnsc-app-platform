import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { applyDecorators, type Type } from '@nestjs/common';
import { ApiExtraModels, ApiOkResponse, getSchemaPath } from '@nestjs/swagger';
import { HttpErrorCodes } from '../errors/error-codes';
import { PreconditionFailedException } from '../errors/exceptions';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

// ── Cursor internal shape (base64url-encoded opaque token) ────────────────────

const CursorPayloadSchema = z.object({
  v: z.literal(1),
  k: z.array(z.unknown()),
  id: z.string().uuid(),
  d: z.enum(['asc', 'desc']),
});

type CursorPayload = z.infer<typeof CursorPayloadSchema>;

export type { CursorPayload };

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export function decodeCursor(cursor: string): CursorPayload {
  try {
    const raw: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    return CursorPayloadSchema.parse(raw);
  } catch {
    throw new PreconditionFailedException(
      HttpErrorCodes.INVALID_CURSOR,
      'Invalid or tampered cursor',
    );
  }
}

// ── Request schema ────────────────────────────────────────────────────────────

export const PageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  cursor: z.string().optional(),
  sort: z.string().optional(),
});

export type PageQuery = z.infer<typeof PageQuerySchema>;

// ── Response types ────────────────────────────────────────────────────────────

export interface PageInfo {
  nextCursor: string | null;
  hasNextPage: boolean;
  limit: number;
}

export interface PagedResult<T> {
  data: T[];
  pageInfo: PageInfo;
}

/**
 * Build paged result.
 * Fetches limit + 1 items; presence of the extra item signals hasNextPage.
 */
export function buildPageResult<T extends { id: string }>(
  /** items fetched with limit + 1 */
  rawItems: T[],
  limit: number,
  buildCursorKey: (item: T) => unknown[],
  direction: 'asc' | 'desc' = 'asc',
): PagedResult<T> {
  const hasNextPage = rawItems.length > limit;
  const data = hasNextPage ? rawItems.slice(0, limit) : rawItems;
  const last = data.at(-1);

  const nextCursor =
    hasNextPage && last
      ? encodeCursor({ v: 1, k: buildCursorKey(last), id: last.id, d: direction })
      : null;

  return { data, pageInfo: { nextCursor, hasNextPage, limit } };
}

/**
 * Decode a raw PageQuery into { limit, cursor } for use in repository queries.
 * Returns null cursor when the query has no cursor (first page).
 */
export function buildPageArgs(query: PageQuery): {
  limit: number;
  cursor: CursorPayload | null;
} {
  const limit = query.limit ?? DEFAULT_LIMIT;
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  return { limit, cursor };
}

// ── DTO class for NestJS controllers ──────────────────────────────────────────

export class PageQueryDto extends createZodDto(PageQuerySchema) {}

// ── Swagger helper for paginated responses ────────────────────────────────────
//
// Usage in controllers:
//   @ApiPagedResponse(WorkItemResponseDto)
//   async listWorkItems(...): Promise<PagedResult<WorkItemResponseDto>> { ... }

export const ApiPagedResponse = <T>(model: Type<T>) =>
  applyDecorators(
    ApiExtraModels(model),
    ApiOkResponse({
      description: 'Paginated list',
      schema: {
        properties: {
          data: {
            type: 'array',
            items: { $ref: getSchemaPath(model) },
          },
          pageInfo: {
            type: 'object',
            required: ['nextCursor', 'hasNextPage', 'limit'],
            properties: {
              nextCursor: {
                type: 'string',
                nullable: true,
                description: 'Opaque cursor token for the next page',
              },
              hasNextPage: { type: 'boolean' },
              limit: { type: 'number', description: 'Number of items returned per page' },
            },
          },
        },
      },
    }),
  );
