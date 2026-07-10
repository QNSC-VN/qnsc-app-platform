/**
 * Access-token minting for the identity bounded context.
 *
 * Behaviour-preserving port of rally's `AuthService.signAccessToken` and the
 * `parseDurationToSeconds` platform util. The signer is injected structurally
 * (`sign`) so this module stays free of any concrete JWT library — a product
 * passes its configured `JwtService.sign` (ES256 key + issuer/audience).
 */
import { uuidv7 } from 'uuidv7';
import type { ProductClaims } from './claims-provider';
import type { JwtPayload } from './jwt-payload';

/**
 * Parse a duration string (`'900'`, `'15m'`, `'8h'`, `'30d'`) into seconds.
 * A bare number is treated as seconds. Throws on an unparseable string.
 */
export function parseDurationToSeconds(duration: string): number {
  const match = /^(\d+)\s*(s|m|h|d)?$/.exec(duration.trim());
  if (!match) {
    throw new Error(`Invalid duration string: "${duration}"`);
  }
  const value = Number(match[1]);
  switch (match[2]) {
    case 'd':
      return value * 24 * 60 * 60;
    case 'h':
      return value * 60 * 60;
    case 'm':
      return value * 60;
    case 's':
    case undefined:
    default:
      return value;
  }
}

/** Claims the caller supplies; `iss`/`aud`/`iat`/`exp` are added by the signer. */
export type AccessTokenClaims = Omit<JwtPayload, 'iat' | 'exp' | 'iss' | 'aud'>;

export interface SignAccessTokenParams {
  userId: string;
  workspaceId: string;
  sessionId: string;
  claims: ProductClaims;
  authMethod: 'password' | 'sso';
}

export interface SignedAccessToken {
  accessToken: string;
  /** The token's unique id (also embedded as the `jti` claim). */
  jti: string;
  /** Seconds until expiry, kept in lock-step with the signer's configured TTL. */
  expiresIn: number;
}

/**
 * Build and sign an access token.
 *
 * @param sign - the product's JWT signer, e.g. nest's `JwtService.sign` bound
 * with the ES256 key, issuer, and audience.
 * @param accessExpiry - the signer's configured access-token TTL (e.g. `'15m'`),
 * mirrored into {@link SignedAccessToken.expiresIn}.
 */
export function signAccessToken(
  sign: (payload: AccessTokenClaims) => string,
  accessExpiry: string,
  params: SignAccessTokenParams,
): SignedAccessToken {
  const jti = uuidv7();
  const expiresIn = parseDurationToSeconds(accessExpiry);
  const payload: AccessTokenClaims = {
    sub: params.userId,
    workspaceId: params.workspaceId,
    sessionId: params.sessionId,
    jti,
    claims: params.claims,
    authMethod: params.authMethod,
  };
  const accessToken = sign(payload);
  return { accessToken, jti, expiresIn };
}
