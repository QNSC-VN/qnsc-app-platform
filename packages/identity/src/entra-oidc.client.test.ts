import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type BffOptions } from './bff-options';
import { EntraOidcClient } from './entra-oidc.client';

/** Minimal BffOptions carrying fixed Entra config. */
function makeOptions(overrides: Partial<BffOptions['entra']> = {}): BffOptions {
  return {
    postLoginRedirect: '/home',
    sessionTtlSeconds: 3600,
    entra: {
      tenantId: 'tenant-123',
      clientId: 'client-abc',
      clientSecret: 'secret-xyz',
      redirectUri: 'https://rally-dev.qnsc.vn/v1/bff/callback',
      ...overrides,
    },
  };
}

describe('EntraOidcClient.generatePkce', () => {
  it('produces a base64url verifier and an S256 challenge derived from it', () => {
    const { verifier, challenge } = EntraOidcClient.generatePkce();

    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, no padding
    const expected = createHash('sha256')
      .update(verifier)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(challenge).toBe(expected);
  });

  it('produces a unique pair each call', () => {
    expect(EntraOidcClient.generatePkce().verifier).not.toBe(
      EntraOidcClient.generatePkce().verifier,
    );
  });
});

describe('EntraOidcClient.buildAuthorizeUrl', () => {
  it('targets the tenant authorize endpoint with the PKCE + flow params', () => {
    const client = new EntraOidcClient(makeOptions());
    const url = new URL(
      client.buildAuthorizeUrl({ state: 'state-1', codeChallenge: 'challenge-1' }),
    );

    expect(url.origin + url.pathname).toBe(
      'https://login.microsoftonline.com/tenant-123/oauth2/v2.0/authorize',
    );
    expect(url.searchParams.get('client_id')).toBe('client-abc');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe('https://rally-dev.qnsc.vn/v1/bff/callback');
    expect(url.searchParams.get('scope')).toBe('openid profile email');
    expect(url.searchParams.get('state')).toBe('state-1');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-1');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });
});

describe('EntraOidcClient.exchangeCode', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('posts a confidential PKCE exchange and returns the id_token', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id_token: 'the-id-token' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new EntraOidcClient(makeOptions());
    const result = await client.exchangeCode({ code: 'auth-code', codeVerifier: 'verifier-1' });

    expect(result.idToken).toBe('the-id-token');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://login.microsoftonline.com/tenant-123/oauth2/v2.0/token');
    const body = init.body as URLSearchParams;
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('client_id')).toBe('client-abc');
    expect(body.get('client_secret')).toBe('secret-xyz');
    expect(body.get('code')).toBe('auth-code');
    expect(body.get('code_verifier')).toBe('verifier-1');
  });

  it('throws when the token endpoint returns a non-2xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => 'invalid_grant' }),
    );
    const client = new EntraOidcClient(makeOptions());
    await expect(client.exchangeCode({ code: 'bad', codeVerifier: 'v' })).rejects.toThrow(
      /token exchange failed \(400\)/,
    );
  });

  it('throws when the response omits id_token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ access_token: 'x' }) }),
    );
    const client = new EntraOidcClient(makeOptions());
    await expect(client.exchangeCode({ code: 'c', codeVerifier: 'v' })).rejects.toThrow(
      /did not include an id_token/,
    );
  });
});
