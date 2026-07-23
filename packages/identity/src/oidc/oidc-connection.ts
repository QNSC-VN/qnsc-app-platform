import type { SsoConnection } from '../domain-types';

/**
 * Everything the generic OIDC client + verifier need for ONE resolved
 * connection. Endpoints come from discovery; `clientSecret` from the
 * SecretResolver; `redirectUri` is the single app-level callback (not per-row).
 */
export interface ResolvedConnection {
  id: string;
  kind: 'directory' | 'shared';
  provider: string;
  // ── Provisioning fields (mirror the row) so this doubles as the provisioning
  // contract on the callback — no second lookup needed. ───────────────────────
  workspaceId: string;
  defaultRoleSlug: string;
  allowedEmailDomains: string[];
  jitEnabled: boolean;
  // ── OIDC fields ─────────────────────────────────────────────────────────────
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string;
  /** Canonical issuer (from discovery). */
  issuer: string;
  /** All accepted issuers for verification (e.g. Entra v1 + v2). Never empty. */
  acceptedIssuers: string[];
  authorizeEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
}

/** Port: resolve a client secret from its store reference (SSM param name / ARN). */
export const SECRET_RESOLVER = Symbol('SECRET_RESOLVER');
export interface ISecretResolver {
  get(ref: string): Promise<string>;
}

/**
 * A connection row is broker-usable only when fully configured. Discovery is
 * mandatory (Decision 6), so `authorityUrl` is required — there are no
 * hand-entered authorize/token endpoints.
 */
export function isBrokerConfigured(c: SsoConnection): boolean {
  return Boolean(c.clientId && c.clientSecretRef && c.authorityUrl);
}
