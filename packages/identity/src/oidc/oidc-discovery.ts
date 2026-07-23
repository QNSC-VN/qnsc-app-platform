export interface OidcEndpoints {
  issuer: string;
  authorizeEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
}

interface CacheEntry {
  value: OidcEndpoints;
  expiresAt: number;
}

/**
 * Fetch + cache `.well-known/openid-configuration` per authority. Discovery is
 * mandatory for the broker, so this is the single source of authorize/token/
 * jwks endpoints + the canonical issuer. TTL default 1h; injectable fetch/clock
 * for tests.
 */
export class OidcDiscovery {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly ttlMs = 3_600_000,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async resolve(authorityUrl: string): Promise<OidcEndpoints> {
    const cached = this.cache.get(authorityUrl);
    if (cached && cached.expiresAt > this.now()) return cached.value;

    const url = authorityUrl.replace(/\/$/, '') + '/.well-known/openid-configuration';
    const res = await this.fetchFn(url);
    if (!res.ok) {
      throw new Error(`OIDC discovery failed for ${authorityUrl}: ${res.status}`);
    }
    const doc = (await res.json()) as Record<string, string>;
    const value: OidcEndpoints = {
      issuer: doc.issuer,
      authorizeEndpoint: doc.authorization_endpoint,
      tokenEndpoint: doc.token_endpoint,
      jwksUri: doc.jwks_uri,
    };
    this.cache.set(authorityUrl, { value, expiresAt: this.now() + this.ttlMs });
    return value;
  }
}
