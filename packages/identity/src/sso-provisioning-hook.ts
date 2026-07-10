/**
 * The optional `ISsoProvisioningHook` port — a product-supplied callback the
 * shared `AuthService` invokes during SSO login, right after the user is
 * resolved/provisioned and **before** the authorization claims are read.
 *
 * The core owns authentication (Entra verification, sessions, JWT minting) but
 * is deliberately ignorant of a product's authorization model. Some products
 * must reconcile provider-supplied authorization data at login time — e.g.
 * opshub maps the Entra **App Roles** claim onto its own RBAC role assignments
 * so the freshly-synced roles are what {@link IClaimsProvider} then stamps into
 * the token. This hook is that seam.
 *
 * It is **optional**: a product that has nothing to reconcile (rally resolves
 * authorization from workspace memberships) simply does not bind it, and the
 * core skips the call.
 */
import type { EntraClaims } from './entra-verifier';
import type { User } from './domain-types';

/** Context passed to {@link ISsoProvisioningHook.onUserProvisioned}. */
export interface SsoProvisioningContext {
  /** The verified Entra ID claims for this login, including the App Roles claim. */
  entra: EntraClaims;
  /**
   * The authorization context the session is being minted for — the resolved
   * workspace id for multi-tenant products (rally), or `null` for single-tenant
   * products (opshub).
   */
  contextId: string | null;
}

/** DI token for {@link ISsoProvisioningHook}. */
export const SSO_PROVISIONING_HOOK = Symbol('SSO_PROVISIONING_HOOK');

/**
 * Reconciles provider-supplied authorization data at SSO-login time. Invoked
 * after the user is resolved and before claims are read, so any roles/grants it
 * writes are reflected in the minted token.
 */
export interface ISsoProvisioningHook {
  /**
   * Called once per SSO login for the resolved `user`. Implementations should be
   * idempotent (a user logs in repeatedly). Throwing aborts the login.
   */
  onUserProvisioned(user: User, context: SsoProvisioningContext): Promise<void>;
}
