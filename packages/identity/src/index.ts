/**
 * `@qnsc-vn/identity`
 *
 * Shared identity/auth primitives for QNSC product backends: the ES256 JWT
 * Passport strategy, the JWT auth guard (with Valkey denylist checks), the
 * wildcard-aware permission guard, the auth decorators, Entra/SSO token
 * verification, and refresh-token crypto, the refresh-rotation auth service,
 * the cookie-based auth HTTP controller, and the Backend-for-Frontend (BFF)
 * Entra OIDC login mechanism (session store, OIDC client, orchestrator, and
 * the opt-in `BffModule`).
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
export * from './service-ports';
export * from './claims-provider';
export * from './sso-provisioning-hook';
export * from './transaction-runner';
export * from './auth-options';
export * from './access-token';
export * from './auth.service';
export * from './auth-token-cache.service';
export * from './auth.dto';
export * from './auth.controller';
export * from './auth.module';
export * from './bff-options';
export * from './bff.types';
export * from './bff.util';
export * from './entra-oidc.client';
export * from './bff-session.store';
export * from './bff.service';
export * from './bff.module';
// ── Multi-IdP OIDC broker (provider-agnostic; secret store via the SecretResolver
// port — concrete resolvers, e.g. AWS SSM, are supplied by the consuming app so
// this package stays store-agnostic). ─────────────────────────────────────────
export * from './oidc/connection.contract';
export * from './oidc/oidc-connection';
export * from './oidc/oidc-discovery';
export * from './oidc/oidc.client';
export * from './oidc/oidc-verifier';
export * from './oidc/connection-registry';
