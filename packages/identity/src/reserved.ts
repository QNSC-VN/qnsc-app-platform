import type { AccountContext } from './accounts';
import { domainIn, emailDomain, parseDomains } from './domains';

/**
 * Is this email on a domain the company owns: a staff domain, or one an organization has VERIFIED for
 * SSO? Such addresses sign in with the company account, never with a password or a consumer provider
 * (ADR 0002, decision 2, rule 1; review S4). An UNVERIFIED claim reserves nothing.
 */
export type ReservedDomainCheck = (email: string) => Promise<boolean>;

export function reservedDomainCheck(options: {
  staffDomains: readonly string[];
  withSso: boolean;
  getContext: () => Promise<AccountContext>;
}): ReservedDomainCheck {
  return async (email) => {
    const domain = emailDomain(email);
    if (domainIn(domain, options.staffDomains)) return true;
    if (!options.withSso) return false;
    const providers = (await (
      await options.getContext()
    ).adapter.findMany({
      model: 'ssoProvider',
      where: [{ field: 'domainVerified', value: true }],
    })) as unknown as Array<{ domain?: string }>;
    return providers.some((p) => parseDomains(p.domain).length > 0 && domainIn(domain, p.domain));
  };
}
