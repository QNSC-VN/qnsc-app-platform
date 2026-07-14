import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { BFF_OPTIONS, type BffOptions } from './bff-options';

/** A PKCE verifier/challenge pair (RFC 7636, S256). */
export interface PkcePair {
  verifier: string;
  challenge: string;
}

/** The single field this login-only BFF needs back from the token endpoint. */
export interface EntraTokenResult {
  idToken: string;
}

const OIDC_SCOPES = 'openid profile email';

/**
 * Minimal, stateless Microsoft Entra ID OIDC client for the Authorization-Code
 * + PKCE flow. It builds the authorize URL and exchanges the returned code for
 * an `id_token` — which is handed straight to `AuthService.ssoLogin`. Because
 * the login-only BFF calls no downstream Microsoft Graph APIs, it never keeps
 * the Entra access token, so there is no long-lived Microsoft token custody to
 * secure.
 *
 * This class holds no request state, so it is safe to share across products;
 * each binds its own {@link BffOptions} (tenant, client id/secret, redirect).
 */
@Injectable()
export class EntraOidcClient {
  constructor(@Inject(BFF_OPTIONS) private readonly options: BffOptions) {}

  /** Generate a fresh PKCE pair. Static + pure so it is trivially testable. */
  static generatePkce(): PkcePair {
    const verifier = base64Url(randomBytes(32));
    const challenge = base64Url(createHash('sha256').update(verifier).digest());
    return { verifier, challenge };
  }

  /** Build the Entra authorize URL the browser is redirected to. */
  buildAuthorizeUrl(params: { state: string; codeChallenge: string }): string {
    const url = new URL(this.authorizeEndpoint);
    url.searchParams.set('client_id', this.clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', this.redirectUri);
    url.searchParams.set('response_mode', 'query');
    url.searchParams.set('scope', OIDC_SCOPES);
    url.searchParams.set('state', params.state);
    url.searchParams.set('code_challenge', params.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
  }

  /**
   * Exchange an authorization code for tokens (confidential client: client
   * secret + PKCE verifier), returning the `id_token`.
   */
  async exchangeCode(params: { code: string; codeVerifier: string }): Promise<EntraTokenResult> {
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri: this.redirectUri,
      code_verifier: params.codeVerifier,
      scope: OIDC_SCOPES,
    });

    const response = await fetch(this.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Entra token exchange failed (${response.status}): ${detail.slice(0, 300)}`);
    }

    const json = (await response.json()) as { id_token?: string };
    if (!json.id_token) {
      throw new Error('Entra token response did not include an id_token');
    }
    return { idToken: json.id_token };
  }

  private get tenantId(): string {
    return this.options.entra.tenantId;
  }

  private get clientId(): string {
    return this.options.entra.clientId;
  }

  private get clientSecret(): string {
    return this.options.entra.clientSecret;
  }

  private get redirectUri(): string {
    return this.options.entra.redirectUri;
  }

  /**
   * OIDC authority (host) base URL fronting the tenant-segmented endpoints.
   * Defaults to Microsoft's global cloud; overridable via {@link BffEntraOptions.authority}
   * (e.g. a local mock OIDC server) to exercise the full login flow in tests.
   */
  private get authority(): string {
    return this.options.entra.authority ?? 'https://login.microsoftonline.com';
  }

  private get authorizeEndpoint(): string {
    return `${this.authority}/${this.tenantId}/oauth2/v2.0/authorize`;
  }

  private get tokenEndpoint(): string {
    return `${this.authority}/${this.tenantId}/oauth2/v2.0/token`;
  }
}

/** Base64url-encode a buffer (no padding), for PKCE values. */
function base64Url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
