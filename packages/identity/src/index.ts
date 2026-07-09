/**
 * `@qnsc/identity`
 *
 * Shared identity/auth primitives for QNSC product backends: the ES256 JWT
 * Passport strategy, the JWT auth guard (with Valkey denylist checks), the
 * wildcard-aware permission guard, and the auth decorators. Refresh rotation,
 * SSO/Entra and the BFF session handlers follow in later phases.
 */
export * from './jwt-payload';
export * from './jwt-options';
export * from './jwt.strategy';
export * from './auth-context';
export * from './jwt.guard';
export * from './permissions';
export * from './permission.guard';
export * from './metadata';
export * from './decorators';
