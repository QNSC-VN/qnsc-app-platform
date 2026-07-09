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
   * Effective permission codes for this user, embedded at token-mint time.
   * Refreshed on every token rotation so stale permissions are bounded by
   * the access-token TTL (default 15 min).
   */
  permissions: string[];
  /**
   * How the session was originally established.
   * 'sso': via Entra ID — frontend must re-validate with MSAL on each refresh cycle.
   * 'password': credential-based — standard refresh rotation.
   */
  authMethod: 'password' | 'sso';
}
