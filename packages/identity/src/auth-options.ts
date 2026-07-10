/**
 * Configuration **options** for the shared `AuthService`.
 *
 * rally's `AuthService` reads these off its `AppConfigService`; the shared
 * service must not depend on a product's config layer, so each product resolves
 * them and binds the value to {@link AUTH_SERVICE_OPTIONS}, e.g.
 * `{ provide: AUTH_SERVICE_OPTIONS, useFactory: (c: AppConfigService) => ({ ... }) }`.
 */

/** DI token carrying the resolved {@link AuthServiceOptions}. */
export const AUTH_SERVICE_OPTIONS = Symbol('AUTH_SERVICE_OPTIONS');

export interface AuthServiceOptions {
  /**
   * Access-token TTL, e.g. `'15m'`. Must mirror the JWT signer's configured
   * `expiresIn` so the client-facing `expiresIn` can never desync from the JWT.
   */
  jwtAccessExpiry: string;
  /** Refresh-token TTL, e.g. `'30d'`. */
  jwtRefreshExpiry: string;
  /** Emails auto-elevated to workspace_admin on every SSO login. */
  platformAdminEmails: string[];
  /** Runtime environment (e.g. `'production'`); gates dev-login. */
  nodeEnv?: string;
}
