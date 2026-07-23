import type { ISsoConnectionRepository } from '../repository-ports';
import type { SsoConnection } from '../domain-types';
import { OidcDiscovery } from './oidc-discovery';
import { isBrokerConfigured, type ISecretResolver, type ResolvedConnection } from './oidc-connection';

interface CacheEntry {
  value: ResolvedConnection;
  expiresAt: number;
}

/**
 * Turns an `sso_connections` row into a fully-formed {@link ResolvedConnection}
 * (secret + discovered endpoints + app redirect), and resolves the connection
 * for an email (directory-by-domain, else shared-by-invite) or by id (callback).
 * Short-TTL cache keyed by connection id avoids re-fetching discovery/secret on
 * every login. Disabled / unconfigured rows resolve to null (instant cutoff).
 */
export class ConnectionRegistry {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly repo: ISsoConnectionRepository,
    private readonly secrets: ISecretResolver,
    private readonly discovery: OidcDiscovery,
    /** The single app-level callback (Decision 9), shared by every connection. */
    private readonly redirectUri: string,
    private readonly ttlMs = 300_000,
    private readonly now: () => number = () => Date.now(),
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
    const cached = this.cache.get(id);
    if (cached && cached.expiresAt > this.now()) return cached.value;
    const row = await this.repo.findById(id);
    return row ? this.resolve(row) : null;
  }

  private async resolve(row: SsoConnection): Promise<ResolvedConnection | null> {
    if (row.status !== 'active' || !isBrokerConfigured(row)) return null;

    const cached = this.cache.get(row.id);
    if (cached && cached.expiresAt > this.now()) return cached.value;

    const endpoints = await this.discovery.resolve(row.authorityUrl!);
    const clientSecret = await this.secrets.get(row.clientSecretRef!);
    const resolved: ResolvedConnection = {
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
    this.cache.set(row.id, { value: resolved, expiresAt: this.now() + this.ttlMs });
    return resolved;
  }
}
