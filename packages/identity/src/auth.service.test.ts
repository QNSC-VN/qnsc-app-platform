import { describe, expect, it, vi } from 'vitest';
import { UnauthorizedException } from '@qnsc/platform-http';
import { AuthService, type LoginResult } from './auth.service';
import type { AuthServiceOptions } from './auth-options';
import type { AuthSession, User } from './domain-types';

// ── Fakes ────────────────────────────────────────────────────────────────────

const now = new Date('2026-01-01T00:00:00Z');

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    email: 'alice@acme.test',
    displayName: 'Alice',
    avatarUrl: null,
    status: 'active',
    emailVerified: true,
    locale: 'en',
    timezone: 'UTC',
    sessionVersion: 1,
    lastLoginAt: null,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const baseOptions: AuthServiceOptions = {
  jwtAccessExpiry: '15m',
  jwtRefreshExpiry: '30d',
  platformAdminEmails: [],
  nodeEnv: 'test',
};

function makeSession(overrides: Partial<AuthSession> = {}): AuthSession {
  return {
    id: 'sess-1',
    workspaceId: 'ws-1',
    userId: 'user-1',
    tokenHash: 'hash',
    familyId: 'fam-1',
    isRevoked: false,
    expiresAt: new Date('2999-01-01T00:00:00Z'),
    createdAt: now,
    ssoProvider: null,
    csrfToken: 'csrf-1',
    ...overrides,
  };
}

function buildService(opts?: {
  options?: Partial<AuthServiceOptions>;
  claims?: { oid: string; email: string; displayName: string; externalTenantId: string | null };
  user?: User | null;
  existingIdentity?: { userId: string } | null;
  memberships?: Array<{ workspaceId: string }>;
  connection?: {
    workspaceId: string;
    status: string;
    allowedEmailDomains: string[];
    jitEnabled: boolean;
    defaultRoleSlug?: string;
  } | null;
  session?: Partial<AuthSession> | null;
  /** Result of the atomic compare-and-swap revoke (rotation winner = true). */
  revokeWon?: boolean;
  /** Cached rotation-grace payload returned by Valkey (null = miss). */
  graceValue?: string | null;
  /** When set, `getRotationGrace` rejects to simulate a cache outage. */
  graceThrows?: boolean;
}) {
  const userRepo = {
    findByEmail: vi.fn(async () => opts?.user ?? null),
    findById: vi.fn(async () => opts?.user ?? null),
    findSsoIdentity: vi.fn(async () => opts?.existingIdentity ?? null),
    upsertBySsoIdentity: vi.fn(async () => opts?.user ?? makeUser()),
    updateLastLogin: vi.fn(async () => {}),
  };
  const sessionRepo = {
    create: vi.fn(async () => {}),
    findByTokenHash: vi.fn(async () => (opts?.session === undefined ? null : opts.session)),
    revokeByIdIfActive: vi.fn(async () => opts?.revokeWon ?? true),
    revokeById: vi.fn(async () => {}),
    revokeFamily: vi.fn(async () => {}),
    revokeAllForUser: vi.fn(async () => {}),
  };
  const ssoConnectionRepo = {
    findByExternalTenantId: vi.fn(async () => opts?.connection ?? null),
  };
  const txRunner = { transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})) };
  const accessService = {
    getUserRoleAndPermissions: vi.fn(async () => ({ role: 'member', permissions: ['p:read'] })),
    elevateToWorkspaceAdmin: vi.fn(async () => true),
    ensureDefaultRole: vi.fn(async () => {}),
  };
  const workspaceService = {
    getMemberships: vi.fn(async () => opts?.memberships ?? [{ workspaceId: 'ws-1' }]),
    getMembership: vi.fn(async () => null),
    touchMembership: vi.fn(async () => {}),
    enrollMember: vi.fn(async () => {}),
  };
  const audit = { record: vi.fn(async () => {}) };
  const jwt = { sign: vi.fn(() => 'signed.jwt') };
  const valkey = {
    denylistToken: vi.fn(async () => {}),
    storeRotationGrace: vi.fn(async () => {}),
    getRotationGrace: vi.fn(async () => {
      if (opts?.graceThrows) throw new Error('valkey down');
      return opts?.graceValue ?? null;
    }),
  };
  const entraVerifier = {
    verify: vi.fn(
      async () =>
        opts?.claims ?? {
          oid: 'oid-1',
          email: 'alice@acme.test',
          displayName: 'Alice',
          externalTenantId: 'tid-1',
        },
    ),
  };

  const service = new AuthService(
    userRepo as never,
    sessionRepo as never,
    ssoConnectionRepo as never,
    txRunner as never,
    accessService as never,
    workspaceService as never,
    audit as never,
    { ...baseOptions, ...opts?.options },
    jwt as never,
    entraVerifier as never,
    valkey as never,
  );

  return {
    service,
    userRepo,
    sessionRepo,
    ssoConnectionRepo,
    txRunner,
    accessService,
    workspaceService,
    audit,
    jwt,
    entraVerifier,
    valkey,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('AuthService.ssoLogin', () => {
  it('logs in an existing SSO identity and returns tokens + memberships', async () => {
    const user = makeUser();
    const h = buildService({
      existingIdentity: { userId: user.id },
      user,
      memberships: [{ workspaceId: 'ws-1' }],
    });

    const result: LoginResult = await h.service.ssoLogin('id-token', '1.2.3.4');

    expect(result.accessToken).toBe('signed.jwt');
    expect(result.refreshToken).toEqual(expect.any(String));
    expect(result.csrfToken).toEqual(expect.any(String));
    expect(result.expiresIn).toBe(900);
    expect(result.user.email).toBe('alice@acme.test');
    expect(result.memberships).toEqual([{ workspaceId: 'ws-1' }]);
    expect(h.sessionRepo.create).toHaveBeenCalledTimes(1);
    expect(h.userRepo.updateLastLogin).toHaveBeenCalledTimes(1);
    // no JIT provisioning when a membership already exists
    expect(h.userRepo.upsertBySsoIdentity).not.toHaveBeenCalled();
  });

  it('JIT-provisions a brand-new SSO user via the connection', async () => {
    const user = makeUser({ id: 'user-2', email: 'bob@acme.test' });
    const h = buildService({
      existingIdentity: null,
      user,
      claims: {
        oid: 'oid-2',
        email: 'bob@acme.test',
        displayName: 'Bob',
        externalTenantId: 'tid-1',
      },
      connection: {
        workspaceId: 'ws-9',
        status: 'active',
        allowedEmailDomains: ['acme.test'],
        jitEnabled: true,
        defaultRoleSlug: 'project_member',
      },
    });

    const result = await h.service.ssoLogin('id-token');

    expect(h.userRepo.upsertBySsoIdentity).toHaveBeenCalledWith(
      'entra',
      'oid-2',
      'bob@acme.test',
      'Bob',
    );
    expect(h.workspaceService.enrollMember).toHaveBeenCalledWith('ws-9', 'user-2');
    expect(h.accessService.ensureDefaultRole).toHaveBeenCalledWith(
      'user-2',
      'ws-9',
      'project_member',
    );
    expect(result.accessToken).toBe('signed.jwt');
  });

  it('rejects a deactivated existing account', async () => {
    const user = makeUser({ status: 'suspended' });
    const h = buildService({ existingIdentity: { userId: user.id }, user });
    await expect(h.service.ssoLogin('id-token')).rejects.toMatchObject({
      code: 'USER_DEACTIVATED',
    });
  });

  it('rejects when no SSO connection maps the IdP', async () => {
    const h = buildService({ existingIdentity: null, user: makeUser(), connection: null });
    await expect(h.service.ssoLogin('id-token')).rejects.toMatchObject({ code: 'SSO_NO_ACCESS' });
  });

  it('rejects a disabled connection', async () => {
    const h = buildService({
      existingIdentity: null,
      user: makeUser(),
      connection: {
        workspaceId: 'ws-9',
        status: 'disabled',
        allowedEmailDomains: [],
        jitEnabled: true,
      },
    });
    await expect(h.service.ssoLogin('id-token')).rejects.toMatchObject({
      code: 'SSO_CONNECTION_DISABLED',
    });
  });

  it('rejects a disallowed email domain', async () => {
    const h = buildService({
      existingIdentity: null,
      user: makeUser({ email: 'eve@evil.test' }),
      claims: {
        oid: 'oid-3',
        email: 'eve@evil.test',
        displayName: 'Eve',
        externalTenantId: 'tid-1',
      },
      connection: {
        workspaceId: 'ws-9',
        status: 'active',
        allowedEmailDomains: ['acme.test'],
        jitEnabled: true,
      },
    });
    await expect(h.service.ssoLogin('id-token')).rejects.toMatchObject({
      code: 'SSO_DOMAIN_NOT_ALLOWED',
    });
  });

  it('rejects when JIT is disabled', async () => {
    const h = buildService({
      existingIdentity: null,
      user: makeUser(),
      connection: {
        workspaceId: 'ws-9',
        status: 'active',
        allowedEmailDomains: [],
        jitEnabled: false,
      },
    });
    await expect(h.service.ssoLogin('id-token')).rejects.toMatchObject({
      code: 'SSO_JIT_DISABLED',
    });
  });

  it('auto-elevates a platform admin and audits the elevation', async () => {
    const user = makeUser({ email: 'admin@acme.test' });
    const h = buildService({
      existingIdentity: { userId: user.id },
      user,
      options: { platformAdminEmails: ['admin@acme.test'] },
    });
    await h.service.ssoLogin('id-token');
    expect(h.accessService.elevateToWorkspaceAdmin).toHaveBeenCalledWith('user-1', 'ws-1');
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'access.role_elevated' }),
    );
  });
});

describe('AuthService.devLogin', () => {
  it('is blocked in production', async () => {
    const h = buildService({ options: { nodeEnv: 'production' }, user: makeUser() });
    await expect(h.service.devLogin('alice@acme.test')).rejects.toMatchObject({
      code: 'DEV_LOGIN_DISABLED',
    });
  });

  it('signs in a seeded account with a password auth method', async () => {
    const user = makeUser();
    const h = buildService({ user, memberships: [{ workspaceId: 'ws-1' }] });
    const result = await h.service.devLogin('  Alice@Acme.test ');
    expect(h.userRepo.findByEmail).toHaveBeenCalledWith('alice@acme.test');
    expect(result.accessToken).toBe('signed.jwt');
    const signedPayload = h.jwt.sign.mock.calls[0][0] as { authMethod: string };
    expect(signedPayload.authMethod).toBe('password');
  });

  it('rejects an unknown or inactive account', async () => {
    const h = buildService({ user: null });
    await expect(h.service.devLogin('ghost@acme.test')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects when the account has no workspace membership', async () => {
    const h = buildService({ user: makeUser(), memberships: [] });
    await expect(h.service.devLogin('alice@acme.test')).rejects.toMatchObject({
      code: 'ACCOUNT_DEACTIVATED',
    });
  });
});

describe('AuthService.refresh', () => {
  it('rejects an unknown refresh token', async () => {
    const h = buildService({ session: undefined });
    await expect(h.service.refresh('raw', 'csrf-1')).rejects.toMatchObject({
      code: 'AUTH_TOKEN_INVALID',
    });
  });

  it('rejects an expired session', async () => {
    const h = buildService({
      session: makeSession({ expiresAt: new Date('2000-01-01T00:00:00Z') }),
      user: makeUser(),
    });
    await expect(h.service.refresh('raw', 'csrf-1')).rejects.toMatchObject({
      code: 'AUTH_TOKEN_EXPIRED',
    });
  });

  it('rejects a deactivated user', async () => {
    const h = buildService({ session: makeSession(), user: makeUser({ status: 'inactive' }) });
    await expect(h.service.refresh('raw', 'csrf-1')).rejects.toMatchObject({
      code: 'USER_DEACTIVATED',
    });
  });

  it('rejects a CSRF token mismatch', async () => {
    const h = buildService({ session: makeSession({ csrfToken: 'expected' }), user: makeUser() });
    await expect(h.service.refresh('raw', 'wrong')).rejects.toMatchObject({
      code: 'AUTH_TOKEN_INVALID',
    });
  });

  it('rotates the session on a valid refresh and caches the grace entry', async () => {
    const h = buildService({ session: makeSession(), user: makeUser(), revokeWon: true });
    const result = await h.service.refresh('raw', 'csrf-1');

    expect(result.accessToken).toBe('signed.jwt');
    expect(result.refreshToken).toEqual(expect.any(String));
    expect(result.csrfToken).toEqual(expect.any(String));
    // CAS revoke + new session insert both ran inside the rotation transaction.
    expect(h.sessionRepo.revokeByIdIfActive).toHaveBeenCalledWith('sess-1', expect.anything());
    expect(h.sessionRepo.create).toHaveBeenCalledTimes(1);
    const createdSession = h.sessionRepo.create.mock.calls[0][0] as { familyId: string };
    expect(createdSession.familyId).toBe('fam-1'); // family preserved for revocation chain
    expect(h.valkey.storeRotationGrace).toHaveBeenCalledTimes(1);
  });

  it('preserves the SSO auth method across rotation', async () => {
    const h = buildService({
      session: makeSession({ ssoProvider: 'entra' }),
      user: makeUser(),
      revokeWon: true,
    });
    await h.service.refresh('raw', 'csrf-1');
    const signedPayload = h.jwt.sign.mock.calls[0][0] as { authMethod: string };
    expect(signedPayload.authMethod).toBe('sso');
  });

  it('replays the cached successor tokens on a benign revoked-token reuse', async () => {
    const cached = JSON.stringify({
      accessToken: 'cached.jwt',
      refreshToken: 'cached.refresh',
      expiresIn: 900,
      csrfToken: 'cached.csrf',
    });
    const h = buildService({
      session: makeSession({ isRevoked: true }),
      user: makeUser(),
      graceValue: cached,
    });
    const result = await h.service.refresh('raw', 'csrf-1');
    expect(result.accessToken).toBe('cached.jwt');
    expect(h.sessionRepo.revokeFamily).not.toHaveBeenCalled();
  });

  it('revokes the whole family on a revoked-token reuse outside the grace window', async () => {
    const h = buildService({
      session: makeSession({ isRevoked: true }),
      user: makeUser(),
      graceValue: null,
    });
    await expect(h.service.refresh('raw', 'csrf-1')).rejects.toMatchObject({
      code: 'AUTH_REFRESH_TOKEN_REUSE',
    });
    expect(h.sessionRepo.revokeFamily).toHaveBeenCalledWith('fam-1');
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.token_theft_detected' }),
    );
  });

  it('fails safe without revoking the family when the grace cache is unavailable', async () => {
    const h = buildService({
      session: makeSession({ isRevoked: true }),
      user: makeUser(),
      graceThrows: true,
    });
    await expect(h.service.refresh('raw', 'csrf-1')).rejects.toMatchObject({
      code: 'AUTH_TOKEN_INVALID',
    });
    expect(h.sessionRepo.revokeFamily).not.toHaveBeenCalled();
  });

  it('replays instead of competing when it loses the rotation CAS', async () => {
    const cached = JSON.stringify({
      accessToken: 'winner.jwt',
      refreshToken: 'winner.refresh',
      expiresIn: 900,
      csrfToken: 'winner.csrf',
    });
    const h = buildService({
      session: makeSession(),
      user: makeUser(),
      revokeWon: false,
      graceValue: cached,
    });
    const result = await h.service.refresh('raw', 'csrf-1');
    expect(result.accessToken).toBe('winner.jwt');
    // The CAS loser must not persist a second competing session.
    expect(h.sessionRepo.create).not.toHaveBeenCalled();
    expect(h.sessionRepo.revokeFamily).not.toHaveBeenCalled();
  });
});
