import type { ProductClaims } from './claims-provider';

/**
 * Decoded access-token claims attached to `request.user` after JWT verification.
 */
export interface JwtPayload {
  /** Subject = userId */
  sub: string;
  /**
   * Authorization context scope carried in the token. For a multi-tenant product
   * (rally) this is the active workspace id; for a single-tenant product (opshub)
   * it is `null`. The core treats it as an opaque scope — products interpret it.
   */
  contextId: string | null;
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
