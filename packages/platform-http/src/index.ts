/**
 * `@qnsc/platform-http`
 *
 * Shared NestJS/Fastify HTTP contract for QNSC product backends: the error
 * taxonomy (DomainException + categories), the global exception filter that
 * renders the wire-error envelope, and cursor pagination helpers.
 */
export * from './errors';
export * from './http';
