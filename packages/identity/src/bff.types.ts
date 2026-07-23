import type { JwtPayload } from './jwt-payload';

/**
 * A pending OIDC authorization request, persisted server-side between
 * `GET /bff/login` and `GET /bff/callback`. The PKCE `codeVerifier` never
 * leaves the server; only the (unguessable, single-use) `state` round-trips
 * through the browser and Entra.
 */
export interface BffAuthRequest {
  /** CSRF/replay guard echoed back by Entra; also the store key. */
  state: string;
  /** PKCE code_verifier — proves this backend started the flow. */
  codeVerifier: string;
  /** Validated same-origin path to land on after login completes. */
  returnTo: string;
  /** Epoch ms the request was created (for observability / expiry sanity). */
  createdAt: number;
  /**
   * OIDC `nonce` bound to this request (multi-IdP broker path). Verified against
   * the id_token on callback. Absent on the legacy home flow.
   */
  nonce?: string;
  /**
   * Resolved connection id (multi-IdP broker path). Present ⇒ the callback
   * routes through the generic client/verifier for this connection. Absent ⇒
   * the legacy home (Entra) path.
   */
  connectionId?: string;
}

/**
 * A server-side BFF session. This is the entire reason the pattern exists: the
 * refresh token, CSRF token, and product access token live here in Valkey —
 * never in the browser, which only ever holds the opaque session id in a
 * `__Host-` cookie. `claims` is the decoded access-token principal, cached so
 * each request avoids re-decoding; it is refreshed in lock-step with
 * `accessToken`.
 */
export interface BffSession {
  /** Decoded access-token principal ({@link JwtPayload}). */
  claims: JwtPayload;
  /** Current product access token (JWT). Rotated transparently near expiry. */
  accessToken: string;
  /** Current refresh token — used server-side to rotate `accessToken`. */
  refreshToken: string;
  /** CSRF token paired with the refresh token, required by `AuthService.refresh`. */
  csrfToken: string;
  /** Epoch ms at which `accessToken` expires (from its `exp` claim). */
  accessTokenExpiresAt: number;
  /** Epoch ms the session was first established. */
  createdAt: number;
}
