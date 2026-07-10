import { describe, expect, it } from 'vitest';
import {
  AUTH_SESSION_REPOSITORY,
  SSO_CONNECTION_REPOSITORY,
  USER_REPOSITORY,
  type IAuthSessionRepository,
  type ISsoConnectionRepository,
  type IUserRepository,
} from './repository-ports';
import type { AuthSession, SsoConnection, User } from './domain-types';

describe('repository port DI tokens', () => {
  it('are distinct symbols', () => {
    const tokens = [USER_REPOSITORY, AUTH_SESSION_REPOSITORY, SSO_CONNECTION_REPOSITORY];
    expect(tokens.every((t) => typeof t === 'symbol')).toBe(true);
    expect(new Set(tokens).size).toBe(tokens.length);
  });
});

// ── Compile-time contract checks ─────────────────────────────────────────────
// These never run; they fail the build if a port's shape regresses. They also
// document that the ports are implementable against a concrete transaction type.

type Tx = { readonly _brand: 'tx' };

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _userRepo: IUserRepository<Tx> = {
  findByEmail: async () => null,
  findById: async () => null,
  updateLastLogin: async () => {},
  updateStatus: async () => {},
  updateProfile: async () => ({}) as User,
  findSsoIdentity: async () => null,
  upsertBySsoIdentity: async () => ({}) as User,
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _sessionRepo: IAuthSessionRepository<Tx> = {
  findByTokenHash: async () => null,
  create: async () => {},
  revokeById: async () => {},
  revokeByIdIfActive: async () => false,
  revokeFamily: async () => {},
  revokeAllForUser: async () => {},
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _ssoRepo: ISsoConnectionRepository = {
  findByExternalTenantId: async () => null,
};

describe('domain type shapes', () => {
  it('AuthSession and SsoConnection carry the expected discriminating fields', () => {
    const session: AuthSession = {
      id: 's1',
      workspaceId: 'w1',
      userId: 'u1',
      tokenHash: 'h',
      familyId: 'f1',
      isRevoked: false,
      expiresAt: new Date(),
      createdAt: new Date(),
      ssoProvider: null,
      csrfToken: null,
    };
    const conn: SsoConnection = {
      id: 'c1',
      workspaceId: 'w1',
      provider: 'entra',
      externalTenantId: 'ext',
      issuer: null,
      defaultRoleSlug: 'project_member',
      allowedEmailDomains: [],
      jitEnabled: true,
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    expect(session.isRevoked).toBe(false);
    expect(conn.status).toBe('active');
  });
});
