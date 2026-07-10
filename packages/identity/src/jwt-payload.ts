import type { ProductClaims } from './claims-provider';

/**
 * Decoded access-token claims attached to `request.user` after JWT verification.
 */
export interface JwtPayload {
  /** Subject = userId */
  sub: string;
  workspaceId: string;
  sessionId: string;
  jti: string;
  iss: string;
  aud: string | string[];
  iat: number;
  exp: number;
  /**
   * Product-defined authorization claims embedded at token-mint time, sourced
   * from the product's {@link IClaimsProvider} (rally: `{ permissions }`,
   * opshub: `{ roles }`). Refreshed on every token rotation so stale claims are
   * bounded by the access-token TTL (default 15 min).
   */
  claims: ProductClaims;
  /**
   * How the session was originally established.
   * 'sso': via Entra ID — frontend must re-validate with MSAL on each refresh cycle.
   * 'password': credential-based — standard refresh rotation.
   */
  authMethod: 'password' | 'sso';
}
