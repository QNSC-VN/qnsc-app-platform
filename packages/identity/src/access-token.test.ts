import { describe, expect, it, vi } from 'vitest';
import { parseDurationToSeconds, signAccessToken, type AccessTokenClaims } from './access-token';

describe('parseDurationToSeconds', () => {
  it('treats a bare number as seconds', () => {
    expect(parseDurationToSeconds('900')).toBe(900);
  });

  it('parses s/m/h/d units', () => {
    expect(parseDurationToSeconds('30s')).toBe(30);
    expect(parseDurationToSeconds('15m')).toBe(900);
    expect(parseDurationToSeconds('8h')).toBe(8 * 3600);
    expect(parseDurationToSeconds('30d')).toBe(30 * 86400);
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseDurationToSeconds('  15m ')).toBe(900);
  });

  it('throws on an unparseable string', () => {
    expect(() => parseDurationToSeconds('soon')).toThrow(/Invalid duration/);
  });
});

describe('signAccessToken', () => {
  it('builds the claim set, delegates signing, and mirrors the TTL', () => {
    const sign = vi.fn((_payload: AccessTokenClaims) => 'signed.jwt.token');

    const result = signAccessToken(sign, '15m', {
      userId: 'u1',
      workspaceId: 'w1',
      sessionId: 's1',
      permissions: ['project:read'],
      authMethod: 'sso',
    });

    expect(result.accessToken).toBe('signed.jwt.token');
    expect(result.expiresIn).toBe(900);
    expect(result.jti).toMatch(/^[0-9a-f-]{36}$/);

    expect(sign).toHaveBeenCalledTimes(1);
    const payload = sign.mock.calls[0][0];
    expect(payload).toEqual({
      sub: 'u1',
      workspaceId: 'w1',
      sessionId: 's1',
      jti: result.jti,
      permissions: ['project:read'],
      authMethod: 'sso',
    });
  });

  it('generates a distinct jti per call', () => {
    const sign = vi.fn(() => 't');
    const a = signAccessToken(sign, '900', {
      userId: 'u',
      workspaceId: 'w',
      sessionId: 's',
      permissions: [],
      authMethod: 'password',
    });
    const b = signAccessToken(sign, '900', {
      userId: 'u',
      workspaceId: 'w',
      sessionId: 's',
      permissions: [],
      authMethod: 'password',
    });
    expect(a.jti).not.toBe(b.jti);
  });
});
