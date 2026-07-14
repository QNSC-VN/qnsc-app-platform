import { describe, expect, it, vi } from 'vitest';
import { NotFoundException, UnauthorizedException } from '@qnsc-vn/platform-http';
import { AuthService, type LoginResult } from './auth.service';
import type { AuthServiceOptions } from './auth-options';
import type { AuthSession, User } from './domain-types';
import type { JwtPayload } from './jwt-payload';

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
    contextId: 'ws-1',
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

function makePayload(overrides: Partial<JwtPayload> = {}): JwtPayload {
  return {
    sub: 'user-1',
    contextId: 'ws-1',
    sessionId: 'sess-1',
    jti: 'jti-1',
    iss: 'rally',
    aud: 'rally',
    iat: 1_700_000_000,
    exp: 4_100_000_000, // far future so the denylist TTL is positive
    claims: { permissions: ['p:read'] },
    authMethod: 'password',
    ...overrides,
  };
}

function buildService(opts?: {
  options?: Partial<AuthServiceOptions>;
  claims?: {
    oid: string;
    email: string;
    displayName: string;
    externalTenantId: string | null;
    roles?: string[];
  };
  user?: User | null;
  existingIdentity?: { userId: string } | null;
  memberships?: Array<{ workspaceId: string }>;
  membership?: { status: string } | null;
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
  /** Single-tenant mode: no workspace/access/sso-connection services bound (opshub). */
  workspaceless?: boolean;
  /** Bind the optional SSO provisioning hook (e.g. opshub Entra-role sync). */
  withHook?: boolean;
}) {
  const userRepo = {
    findByEmail: vi.fn(async () => opts?.user ?? null),
    findById: vi.fn(async () => opts?.user ?? null),
    findSsoIdentity: vi.fn(async () => opts?.existingIdentity ?? null),
    upsertBySsoIdentity: vi.fn(async () => opts?.user ?? makeUser()),
    updateLastLogin: vi.fn(async () => {}),
    updateProfile: vi.fn(async (_id: string, input: Partial<User>) => ({
      ...(opts?.user ?? makeUser()),
      ...input,
    })),
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
  const claimsProvider = {
    getClaims: vi.fn(async () => ({ permissions: ['p:read'] })),
  };
  const workspaceService = {
    getMemberships: vi.fn(async () => opts?.memberships ?? [{ workspaceId: 'ws-1' }]),
    getMembership: vi.fn(async () => opts?.membership ?? null),
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
          roles: [],
        },
    ),
  };
  const provisioningHook = { onUserProvisioned: vi.fn(async () => {}) };

  const service = new AuthService(
    userRepo as never,
    sessionRepo as never,
    (opts?.workspaceless ? null : ssoConnectionRepo) as never,
    txRunner as never,
    (opts?.workspaceless ? null : accessService) as never,
    claimsProvider as never,
    (opts?.workspaceless ? null : workspaceService) as never,
    audit as never,
    { ...baseOptions, ...opts?.options },
    jwt as never,
    entraVerifier as never,
    valkey as never,
    (opts?.withHook ? provisioningHook : null) as never,
  );

  return {
    service,
    userRepo,
    sessionRepo,
    ssoConnectionRepo,
    txRunner,
    accessService,
    claimsProvider,
    workspaceService,
    audit,
    jwt,
    entraVerifier,
    valkey,
    provisioningHook,
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

  it('assigns a baseline role on JIT provision even when the connection has no default slug', async () => {
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
        // no defaultRoleSlug — the access service supplies its own default so the
        // provisioned member never lands role-less (minimal-permission fallback).
      },
    });

    await h.service.ssoLogin('id-token');

    expect(h.accessService.ensureDefaultRole).toHaveBeenCalledWith('user-2', 'ws-9', undefined);
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

describe('AuthService — single-tenant (workspace-less) mode', () => {
  it('ssoLogin mints a null-context session with no memberships', async () => {
    const user = makeUser();
    const h = buildService({
      workspaceless: true,
      existingIdentity: { userId: user.id },
      user,
    });

    const result = await h.service.ssoLogin('id-token', '9.9.9.9');

    expect(result.accessToken).toBe('signed.jwt');
    expect(result.memberships).toBeUndefined();
    // No workspace resolution or membership enrollment in single-tenant mode.
    expect(h.workspaceService.getMemberships).not.toHaveBeenCalled();
    expect(h.ssoConnectionRepo.findByExternalTenantId).not.toHaveBeenCalled();
    const signedPayload = h.jwt.sign.mock.calls[0][0] as { contextId: string | null };
    expect(signedPayload.contextId).toBeNull();
  });

  it('ssoLogin JIT-provisions a brand-new user without a connection', async () => {
    const user = makeUser({ id: 'user-9', email: 'new@opshub.test' });
    const h = buildService({
      workspaceless: true,
      existingIdentity: null,
      user,
      claims: {
        oid: 'oid-9',
        email: 'new@opshub.test',
        displayName: 'New Hire',
        externalTenantId: 'tid-1',
        roles: ['it-admin'],
      },
    });

    const result = await h.service.ssoLogin('id-token');

    expect(h.userRepo.upsertBySsoIdentity).toHaveBeenCalledWith(
      'entra',
      'oid-9',
      'new@opshub.test',
      'New Hire',
    );
    expect(result.accessToken).toBe('signed.jwt');
    expect(result.memberships).toBeUndefined();
  });

  it('ssoLogin invokes the provisioning hook with the Entra claims and null context', async () => {
    const user = makeUser();
    const h = buildService({
      workspaceless: true,
      withHook: true,
      existingIdentity: { userId: user.id },
      user,
      claims: {
        oid: 'oid-1',
        email: 'alice@acme.test',
        displayName: 'Alice',
        externalTenantId: 'tid-1',
        roles: ['it-admin', 'asset-manager'],
      },
    });

    await h.service.ssoLogin('id-token');

    expect(h.provisioningHook.onUserProvisioned).toHaveBeenCalledWith(
      user,
      expect.objectContaining({
        contextId: null,
        entra: expect.objectContaining({ roles: ['it-admin', 'asset-manager'] }),
      }),
    );
  });

  it('devLogin mints a null-context session without requiring a membership', async () => {
    const user = makeUser();
    const h = buildService({ workspaceless: true, user });

    const result = await h.service.devLogin('alice@acme.test');

    expect(result.accessToken).toBe('signed.jwt');
    expect(result.memberships).toBeUndefined();
    expect(h.workspaceService.getMemberships).not.toHaveBeenCalled();
    const signedPayload = h.jwt.sign.mock.calls[0][0] as {
      contextId: string | null;
      authMethod: string;
    };
    expect(signedPayload.contextId).toBeNull();
    expect(signedPayload.authMethod).toBe('password');
  });

  it('switchWorkspace is unsupported in single-tenant mode', async () => {
    const h = buildService({ workspaceless: true, user: makeUser() });
    await expect(h.service.switchWorkspace(makePayload(), 'ws-2')).rejects.toMatchObject({
      code: 'WORKSPACE_SWITCH_UNSUPPORTED',
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

describe('AuthService.logout', () => {
  it('denylists the access token and revokes the session', async () => {
    const h = buildService();
    await h.service.logout(makePayload({ jti: 'jti-x', sessionId: 'sess-x' }));

    expect(h.valkey.denylistToken).toHaveBeenCalledWith('jti-x', expect.any(Number));
    expect(h.sessionRepo.revokeById).toHaveBeenCalledWith('sess-x');
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.logout', resourceId: 'sess-x' }),
    );
  });

  it('skips the denylist when the token has already expired', async () => {
    const h = buildService();
    await h.service.logout(makePayload({ exp: 1 })); // long past

    expect(h.valkey.denylistToken).not.toHaveBeenCalled();
    expect(h.sessionRepo.revokeById).toHaveBeenCalled();
  });
});

describe('AuthService.logoutAll', () => {
  it('denylists the access token and revokes every session for the user', async () => {
    const h = buildService();
    await h.service.logoutAll(makePayload({ jti: 'jti-y', sub: 'user-9' }));

    expect(h.valkey.denylistToken).toHaveBeenCalledWith('jti-y', expect.any(Number));
    expect(h.sessionRepo.revokeAllForUser).toHaveBeenCalledWith('user-9');
  });
});

describe('AuthService.switchWorkspace', () => {
  it('rejects when the caller is not an active member of the target workspace', async () => {
    const h = buildService({ membership: null });
    await expect(h.service.switchWorkspace(makePayload(), 'ws-2')).rejects.toMatchObject({
      code: 'WORKSPACE_ACCESS_DENIED',
    });
  });

  it('rejects a suspended membership on the target workspace', async () => {
    const h = buildService({ membership: { status: 'suspended' } });
    await expect(h.service.switchWorkspace(makePayload(), 'ws-2')).rejects.toMatchObject({
      code: 'WORKSPACE_ACCESS_DENIED',
    });
  });

  it('rejects a deactivated user', async () => {
    const h = buildService({
      membership: { status: 'active' },
      user: makeUser({ status: 'inactive' }),
    });
    await expect(h.service.switchWorkspace(makePayload(), 'ws-2')).rejects.toMatchObject({
      code: 'USER_DEACTIVATED',
    });
  });

  it('issues a new token pair, revokes the old session, and denylists the old token', async () => {
    const h = buildService({ membership: { status: 'active' }, user: makeUser() });
    const result = await h.service.switchWorkspace(
      makePayload({ jti: 'old-jti', sessionId: 'old-sess', contextId: 'ws-1' }),
      'ws-2',
      '10.0.0.1',
    );

    expect(result.accessToken).toBe('signed.jwt');
    expect(result.refreshToken).toEqual(expect.any(String));
    expect(result.csrfToken).toEqual(expect.any(String));
    expect(h.valkey.denylistToken).toHaveBeenCalledWith('old-jti', expect.any(Number));
    expect(h.sessionRepo.revokeById).toHaveBeenCalledWith('old-sess', expect.anything());
    const createdSession = h.sessionRepo.create.mock.calls[0][0] as { contextId: string };
    expect(createdSession.contextId).toBe('ws-2');
    expect(h.workspaceService.touchMembership).toHaveBeenCalledWith('user-1', 'ws-2');
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.switch_workspace' }),
    );
  });

  it('preserves the SSO auth method across the switch', async () => {
    const h = buildService({ membership: { status: 'active' }, user: makeUser() });
    await h.service.switchWorkspace(makePayload({ authMethod: 'sso' }), 'ws-2');
    const signedPayload = h.jwt.sign.mock.calls[0][0] as { authMethod: string };
    expect(signedPayload.authMethod).toBe('sso');
  });
});

describe('AuthService.getMe', () => {
  it('returns the authenticated user profile', async () => {
    const user = makeUser();
    const h = buildService({ user });
    await expect(h.service.getMe('user-1')).resolves.toMatchObject({ id: 'user-1' });
  });

  it('throws NotFoundException for a missing user', async () => {
    const h = buildService({ user: null });
    await expect(h.service.getMe('ghost')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws NotFoundException for a soft-deleted user', async () => {
    const h = buildService({ user: makeUser({ deletedAt: now }) });
    await expect(h.service.getMe('user-1')).rejects.toMatchObject({ code: 'USER_NOT_FOUND' });
  });
});

describe('AuthService.updateProfile', () => {
  it('updates and returns the profile', async () => {
    const h = buildService({ user: makeUser() });
    const result = await h.service.updateProfile('user-1', { displayName: 'Alice B.' });
    expect(h.userRepo.updateProfile).toHaveBeenCalledWith('user-1', { displayName: 'Alice B.' });
    expect(result.displayName).toBe('Alice B.');
  });

  it('throws NotFoundException when the user does not exist', async () => {
    const h = buildService({ user: null });
    await expect(h.service.updateProfile('ghost', { locale: 'fr' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
