/**
 * `@qnsc-vn/platform-http`
 *
 * Shared NestJS/Fastify HTTP contract for QNSC product backends: the error
 * taxonomy (DomainException + categories), the global exception filter that
 * renders the wire-error envelope, cursor & offset pagination helpers, the
 * AsyncLocalStorage request-context service, the HTTP logging & idempotency
 * interceptors, and the Valkey-backed rate-limit guard + tiers.
 */
export * from './errors';
export * from './http';

// Pagination ships two strategies under distinct namespaces so both can be reused
// without export collisions (they share names like `buildPageResult`/`PagedResult`):
//   import { cursorPagination, offsetPagination } from '@qnsc-vn/platform-http';
// Cursor suits large/live feeds; offset suits bounded tables needing a total count.
export * as cursorPagination from './http/pagination/cursor';
export * as offsetPagination from './http/pagination/offset';
