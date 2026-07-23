import type { ISsoConnectionRepository } from '../repository-ports';
import type { SsoConnection } from '../domain-types';
import type { OidcDiscovery } from './oidc-discovery';
import { isBrokerConfigured, type ISecretResolver, type ResolvedConnection } from './oidc-connection';

/**
 * Resolves an `sso_connections` row into a fully-formed {@link ResolvedConnection}
 * (client secret + discovered endpoints + the app redirect), for an email
 * (directory-by-domain, else shared-by-invite) or by id (the callback).
 *
 * Deliberately does **not** cache the assembled connection: the only expensive
 * I/O is already cached one layer down — {@link OidcDiscovery} (endpoint TTL
 * cache) and the {@link ISecretResolver} implementation (secret TTL cache). So
 * every resolve re-reads the current row, keeping status/config fresh and making
 * a `status='disabled'` cutoff take effect **immediately** (no stale-cache
 * window). Disabled / unconfigured rows resolve to `null`.
 */
export class ConnectionRegistry {
  constructor(
    private readonly repo: ISsoConnectionRepository,
    private readonly secrets: ISecretResolver,
    private readonly discovery: OidcDiscovery,
    /** The single app-level callback (Decision 9), shared by every connection. */
    private readonly redirectUri: string,
  ) {}

  /** Email-first routing: a directory that owns the domain, else a shared IdP the email is invited to. */
  async resolveForEmail(email: string): Promise<ResolvedConnection | null> {
    const row =
      (await this.repo.findDirectoryByEmailDomain(email)) ??
      (await this.repo.findSharedByInvitedEmail(email));
    return row ? this.resolve(row) : null;
  }

  /** Callback path: resolve the connection stored with the auth request's state. */
  async resolveById(id: string): Promise<ResolvedConnection | null> {
    const row = await this.repo.findById(id);
    return row ? this.resolve(row) : null;
  }

  private async resolve(row: SsoConnection): Promise<ResolvedConnection | null> {
    if (row.status !== 'active' || !isBrokerConfigured(row)) return null;

    const endpoints = await this.discovery.resolve(row.authorityUrl!);
    const clientSecret = await this.secrets.get(row.clientSecretRef!);
    return {
      id: row.id,
      kind: row.kind ?? 'directory',
      provider: row.provider,
      workspaceId: row.workspaceId,
      defaultRoleSlug: row.defaultRoleSlug,
      allowedEmailDomains: row.allowedEmailDomains,
      jitEnabled: row.jitEnabled,
      clientId: row.clientId!,
      clientSecret,
      redirectUri: this.redirectUri,
      scopes: row.scopes ?? 'openid profile email',
      issuer: endpoints.issuer,
      acceptedIssuers:
        row.acceptedIssuers && row.acceptedIssuers.length > 0
          ? row.acceptedIssuers
          : [endpoints.issuer],
      authorizeEndpoint: endpoints.authorizeEndpoint,
      tokenEndpoint: endpoints.tokenEndpoint,
      jwksUri: row.jwksUri ?? endpoints.jwksUri,
    };
  }
}
