import { describe, expect, it } from 'vitest';
import { decodeAccessTokenClaims, isSafeReturnTo, readCookie } from './bff.util';

/** Build a JWT-shaped token with the given payload (signature is irrelevant here). */
function makeToken(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'ES256', typ: 'JWT' })}.${b64(payload)}.signature`;
}

describe('isSafeReturnTo', () => {
  it('accepts root-relative same-origin paths', () => {
    expect(isSafeReturnTo('/')).toBe(true);
    expect(isSafeReturnTo('/projects/42')).toBe(true);
    expect(isSafeReturnTo('/a?b=c#d')).toBe(true);
  });

  it('rejects absent, absolute, protocol-relative, and backslash values', () => {
    expect(isSafeReturnTo(undefined)).toBe(false);
    expect(isSafeReturnTo(null)).toBe(false);
    expect(isSafeReturnTo('')).toBe(false);
    expect(isSafeReturnTo('https://evil.com')).toBe(false);
    expect(isSafeReturnTo('//evil.com')).toBe(false);
    expect(isSafeReturnTo('/\\evil.com')).toBe(false);
    expect(isSafeReturnTo('relative/path')).toBe(false);
  });
});

describe('readCookie', () => {
  it('returns the named cookie when present', () => {
    expect(readCookie({ cookies: { foo: 'bar' } }, 'foo')).toBe('bar');
  });

  it('returns undefined when the bag is missing or the key is absent', () => {
    expect(readCookie({}, 'foo')).toBeUndefined();
    expect(readCookie({ cookies: {} }, 'foo')).toBeUndefined();
  });
});

describe('decodeAccessTokenClaims', () => {
  it('decodes the access-token payload verbatim into JwtPayload', () => {
    const token = makeToken({
      sub: 'user-1',
      contextId: 'ws-9',
      sessionId: 'sess-1',
      jti: 'jti-1',
      exp: 1234,
      claims: { permissions: ['work_item:read', 'work_item:write'] },
    });

    const claims = decodeAccessTokenClaims(token);

    expect(claims.sub).toBe('user-1');
    expect(claims.contextId).toBe('ws-9');
    expect(claims.sessionId).toBe('sess-1');
    expect(claims.exp).toBe(1234);
    expect(claims.claims).toEqual({ permissions: ['work_item:read', 'work_item:write'] });
  });

  it('preserves a null context scope', () => {
    const token = makeToken({ sub: 'user-2', contextId: null, claims: {} });
    const claims = decodeAccessTokenClaims(token);
    expect(claims.contextId).toBeNull();
    expect(claims.claims).toEqual({});
  });

  it('throws on a malformed token', () => {
    expect(() => decodeAccessTokenClaims('not-a-jwt')).toThrow();
  });
});
