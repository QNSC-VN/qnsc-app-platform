import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { UnauthorizedException } from '@qnsc-vn/platform-http';
import { AuthController } from './auth.controller';
import type { AuthService, LoginResult, RefreshResult } from './auth.service';
import type { IAccessService, IWorkspaceService } from './service-ports';
import type { JwtPayload } from './jwt-payload';

const now = new Date('2026-01-01T00:00:00Z');

function makeLoginResult(overrides: Partial<LoginResult> = {}): LoginResult {
  return {
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresIn: 900,
    csrfToken: 'csrf-1',
    user: {
      id: 'user-1',
      email: 'alice@acme.test',
      displayName: 'Alice',
      avatarUrl: null,
      locale: 'en',
      timezone: 'UTC',
    },
    memberships: [],
    ...overrides,
  };
}

function makeRefreshResult(overrides: Partial<RefreshResult> = {}): RefreshResult {
  return {
    accessToken: 'access-2',
    refreshToken: 'refresh-2',
    expiresIn: 900,
    csrfToken: 'csrf-2',
    ...overrides,
  };
}

function makePayload(overrides: Partial<JwtPayload> = {}): JwtPayload {
  return {
    sub: 'user-1',
    workspaceId: 'ws-1',
    sessionId: 'sess-1',
    jti: 'jti-1',
    iss: 'rally',
    aud: 'rally',
    iat: 1_700_000_000,
    exp: 4_100_000_000,
    permissions: ['p:read'],
    authMethod: 'password',
    ...overrides,
  };
}

function makeReq(
  overrides: {
    cookies?: Record<string, string | undefined>;
    headers?: Record<string, string | undefined>;
    ip?: string;
    protocol?: string;
  } = {},
) {
  return {
    ip: overrides.ip ?? '203.0.113.7',
    protocol: overrides.protocol ?? 'https',
    cookies: overrides.cookies ?? {},
    headers: overrides.headers ?? {},
  } as never;
}

function makeReply() {
  return {
    setCookie: vi.fn(),
    clearCookie: vi.fn(),
  };
}

function build(opts?: {
  authService?: Partial<AuthService>;
  role?: string;
  permissions?: string[];
}) {
  const authService = {
    ssoLogin: vi.fn(async () => makeLoginResult()),
    devLogin: vi.fn(async () => makeLoginResult()),
    refresh: vi.fn(async () => makeRefreshResult()),
    switchWorkspace: vi.fn(async () => makeRefreshResult()),
    logout: vi.fn(async () => {}),
    logoutAll: vi.fn(async () => {}),
    getMe: vi.fn(async () => ({
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
    })),
    updateProfile: vi.fn(async () => ({
      id: 'user-1',
      email: 'alice@acme.test',
      displayName: 'Alice Renamed',
      avatarUrl: null,
      status: 'active' as const,
      emailVerified: true,
      locale: 'en',
      timezone: 'UTC',
      sessionVersion: 1,
      lastLoginAt: null,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    })),
    ...opts?.authService,
  } as unknown as AuthService;

  const accessService: IAccessService = {
    getUserRoleAndPermissions: vi.fn(async () => ({
      role: opts?.role ?? 'member',
      permissions: opts?.permissions ?? ['p:read'],
    })),
    elevateToWorkspaceAdmin: vi.fn(async () => true),
    ensureDefaultRole: vi.fn(async () => {}),
  };

  const workspaceService: IWorkspaceService = {
    getMemberships: vi.fn(async () => []),
    getMembership: vi.fn(async () => null),
    touchMembership: vi.fn(async () => {}),
    enrollMember: vi.fn(async () => {}),
  };

  const controller = new AuthController(authService, accessService, workspaceService);
  return { controller, authService, accessService, workspaceService };
}

describe('AuthController.ssoLogin', () => {
  it('sets refresh + csrf cookies and returns the token body', async () => {
    const { controller, authService } = build();
    const reply = makeReply();

    const body = await controller.ssoLogin(
      { idToken: 'id-token' } as never,
      makeReq(),
      reply as never,
    );

    expect(authService.ssoLogin).toHaveBeenCalledWith('id-token', '203.0.113.7');
    expect(reply.setCookie).toHaveBeenCalledWith('refresh_token', 'refresh-1', expect.any(Object));
    expect(reply.setCookie).toHaveBeenCalledWith('csrf_token', 'csrf-1', expect.any(Object));
    expect(body).toEqual({
      accessToken: 'access-1',
      expiresIn: 900,
      user: expect.objectContaining({ id: 'user-1' }),
      memberships: [],
    });
  });

  it('marks the refresh cookie httpOnly and the csrf cookie JS-readable site-wide', async () => {
    const { controller } = build();
    const reply = makeReply();

    await controller.ssoLogin({ idToken: 'id-token' } as never, makeReq(), reply as never);

    const refreshOpts = reply.setCookie.mock.calls.find((c) => c[0] === 'refresh_token')?.[2];
    const csrfOpts = reply.setCookie.mock.calls.find((c) => c[0] === 'csrf_token')?.[2];
    expect(refreshOpts).toMatchObject({ httpOnly: true, path: '/v1/auth' });
    expect(csrfOpts).toMatchObject({ httpOnly: false, path: '/' });
  });
});

describe('AuthController.refresh', () => {
  it('rejects when the refresh cookie is missing', async () => {
    const { controller } = build();
    await expect(
      controller.refresh(makeReq({ cookies: {} }), makeReply() as never),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rotates using the cookie token + csrf header and re-sets cookies', async () => {
    const { controller, authService } = build();
    const reply = makeReply();

    const body = await controller.refresh(
      makeReq({ cookies: { refresh_token: 'refresh-1' }, headers: { 'x-csrf-token': 'csrf-1' } }),
      reply as never,
    );

    expect(authService.refresh).toHaveBeenCalledWith('refresh-1', 'csrf-1', '203.0.113.7');
    expect(reply.setCookie).toHaveBeenCalledWith('refresh_token', 'refresh-2', expect.any(Object));
    expect(body).toEqual({ accessToken: 'access-2', expiresIn: 900 });
  });

  it('passes a null csrf when the header is absent', async () => {
    const { controller, authService } = build();
    await controller.refresh(
      makeReq({ cookies: { refresh_token: 'refresh-1' } }),
      makeReply() as never,
    );
    expect(authService.refresh).toHaveBeenCalledWith('refresh-1', null, '203.0.113.7');
  });
});

describe('AuthController logout', () => {
  it('logout revokes the session and clears both cookies', async () => {
    const { controller, authService } = build();
    const reply = makeReply();
    const user = makePayload();

    await controller.logout(user, reply as never);

    expect(authService.logout).toHaveBeenCalledWith(user);
    expect(reply.clearCookie).toHaveBeenCalledWith('refresh_token', { path: '/v1/auth' });
    expect(reply.clearCookie).toHaveBeenCalledWith('csrf_token', { path: '/' });
  });

  it('logout-all revokes every session and clears cookies', async () => {
    const { controller, authService } = build();
    const reply = makeReply();
    const user = makePayload();

    await controller.logoutAll(user, reply as never);

    expect(authService.logoutAll).toHaveBeenCalledWith(user);
    expect(reply.clearCookie).toHaveBeenCalledTimes(2);
  });
});

describe('AuthController profile', () => {
  it('getMe merges profile, role/permissions and memberships', async () => {
    const { controller } = build({ role: 'workspace_admin', permissions: ['workspace:*'] });
    const dto = await controller.getMe(makePayload());

    expect(dto).toMatchObject({
      id: 'user-1',
      role: 'workspace_admin',
      permissions: ['workspace:*'],
      emailVerified: true,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      memberships: [],
    });
  });

  it('updateProfile applies the patch and returns the enriched profile', async () => {
    const { controller, authService } = build();
    const dto = await controller.updateProfile(makePayload(), {
      displayName: 'Alice Renamed',
    } as never);

    expect(authService.updateProfile).toHaveBeenCalledWith('user-1', {
      displayName: 'Alice Renamed',
    });
    expect(dto.displayName).toBe('Alice Renamed');
  });
});
