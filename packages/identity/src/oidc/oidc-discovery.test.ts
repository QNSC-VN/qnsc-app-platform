import { describe, it, expect, vi } from 'vitest';
import { OidcDiscovery } from './oidc-discovery';

const doc = {
  issuer: 'https://idp/x',
  authorization_endpoint: 'https://idp/x/auth',
  token_endpoint: 'https://idp/x/token',
  jwks_uri: 'https://idp/x/keys',
};

describe('OidcDiscovery', () => {
  it('fetches and maps endpoints', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => doc });
    const d = new OidcDiscovery(3_600_000, fetchFn as unknown as typeof fetch);
    expect(await d.resolve('https://idp/x')).toEqual({
      issuer: 'https://idp/x',
      authorizeEndpoint: 'https://idp/x/auth',
      tokenEndpoint: 'https://idp/x/token',
      jwksUri: 'https://idp/x/keys',
    });
  });

  it('caches within the TTL (one fetch)', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => doc });
    const d = new OidcDiscovery(3_600_000, fetchFn as unknown as typeof fetch, () => 1000);
    await d.resolve('https://idp/x');
    await d.resolve('https://idp/x');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('throws on a non-2xx discovery response', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    const d = new OidcDiscovery(3_600_000, fetchFn as unknown as typeof fetch);
    await expect(d.resolve('https://idp/x')).rejects.toThrow(/discovery failed/);
  });
});
