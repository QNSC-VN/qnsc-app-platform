import { createHash, randomBytes } from 'node:crypto';
import type { ResolvedConnection } from './oidc-connection';

export interface OidcPkcePair {
  verifier: string;
  challenge: string;
}
export interface OidcTokenResult {
  idToken: string;
}

const b64url = (b: Buffer) => b.toString('base64url');

/**
 * Provider-agnostic OIDC Authorization-Code + PKCE client. Takes a
 * {@link ResolvedConnection} per call, so one instance serves every IdP.
 */
export class OidcClient {
  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  static generatePkce(): OidcPkcePair {
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    return { verifier, challenge };
  }

  /** Random URL-safe value for the OIDC `nonce` (binds the id_token to this request). */
  static generateNonce(): string {
    return b64url(randomBytes(16));
  }

  buildAuthorizeUrl(
    conn: ResolvedConnection,
    params: { state: string; codeChallenge: string; nonce: string },
  ): string {
    const url = new URL(conn.authorizeEndpoint);
    url.searchParams.set('client_id', conn.clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', conn.redirectUri);
    url.searchParams.set('response_mode', 'query');
    url.searchParams.set('scope', conn.scopes);
    url.searchParams.set('state', params.state);
    url.searchParams.set('nonce', params.nonce);
    url.searchParams.set('code_challenge', params.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
  }

  async exchangeCode(
    conn: ResolvedConnection,
    params: { code: string; codeVerifier: string },
  ): Promise<OidcTokenResult> {
    const body = new URLSearchParams({
      client_id: conn.clientId,
      client_secret: conn.clientSecret,
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri: conn.redirectUri,
      code_verifier: params.codeVerifier,
      scope: conn.scopes,
    });
    const res = await this.fetchFn(conn.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) throw new Error(`OIDC token exchange failed: ${res.status}`);
    const json = (await res.json()) as { id_token?: string };
    if (!json.id_token) throw new Error('OIDC token exchange returned no id_token');
    return { idToken: json.id_token };
  }
}
