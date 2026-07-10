import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const { jwtVerifyMock, createRemoteJWKSetMock } = vi.hoisted(() => ({
  jwtVerifyMock: vi.fn(),
  createRemoteJWKSetMock: vi.fn(() => 'JWKS_KEYSET'),
}));

vi.mock('jose', () => ({
  jwtVerify: jwtVerifyMock,
  createRemoteJWKSet: createRemoteJWKSetMock,
}));

import { generateRefreshToken, hashToken, parseTtlSeconds } from './refresh-token';
import {
  EntraTokenVerifier,
  SsoVerificationError,
  type EntraVerifierOptions,
} from './entra-verifier';

describe('refresh-token crypto', () => {
  it('generateRefreshToken returns a base64url token, its sha256 hash and a family id', () => {
    const a = generateRefreshToken();
    expect(a.refreshToken).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.tokenHash).toBe(hashToken(a.refreshToken));
    expect(a.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.familyId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('generateRefreshToken is unique per call', () => {
    const a = generateRefreshToken();
    const b = generateRefreshToken();
    expect(a.refreshToken).not.toBe(b.refreshToken);
    expect(a.familyId).not.toBe(b.familyId);
  });

  it('hashToken is a deterministic sha256 hex digest', () => {
    expect(hashToken('hello')).toBe(hashToken('hello'));
    expect(hashToken('a')).not.toBe(hashToken('b'));
  });

  it('parseTtlSeconds parses s/m/h/d units', () => {
    expect(parseTtlSeconds('45s', 1)).toBe(45);
    expect(parseTtlSeconds('15m', 1)).toBe(15 * 60);
    expect(parseTtlSeconds('12h', 1)).toBe(12 * 3600);
    expect(parseTtlSeconds('30d', 1)).toBe(30 * 86400);
  });

  it('parseTtlSeconds falls back on malformed input', () => {
    expect(parseTtlSeconds('', 99)).toBe(99);
    expect(parseTtlSeconds('30', 99)).toBe(99);
    expect(parseTtlSeconds('lots', 99)).toBe(99);
  });
});

describe('EntraTokenVerifier', () => {
  const baseOptions: EntraVerifierOptions = { tenantId: 'tenant-1', clientId: 'client-1' };

  const makeVerifier = (opts: Partial<EntraVerifierOptions> = {}) =>
    new EntraTokenVerifier({ ...baseOptions, ...opts });

  beforeEach(() => {
    jwtVerifyMock.mockReset();
    createRemoteJWKSetMock.mockClear();
  });

  it('throws SSO_NOT_CONFIGURED when tenant/client are missing', async () => {
    const verifier = makeVerifier({ tenantId: '', clientId: '' });
    await expect(verifier.verify('tok')).rejects.toMatchObject({
      code: 'SSO_NOT_CONFIGURED',
    });
    expect(jwtVerifyMock).not.toHaveBeenCalled();
  });

  it('verifies against the tenant JWKS + issuers and returns normalized claims', async () => {
    jwtVerifyMock.mockResolvedValue({
      payload: { oid: 'oid-1', email: '  User@Example.COM ', name: 'User One', tid: 'ext-9' },
    });
    const verifier = makeVerifier();

    const claims = await verifier.verify('id-token');

    expect(claims).toEqual({
      oid: 'oid-1',
      email: 'user@example.com',
      displayName: 'User One',
      externalTenantId: 'ext-9',
      roles: [],
    });
    expect(createRemoteJWKSetMock).toHaveBeenCalledWith(
      new URL('https://login.microsoftonline.com/tenant-1/discovery/v2.0/keys'),
    );
    expect(jwtVerifyMock).toHaveBeenCalledWith('id-token', 'JWKS_KEYSET', {
      issuer: [
        'https://login.microsoftonline.com/tenant-1/v2.0',
        'https://sts.windows.net/tenant-1/',
      ],
      audience: 'client-1',
    });
  });

  it('falls back email to preferred_username then upn, and displayName to email', async () => {
    jwtVerifyMock.mockResolvedValue({
      payload: { oid: 'oid-2', preferred_username: 'pref@example.com', tid: 'ext-1' },
    });
    const claims = await makeVerifier().verify('t');
    expect(claims.email).toBe('pref@example.com');
    expect(claims.displayName).toBe('pref@example.com');
  });

  it('parses App Role values from the token roles claim, ignoring non-strings', async () => {
    jwtVerifyMock.mockResolvedValue({
      payload: {
        oid: 'oid-3',
        email: 'r@example.com',
        tid: 'ext-2',
        roles: ['it-admin', 'asset-manager', 42, null],
      },
    });
    const claims = await makeVerifier().verify('t');
    expect(claims.roles).toEqual(['it-admin', 'asset-manager']);
  });

  it('throws SSO_TOKEN_INVALID when jose verification fails', async () => {
    jwtVerifyMock.mockRejectedValue(new Error('bad signature'));
    await expect(makeVerifier().verify('t')).rejects.toMatchObject({
      code: 'SSO_TOKEN_INVALID',
    });
  });

  it('throws SSO_CLAIMS_MISSING when oid or email are absent', async () => {
    jwtVerifyMock.mockResolvedValue({ payload: { email: 'x@example.com' } });
    await expect(makeVerifier().verify('t')).rejects.toBeInstanceOf(SsoVerificationError);
    await expect(makeVerifier().verify('t')).rejects.toMatchObject({
      code: 'SSO_CLAIMS_MISSING',
    });
  });

  it('uses an injected jwksResolver and custom issuers when provided', async () => {
    const customResolver = vi.fn(() => 'CUSTOM_KEYSET');
    jwtVerifyMock.mockResolvedValue({ payload: { oid: 'o', email: 'e@e.com', tid: null } });
    const verifier = makeVerifier({ jwksResolver: customResolver, issuers: ['iss-x'] });

    const claims = await verifier.verify('t');

    expect(customResolver).toHaveBeenCalledOnce();
    expect(createRemoteJWKSetMock).not.toHaveBeenCalled();
    expect(jwtVerifyMock).toHaveBeenCalledWith('t', 'CUSTOM_KEYSET', {
      issuer: ['iss-x'],
      audience: 'client-1',
    });
    expect(claims.externalTenantId).toBeNull();
  });
});
