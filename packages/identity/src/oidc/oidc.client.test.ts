import { describe, it, expect, vi } from 'vitest';
import { OidcClient } from './oidc.client';
import type { ResolvedConnection } from './oidc-connection';

const conn: ResolvedConnection = {
  id: 'c1',
  kind: 'directory',
  provider: 'entra',
  clientId: 'cid',
  clientSecret: 'sec',
  redirectUri: 'https://app/cb',
  scopes: 'openid email',
  issuer: 'https://idp/x',
  acceptedIssuers: ['https://idp/x'],
  authorizeEndpoint: 'https://idp/x/auth',
  tokenEndpoint: 'https://idp/x/token',
  jwksUri: 'https://idp/x/keys',
};

describe('OidcClient', () => {
  it('builds an authorize URL with PKCE + nonce + connection params', () => {
    const url = new URL(
      new OidcClient().buildAuthorizeUrl(conn, { state: 's', codeChallenge: 'ch', nonce: 'n' }),
    );
    expect(url.origin + url.pathname).toBe('https://idp/x/auth');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe('s');
    expect(url.searchParams.get('nonce')).toBe('n');
    expect(url.searchParams.get('redirect_uri')).toBe('https://app/cb');
  });

  it('exchanges code and returns id_token', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id_token: 'idt' }) });
    const out = await new OidcClient(fetchFn as unknown as typeof fetch).exchangeCode(conn, {
      code: 'c',
      codeVerifier: 'v',
    });
    expect(out).toEqual({ idToken: 'idt' });
    expect(fetchFn.mock.calls[0][0]).toBe('https://idp/x/token');
  });

  it('throws when the token response has no id_token', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    await expect(
      new OidcClient(fetchFn as unknown as typeof fetch).exchangeCode(conn, {
        code: 'c',
        codeVerifier: 'v',
      }),
    ).rejects.toThrow(/no id_token/);
  });

  it('generates distinct PKCE + nonce values', () => {
    expect(OidcClient.generatePkce().verifier).not.toBe(OidcClient.generatePkce().verifier);
    expect(OidcClient.generateNonce()).not.toBe(OidcClient.generateNonce());
  });
});
