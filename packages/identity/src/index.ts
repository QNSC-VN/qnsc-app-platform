/**
 * `@qnsc/identity`
 *
 * Shared identity/auth for QNSC product backends: JWT (ES256) strategy and
 * guards, single-use refresh-token rotation with family theft-detection, CSRF,
 * SSO/Entra token validation, and the BFF (Backend-For-Frontend) session
 * handlers that the products converge on.
 *
 * The concrete implementation is extracted from the product repos in **Phase 2**
 * of the Identity Platform Migration Plan, and the BFF handlers are added behind
 * a feature flag in later phases. This Phase 1 skeleton exists to establish the
 * publishable package and its release pipeline.
 */
export const PACKAGE_NAME = '@qnsc/identity';
