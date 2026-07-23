import { describe, it, expect, vi } from 'vitest';
import { ConnectionRegistry } from './connection-registry';
import { OidcDiscovery } from './oidc-discovery';
import type { ISsoConnectionRepository } from '../repository-ports';
import type { ISecretResolver } from './oidc-connection';
import type { SsoConnection } from '../domain-types';

const row = (o: Partial<SsoConnection> = {}): SsoConnection => ({
  id: 'c1',
  workspaceId: 'w1',
  provider: 'entra',
  externalTenantId: 't1',
  issuer: null,
  defaultRoleSlug: 'project_member',
  allowedEmailDomains: ['vendor.com'],
  jitEnabled: true,
  status: 'active',
  createdAt: new Date(0),
  updatedAt: new Date(0),
  kind: 'directory',
  authorityUrl: 'https://idp/x',
  clientId: 'cid',
  clientSecretRef: '/ref',
  ...o,
});

const endpoints = {
  issuer: 'https://idp/x/v2.0',
  authorization_endpoint: 'https://idp/x/auth',
  token_endpoint: 'https://idp/x/token',
  jwks_uri: 'https://idp/x/keys',
};

function make(repo: Partial<ISsoConnectionRepository>, secretsGet = vi.fn().mockResolvedValue('SEC')) {
  const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => endpoints });
  const discovery = new OidcDiscovery(3_600_000, fetchFn as unknown as typeof fetch);
  const secrets: ISecretResolver = { get: secretsGet };
  const fullRepo = {
    findByExternalTenantId: vi.fn(),
    findDirectoryByEmailDomain: vi.fn().mockResolvedValue(null),
    findSharedByInvitedEmail: vi.fn().mockResolvedValue(null),
    findById: vi.fn().mockResolvedValue(null),
    listActiveShared: vi.fn().mockResolvedValue([]),
    connectionOwnsEmailDomain: vi.fn(),
    ...repo,
  } as ISsoConnectionRepository;
  const reg = new ConnectionRegistry(fullRepo, secrets, discovery, 'https://app/cb');
  return { reg, fetchFn, secretsGet };
}

describe('ConnectionRegistry', () => {
  it('resolves a directory connection by email domain (secret + discovered endpoints + app redirect)', async () => {
    const { reg } = make({ findDirectoryByEmailDomain: vi.fn().mockResolvedValue(row()) });
    const r = await reg.resolveForEmail('x@vendor.com');
    expect(r).toMatchObject({
      id: 'c1',
      kind: 'directory',
      clientId: 'cid',
      clientSecret: 'SEC',
      redirectUri: 'https://app/cb',
      issuer: 'https://idp/x/v2.0',
      acceptedIssuers: ['https://idp/x/v2.0'], // falls back to discovery issuer
      authorizeEndpoint: 'https://idp/x/auth',
      tokenEndpoint: 'https://idp/x/token',
      jwksUri: 'https://idp/x/keys',
    });
  });

  it('falls back to a shared-by-invite connection when no directory owns the domain', async () => {
    const shared = vi.fn().mockResolvedValue(row({ id: 'c2', kind: 'shared', provider: 'google' }));
    const { reg } = make({ findSharedByInvitedEmail: shared });
    const r = await reg.resolveForEmail('guest@gmail.com');
    expect(r?.id).toBe('c2');
    expect(shared).toHaveBeenCalled();
  });

  it('returns null for an unknown email (no directory, no invite)', async () => {
    const { reg } = make({});
    expect(await reg.resolveForEmail('x@nowhere.com')).toBeNull();
  });

  it('returns null for a disabled connection (cutoff)', async () => {
    const { reg } = make({ findById: vi.fn().mockResolvedValue(row({ status: 'disabled' })) });
    expect(await reg.resolveById('c1')).toBeNull();
  });

  it('returns null for an unconfigured connection', async () => {
    const { reg } = make({ findById: vi.fn().mockResolvedValue(row({ authorityUrl: null })) });
    expect(await reg.resolveById('c1')).toBeNull();
  });

  it('honors explicit acceptedIssuers when present', async () => {
    const { reg } = make({
      findById: vi.fn().mockResolvedValue(row({ acceptedIssuers: ['https://a', 'https://b'] })),
    });
    const r = await reg.resolveById('c1');
    expect(r?.acceptedIssuers).toEqual(['https://a', 'https://b']);
  });

  it('caches by connection id (no repeat discovery/secret fetch within TTL)', async () => {
    const { reg, fetchFn, secretsGet } = make({
      findById: vi.fn().mockResolvedValue(row()),
    });
    await reg.resolveById('c1');
    await reg.resolveById('c1');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(secretsGet).toHaveBeenCalledTimes(1);
  });
});
