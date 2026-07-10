import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { applyDecorators, type Type } from '@nestjs/common';
import { ApiExtraModels, ApiOkResponse, getSchemaPath } from '@nestjs/swagger';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

// ── Request schema (offset pagination — simple and sufficient for bounded volumes) ──
//
// Offset pagination trades scalability for simplicity. Prefer it when:
//   - The dataset is bounded (ops/admin tables, not unbounded feeds)
//   - Clients need random page access ("jump to page N") or a total count
//   - Concurrent-insert skew is acceptable
// For large or live datasets, use the `cursorPagination` helpers instead.

export const PageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).default(0),
  sort: z.string().optional(),
});

export type PageQuery = z.infer<typeof PageQuerySchema>;

export class PageQueryDto extends createZodDto(PageQuerySchema) {}

// ── Response types ────────────────────────────────────────────────────────────

export interface PageInfo {
  total: number;
  limit: number;
  offset: number;
  hasNextPage: boolean;
}

export interface PagedResult<T> {
  data: T[];
  pageInfo: PageInfo;
}

/**
 * Build an offset-paged result from a fetched slice plus a total count.
 *
 * @param data    The rows for this page (already limited/offset in the query)
 * @param total   The total row count matching the filter (from a COUNT query)
 * @param limit   The requested page size
 * @param offset  The requested offset
 *
 * @example
 *   const [rows, total] = await repo.listAndCount({ limit, offset });
 *   return buildPageResult(rows.map(toDto), total, limit, offset);
 */
export function buildPageResult<T>(
  data: T[],
  total: number,
  limit: number,
  offset: number,
): PagedResult<T> {
  return {
    data,
    pageInfo: { total, limit, offset, hasNextPage: offset + data.length < total },
  };
}

// ── Swagger helper for paginated responses ────────────────────────────────────
//
// Usage in controllers:
//   @ApiPagedResponse(AssetResponseDto)
//   async list(...): Promise<PagedResult<AssetResponseDto>> { ... }

export const ApiPagedResponse = <T>(model: Type<T>) =>
  applyDecorators(
    ApiExtraModels(model),
    ApiOkResponse({
      description: 'Paginated list',
      schema: {
        properties: {
          data: { type: 'array', items: { $ref: getSchemaPath(model) } },
          pageInfo: {
            type: 'object',
            required: ['total', 'limit', 'offset', 'hasNextPage'],
            properties: {
              total: { type: 'number' },
              limit: { type: 'number' },
              offset: { type: 'number' },
              hasNextPage: { type: 'boolean' },
            },
          },
        },
      },
    }),
  );
