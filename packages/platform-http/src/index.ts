/**
 * `@qnsc/platform-http`
 *
 * Shared NestJS/Fastify HTTP contract for QNSC product backends: the error
 * taxonomy (DomainException + categories), the global exception filter that
 * renders the wire-error envelope, cursor pagination helpers, the
 * AsyncLocalStorage request-context service, and the HTTP logging &
 * idempotency interceptors.
 */
export * from './errors';
export * from './http';
