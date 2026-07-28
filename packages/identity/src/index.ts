/**
 * `@qnsc-vn/identity`
 *
 * Shared AUTHENTICATION mechanism for QNSC product backends: the refresh-rotation
 * auth service with family theft-detection, Entra/SSO token verification,
 * refresh-token crypto, the access-token denylist, the ES256 JWT Passport
 * strategy + auth guard, and the Backend-for-Frontend Entra OIDC login mechanism
 * (session store, OIDC client, orchestrator).
 *
 * AUTHORIZATION is deliberately absent. Permission codes, wildcard semantics and
 * scope models are product vocabulary — each product owns its own catalogue and
 * guard, and both do. See the README's "Not in scope".
 *
 * Products own their HTTP surface too: controllers, DTOs, route names and cookie
 * names. This package supplies the services those controllers call.
 */
export * from './jwt-payload';
export * from './jwt-options';
export * from './jwt.strategy';
export * from './auth-context';
export * from './jwt.guard';
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
export * from './bff-options';
export * from './bff.types';
export * from './bff.util';
export * from './entra-oidc.client';
export * from './bff-session.store';
export * from './bff.service';
// ── Multi-IdP OIDC broker (provider-agnostic; secret store via the SecretResolver
// port — concrete resolvers, e.g. AWS SSM, are supplied by the consuming app so
// this package stays store-agnostic). ─────────────────────────────────────────
export * from './oidc/connection.contract';
export * from './oidc/oidc-connection';
export * from './oidc/oidc-discovery';
export * from './oidc/oidc.client';
export * from './oidc/oidc-verifier';
export * from './oidc/connection-registry';
