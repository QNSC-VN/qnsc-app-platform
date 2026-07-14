/**
 * Configuration **options** for the shared Backend-for-Frontend (BFF) auth
 * mechanism.
 *
 * The BFF runs the Microsoft Entra ID Authorization-Code + PKCE flow
 * server-side and mints an opaque server-side session, so the browser never
 * holds real tokens. Like {@link AuthServiceOptions}, these values live in each
 * product's own config layer; the shared code must not depend on it, so each
 * product resolves them and binds the value to {@link BFF_OPTIONS}, e.g.
 * `{ provide: BFF_OPTIONS, useFactory: (c: AppConfigService) => ({ ... }) }`.
 */

/** DI token carrying the resolved {@link BffOptions}. */
export const BFF_OPTIONS = Symbol('BFF_OPTIONS');

/** Microsoft Entra ID OIDC client configuration for the BFF login flow. */
export interface BffEntraOptions {
  /** Entra tenant id — segments the authorize/token endpoints. */
  tenantId: string;
  /** Confidential-client application (client) id. */
  clientId: string;
  /** Confidential-client secret, used only server-side in the token exchange. */
  clientSecret: string;
  /** Registered redirect URI Entra returns the authorization code to. */
  redirectUri: string;
  /**
   * OIDC authority (host) base URL that fronts the tenant-segmented
   * authorize/token endpoints. Defaults to Microsoft's global cloud
   * (`https://login.microsoftonline.com`). Override it — e.g. to a local mock
   * OIDC server — to exercise the full login flow end-to-end in tests or a
   * sovereign/national cloud (`https://login.microsoftonline.us`). No trailing
   * slash.
   */
  authority?: string;
}

/** Resolved options for the shared BFF mechanism. */
export interface BffOptions {
  /**
   * Runtime environment (e.g. `'production'`); gates the passwordless
   * dev-login shortcut, which is disabled whenever this is `'production'`.
   */
  nodeEnv?: string;
  /**
   * Default same-origin path to land on after login, used when the browser's
   * `returnTo` is absent or fails the open-redirect guard.
   */
  postLoginRedirect: string;
  /**
   * Server-side session lifetime in seconds; also used as the session cookie's
   * `Max-Age` by the product's BFF controller.
   */
  sessionTtlSeconds: number;
  /** Microsoft Entra ID OIDC client configuration. */
  entra: BffEntraOptions;
}
