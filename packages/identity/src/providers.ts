import { decodeJwt } from 'jose';
import { google } from 'better-auth/social-providers';
import { refuseCallbackWith } from './callback-errors';
import { emailInDomains } from './domains';

export interface StaffOptions {
  /** The QNSC Entra tenant id. */
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** Email domain(s) of staff: password sign-up is refused for them (ADR 0002, decision 2). */
  domains: string[];
  /**
   * May B2B GUESTS of the tenant sign in? Product policy, default `false` (ADR 0002, decision 3):
   * rova sets `true` for vendors; opshub keeps `false`.
   */
  allowGuests?: boolean;
  /** Only for tests or a sovereign cloud. Default `https://login.microsoftonline.com`. */
  authority?: string;
}

export interface GoogleOptions {
  clientId: string;
  clientSecret: string;
}

/** Called with an address a provider has just asserted as verified. */
export type VerifiedEmailHook = (email: string) => Promise<unknown>;

/** The existing account for an address, if any, with the provider ids and account ids it holds. */
export type AccountLookup = (
  email: string,
) => Promise<{ accounts: Array<{ providerId: string; accountId: string }> } | null>;

/**
 * Whether an Entra id_token is for a B2B guest. Entra marks guests in more than one way depending on
 * the app registration's optional claims, so any of them counts: `acct = 1`, an `idp` claim naming a
 * different issuer than the token's, or `#EXT#` in the user principal name. (Manual check M1 in
 * ADR 0002 confirms which of these the QNSC tenant emits.)
 */
export function isEntraGuest(claims: Record<string, unknown>): boolean {
  if (claims['acct'] === 1 || claims['acct'] === '1') return true;
  const idp = claims['idp'];
  if (typeof idp === 'string' && idp !== claims['iss']) return true;
  return [claims['upn'], claims['preferred_username']].some(
    (v) => typeof v === 'string' && v.includes('#EXT#'),
  );
}

/**
 * Microsoft provider for the staff preset. It replaces Better Auth's `getUserInfo` for these reasons
 * (WP-9 D12, review S3): the default asks for `User.Read` and fetches a Graph photo; in the code flow it
 * never checks `tid`; it knows nothing of B2B guests; and it would link an Entra identity to ANY
 * existing account with the same email.
 *
 * - A tenant MEMBER is accepted only with an email whose domain is in `staff.domains`; anything else
 *   (a member whose mailbox is on another domain, a mail alias, an unexpected claim) returns `null`, so no
 *   account is created or linked on an address the company does not own. The squatting rule runs for
 *   members only.
 * - A GUEST (when `allowGuests`) never auto-links: if the address belongs to an existing account that
 *   does not already hold THIS Entra identity, the sign-in is refused with `ACCOUNT_LINK_REQUIRED`.
 *   Guests are created with an unverified email, so Better Auth refuses to link them even in a race.
 *
 * Returning `null` ends the callback with an error redirect and writes nothing.
 */
export function microsoftProvider(
  staff: StaffOptions,
  hooks: { onVerifiedEmail: VerifiedEmailHook; lookup: AccountLookup },
) {
  return {
    clientId: staff.clientId,
    clientSecret: staff.clientSecret,
    tenantId: staff.tenantId,
    ...(staff.authority ? { authority: staff.authority } : {}),
    disableDefaultScope: true,
    scope: ['openid', 'profile', 'email'],
    disableProfilePhoto: true,
    getUserInfo: async (token: { idToken?: string | undefined }) => {
      if (!token.idToken) return null;
      const claims = decodeJwt(token.idToken) as Record<string, unknown>;
      if (claims['tid'] !== staff.tenantId) return null;
      const { oid, email } = claims;
      if (typeof oid !== 'string' || typeof email !== 'string') return null;

      const guest = isEntraGuest(claims);
      if (guest && !(staff.allowGuests ?? false)) return null;
      if (!guest && !emailInDomains(email, staff.domains)) return null;

      if (guest) {
        const existing = await hooks.lookup(email);
        const sameIdentity = existing?.accounts.some(
          (a) => a.providerId === 'microsoft' && a.accountId === oid,
        );
        if (existing && !sameIdentity) {
          refuseCallbackWith('ACCOUNT_LINK_REQUIRED');
          return null;
        }
      } else {
        // Tenant membership is the verification: Entra issues no `email_verified`.
        await hooks.onVerifiedEmail(email);
      }
      return {
        user: {
          id: oid,
          name: typeof claims['name'] === 'string' ? claims['name'] : email,
          email,
          emailVerified: !guest,
        },
        data: claims,
      };
    },
  } as never;
}

/**
 * Google, for the public preset (review S4). Mirrors rule 1: an address on a staff domain or a
 * verified SSO domain belongs to the company sign-in, so a consumer Google account asserting it is
 * refused (`null`), exactly as password sign-up is. Otherwise the squatting rule applies to addresses
 * Google reports as verified.
 */
export function googleProvider(
  options: GoogleOptions,
  hooks: { onVerifiedEmail: VerifiedEmailHook; isReserved: (email: string) => Promise<boolean> },
) {
  const base = google(options);
  return {
    ...options,
    getUserInfo: async (token: Parameters<typeof base.getUserInfo>[0]) => {
      const info = await base.getUserInfo(token);
      if (!info?.user.email) return info;
      if (await hooks.isReserved(info.user.email)) return null;
      if (info.user.emailVerified) await hooks.onVerifiedEmail(info.user.email);
      return info;
    },
  } as never;
}
