import { sso } from '@better-auth/sso';
import type { User } from 'better-auth';
import { replaceUnverifiedAccount, type ContextProvider } from './accounts';
import { domainIn, emailDomain } from './domains';
import type { SecurityEventSink } from './events';

type Where = Array<{ field: string; value: unknown }>;
interface Database {
  findOne(args: { model: string; where: Where }): Promise<Record<string, unknown> | null>;
}

export interface SsoHooks {
  /** After a user is provisioned by a provider; receives the mapped claims. */
  onSsoProvisioned?: (user: User, userInfo: Record<string, unknown>) => Promise<void> | void;
  /** Role in the provider's organization from the IdP's claims. Default: `member`. */
  ssoRole?: (data: {
    user: User;
    userInfo: Record<string, unknown>;
  }) => Promise<'member' | 'admin'> | 'member' | 'admin';
}

/**
 * The `sso` plugin with the package's policy (ADR 0002, identity plan D13-D16):
 *
 * - `domainVerification` on: a provider is unusable until its domain is proven (DNS TXT), and only
 *   then are its users "trusted" for linking.
 * - `providersLimit` is per user; WHO may register is `ssoRegistrationGuard` (organisation owner or
 *   admin only).
 * - `resolveUser` runs inside the same transaction as the account write, on every SSO sign-in:
 *     1. the asserted address must be inside the provider's own domain(s) (Better Auth alone would
 *        create a user for ANY address a partner IdP asserts);
 *     2. an unverified, never-used password account for that address is replaced (rule 2);
 *     3. D15: an EXISTING local account is linked automatically only if it already belongs to the
 *        organization that registered the provider. Any other is refused with ACCOUNT_LINK_REQUIRED,
 *        so a partner IdP cannot take over accounts outside its organization.
 */
export function ssoPlugin(options: {
  hooks: SsoHooks | undefined;
  getContext: ContextProvider;
  sink: SecurityEventSink;
}) {
  const { hooks, getContext, sink } = options;
  const reject = (code: string, message: string) => ({ action: 'reject', code, message }) as const;

  return sso({
    organizationProvisioning: {
      disabled: false,
      defaultRole: 'member',
      ...(hooks?.ssoRole
        ? {
            getRole: async (data: { user: User; userInfo: Record<string, unknown> }) =>
              hooks.ssoRole!(data),
          }
        : {}),
    },
    providersLimit: 20,
    domainVerification: { enabled: true },
    provisionUser: async ({
      user,
      userInfo,
    }: {
      user: User;
      userInfo: Record<string, unknown>;
    }) => {
      await hooks?.onSsoProvisioned?.(user, userInfo);
    },
    provisionUserOnEveryLogin: false,
    resolveUser: async (
      input: { providerId: string; providerUser: { email: string } },
      context: { database: Database },
    ) => {
      const provider = await context.database.findOne({
        model: 'ssoProvider',
        where: [{ field: 'providerId', value: input.providerId }],
      });
      const email = input.providerUser.email.toLowerCase();
      if (!provider || !domainIn(emailDomain(email), provider['domain'] as string | undefined)) {
        return reject('EMAIL_OUTSIDE_PROVIDER_DOMAIN', "Email is outside the provider's domain");
      }
      await replaceUnverifiedAccount(getContext, sink, email);

      const existing = await context.database.findOne({
        model: 'user',
        where: [{ field: 'email', value: email }],
      });
      if (!existing) return { action: 'continue' } as const;
      const organizationId = provider['organizationId'];
      const member =
        typeof organizationId === 'string'
          ? await context.database.findOne({
              model: 'member',
              where: [
                { field: 'userId', value: existing['id'] },
                { field: 'organizationId', value: organizationId },
              ],
            })
          : null;
      return member
        ? ({ action: 'continue' } as const)
        : reject(
            'ACCOUNT_LINK_REQUIRED',
            'An account with this email already exists. Sign in to it and link the company sign-in from your account settings.',
          );
    },
  } as never);
}
