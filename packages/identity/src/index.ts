/**
 * `@qnsc/identity`
 *
 * Shared identity/auth primitives for QNSC product backends: the ES256 JWT
 * Passport strategy, the JWT auth guard (with Valkey denylist checks), the
 * wildcard-aware permission guard, the auth decorators, Entra/SSO token
 * verification, and refresh-token crypto. The full refresh-rotation auth
 * service and the BFF session handlers follow in later phases.
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
export * from './entra-verifier';
export * from './refresh-token';
export * from './domain-types';
export * from './repository-ports';
