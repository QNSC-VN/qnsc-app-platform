/** Lower-cased domain part of an address, or '' when it has none. */
export function emailDomain(email: string): string {
  return email.split('@')[1]?.trim().toLowerCase() ?? '';
}

/** `domains` is one domain or a comma-separated list, as the `sso` plugin stores it. */
export function parseDomains(domains: string | readonly string[] | undefined): string[] {
  const list = typeof domains === 'string' ? domains.split(',') : [...(domains ?? [])];
  return list.map((d) => d.trim().toLowerCase()).filter(Boolean);
}

/** Exact match or sub-domain (`cs.uni.test` is in `uni.test`); a look-alike (`miuni.test`) is not. */
export function domainIn(domain: string, domains: string | readonly string[] | undefined): boolean {
  const d = domain.trim().toLowerCase();
  if (!d) return false;
  return parseDomains(domains).some((allowed) => d === allowed || d.endsWith(`.${allowed}`));
}

export function emailInDomains(
  email: string,
  domains: string | readonly string[] | undefined,
): boolean {
  return domainIn(emailDomain(email), domains);
}
