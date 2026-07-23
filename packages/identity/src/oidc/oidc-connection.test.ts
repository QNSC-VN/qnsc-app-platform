import { describe, it, expect } from 'vitest';
import { isBrokerConfigured } from './oidc-connection';
import type { SsoConnection } from '../domain-types';

const base = (o: Partial<SsoConnection> = {}): SsoConnection => ({
  id: 'c1',
  workspaceId: 'w1',
  provider: 'entra',
  externalTenantId: 't1',
  issuer: null,
  defaultRoleSlug: 'project_member',
  allowedEmailDomains: [],
  jitEnabled: true,
  status: 'active',
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...o,
});

describe('isBrokerConfigured', () => {
  it('is false when broker fields are missing', () => {
    expect(isBrokerConfigured(base())).toBe(false);
  });

  it('is false without authorityUrl (discovery is mandatory)', () => {
    expect(isBrokerConfigured(base({ clientId: 'cid', clientSecretRef: '/ref' }))).toBe(false);
  });

  it('is true with clientId + clientSecretRef + authorityUrl', () => {
    expect(
      isBrokerConfigured(
        base({ clientId: 'cid', clientSecretRef: '/ref', authorityUrl: 'https://idp/x' }),
      ),
    ).toBe(true);
  });
});
