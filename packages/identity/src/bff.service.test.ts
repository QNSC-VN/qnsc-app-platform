import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type BffOptions } from './bff-options';
import { BffService } from './bff.service';
import type { BffSessionStore } from './bff-session.store';
import type { EntraOidcClient } from './entra-oidc.client';
import type { AuthService } from './auth.service';

function makeToken(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'ES256' })}.${b64(payload)}.sig`;
}

/** An access token expiring `secondsFromNow` from now. */
function accessToken(secondsFromNow: number, extra: Record<string, unknown> = {}): string {
  return makeToken({
    sub: 'user-1',
    contextId: 'ws-1',
    sessionId: 'sess-1',
    jti: 'jti-1',
    exp: Math.floor(Date.now() / 1000) + secondsFromNow,
    claims: { permissions: ['p1'] },
    ...extra,
  });
}

function makeOptions(nodeEnv?: string): BffOptions {
  return {
    nodeEnv,
    postLoginRedirect: '/home',
    sessionTtlSeconds: 3600,
    entra: {
      tenantId: 'tenant-1',
      clientId: 'client-1',
      clientSecret: 'secret-1',
      redirectUri: 'https://app/callback',
    },
  };
}

describe('BffService', () => {
  let oidc: { buildAuthorizeUrl: ReturnType<typeof vi.fn>; exchangeCode: ReturnType<typeof vi.fn> };
  let store: {
    saveAuthRequest: ReturnType<typeof vi.fn>;
    takeAuthRequest: ReturnType<typeof vi.fn>;
    saveSession: ReturnType<typeof vi.fn>;
    getSession: ReturnType<typeof vi.fn>;
    deleteSession: ReturnType<typeof vi.fn>;
  };
  let authService: {
    ssoLogin: ReturnType<typeof vi.fn>;
    refresh: ReturnType<typeof vi.fn>;
    switchWorkspace: ReturnType<typeof vi.fn>;
    logout: ReturnType<typeof vi.fn>;
    devLogin: ReturnType<typeof vi.fn>;
  };
  let service: BffService;

  function build(options: BffOptions): BffService {
    return new BffService(
      options,
      oidc as unknown as EntraOidcClient,
      store as unknown as BffSessionStore,
      authService as unknown as AuthService,
    );
  }

  beforeEach(() => {
    oidc = {
      buildAuthorizeUrl: vi.fn().mockReturnValue('https://entra/authorize'),
      exchangeCode: vi.fn(),
    };
    store = {
      saveAuthRequest: vi.fn().mockResolvedValue(undefined),
      takeAuthRequest: vi.fn(),
      saveSession: vi.fn().mockResolvedValue(undefined),
      getSession: vi.fn(),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    };
    authService = {
      ssoLogin: vi.fn(),
      refresh: vi.fn(),
      switchWorkspace: vi.fn(),
      logout: vi.fn().mockResolvedValue(undefined),
      devLogin: vi.fn(),
    };
    service = build(makeOptions());
  });

  describe('enabled', () => {
    it('is always true (BFF is the only auth mode)', () => {
      expect(service.enabled).toBe(true);
    });
  });

  describe('beginLogin', () => {
    it('persists a PKCE auth request and returns the authorize URL', async () => {
      const result = await service.beginLogin('/projects/1');

      expect(store.saveAuthRequest).toHaveBeenCalledTimes(1);
      const saved = store.saveAuthRequest.mock.calls[0][0];
      expect(saved.state).toBe(result.state);
      expect(saved.codeVerifier).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(saved.returnTo).toBe('/projects/1');
      expect(result.authorizeUrl).toBe('https://entra/authorize');
    });

    it('falls back to the configured redirect for an unsafe returnTo', async () => {
      await service.beginLogin('https://evil.com');
      expect(store.saveAuthRequest.mock.calls[0][0].returnTo).toBe('/home');
    });
  });

  describe('completeLogin', () => {
    it('rejects when the cookie state does not match', async () => {
      await expect(
        service.completeLogin({ code: 'c', state: 's1', cookieState: 's2', ip: '1.1.1.1' }),
      ).rejects.toThrow(/state does not match/);
      expect(store.takeAuthRequest).not.toHaveBeenCalled();
    });

    it('rejects when the stored auth request is missing/replayed', async () => {
      store.takeAuthRequest.mockResolvedValue(null);
      await expect(
        service.completeLogin({ code: 'c', state: 's', cookieState: 's', ip: '1.1.1.1' }),
      ).rejects.toThrow(/not found or already used/);
    });

    it('exchanges the code, runs SSO login, and stores a session', async () => {
      store.takeAuthRequest.mockResolvedValue({
        state: 's',
        codeVerifier: 'verifier',
        returnTo: '/dashboard',
        createdAt: Date.now(),
      });
      oidc.exchangeCode.mockResolvedValue({ idToken: 'id-token' });
      authService.ssoLogin.mockResolvedValue({
        accessToken: accessToken(900),
        refreshToken: 'refresh-1',
        csrfToken: 'csrf-1',
        expiresIn: 900,
      });

      const result = await service.completeLogin({
        code: 'c',
        state: 's',
        cookieState: 's',
        ip: '9.9.9.9',
      });

      expect(oidc.exchangeCode).toHaveBeenCalledWith({ code: 'c', codeVerifier: 'verifier' });
      expect(authService.ssoLogin).toHaveBeenCalledWith('id-token', '9.9.9.9');
      expect(store.saveSession).toHaveBeenCalledTimes(1);
      const [sid, session, ttl] = store.saveSession.mock.calls[0];
      expect(sid).toBe(result.sid);
      expect(session.refreshToken).toBe('refresh-1');
      expect(session.claims.contextId).toBe('ws-1');
      expect(ttl).toBe(3600);
      expect(result.returnTo).toBe('/dashboard');
    });
  });

  describe('devLogin', () => {
    it('devLoginAllowed is true outside production, false in production', () => {
      expect(service.devLoginAllowed).toBe(true);
      expect(build(makeOptions('production')).devLoginAllowed).toBe(false);
    });

    it('mints a session from a seeded email and returns the sid', async () => {
      authService.devLogin.mockResolvedValue({
        accessToken: accessToken(900),
        refreshToken: 'refresh-dev',
        csrfToken: 'csrf-dev',
        expiresIn: 900,
      });

      const sid = await service.devLogin('qa@acme.dev', '3.3.3.3');

      expect(authService.devLogin).toHaveBeenCalledWith('qa@acme.dev', '3.3.3.3');
      expect(store.saveSession).toHaveBeenCalledTimes(1);
      const [savedSid, session, ttl] = store.saveSession.mock.calls[0];
      expect(savedSid).toBe(sid);
      expect(session.refreshToken).toBe('refresh-dev');
      expect(session.claims.contextId).toBe('ws-1');
      expect(ttl).toBe(3600);
    });
  });

  describe('resolve', () => {
    it('returns null when the session is absent', async () => {
      store.getSession.mockResolvedValue(null);
      expect(await service.resolve('sid', '1.1.1.1')).toBeNull();
    });

    it('returns cached claims without refreshing when the token is fresh', async () => {
      store.getSession.mockResolvedValue({
        claims: { sub: 'user-1', contextId: 'ws-1' },
        accessToken: 'a',
        refreshToken: 'r',
        csrfToken: 'c',
        accessTokenExpiresAt: Date.now() + 5 * 60_000,
        createdAt: Date.now(),
      });

      const claims = await service.resolve('sid', '1.1.1.1');
      expect(claims).toEqual({ sub: 'user-1', contextId: 'ws-1' });
      expect(authService.refresh).not.toHaveBeenCalled();
    });

    it('rotates the access token and persists when near expiry', async () => {
      store.getSession.mockResolvedValue({
        claims: { sub: 'user-1', contextId: 'ws-1' },
        accessToken: 'old',
        refreshToken: 'refresh-old',
        csrfToken: 'csrf-old',
        accessTokenExpiresAt: Date.now() + 1_000, // within skew window
        createdAt: Date.now(),
      });
      authService.refresh.mockResolvedValue({
        accessToken: accessToken(900, { contextId: 'ws-2' }),
        refreshToken: 'refresh-new',
        csrfToken: 'csrf-new',
        expiresIn: 900,
      });

      const claims = await service.resolve('sid', '2.2.2.2');

      expect(authService.refresh).toHaveBeenCalledWith('refresh-old', 'csrf-old', '2.2.2.2');
      expect(store.saveSession).toHaveBeenCalledTimes(1);
      expect(claims?.contextId).toBe('ws-2');
    });

    it('drops the session and returns null when refresh fails', async () => {
      store.getSession.mockResolvedValue({
        claims: { sub: 'user-1', contextId: 'ws-1' },
        accessToken: 'old',
        refreshToken: 'refresh-old',
        csrfToken: 'csrf-old',
        accessTokenExpiresAt: Date.now() - 1_000,
        createdAt: Date.now(),
      });
      authService.refresh.mockRejectedValue(new Error('rotation reuse'));

      expect(await service.resolve('sid', '1.1.1.1')).toBeNull();
      expect(store.deleteSession).toHaveBeenCalledWith('sid');
    });
  });

  describe('logout', () => {
    it('revokes the auth session and deletes the BFF session', async () => {
      const principal = { sub: 'user-1' } as never;
      await service.logout('sid', principal);
      expect(authService.logout).toHaveBeenCalledWith(principal);
      expect(store.deleteSession).toHaveBeenCalledWith('sid');
    });
  });

  describe('switchWorkspace', () => {
    it('returns null when the session is absent', async () => {
      store.getSession.mockResolvedValue(null);
      expect(await service.switchWorkspace('sid', 'ws-2', '1.1.1.1')).toBeNull();
      expect(authService.switchWorkspace).not.toHaveBeenCalled();
    });

    it('re-issues tokens for the target workspace and persists them on the same session', async () => {
      store.getSession.mockResolvedValue({
        claims: { sub: 'user-1', contextId: 'ws-1' },
        accessToken: 'old',
        refreshToken: 'refresh-old',
        csrfToken: 'csrf-old',
        accessTokenExpiresAt: Date.now() + 5 * 60_000,
        createdAt: Date.now(),
      });
      authService.switchWorkspace.mockResolvedValue({
        accessToken: accessToken(900, { contextId: 'ws-2' }),
        refreshToken: 'refresh-new',
        csrfToken: 'csrf-new',
        expiresIn: 900,
      });

      const claims = await service.switchWorkspace('sid', 'ws-2', '2.2.2.2');

      expect(authService.switchWorkspace).toHaveBeenCalledWith(
        { sub: 'user-1', contextId: 'ws-1' },
        'ws-2',
        '2.2.2.2',
      );
      expect(store.saveSession).toHaveBeenCalledTimes(1);
      const [sid, session, ttl] = store.saveSession.mock.calls[0];
      expect(sid).toBe('sid');
      expect(session.refreshToken).toBe('refresh-new');
      expect(ttl).toBe(3600);
      expect(claims?.contextId).toBe('ws-2');
    });
  });
});
