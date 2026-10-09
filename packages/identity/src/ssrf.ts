import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isPublicRoutableHost } from '@better-auth/core/utils/host';

/**
 * SSRF guard for every URL an SSO provider can make the server fetch (discovery, token, JWKS,
 * userinfo): `https` only, and never an address inside the cluster or the host (identity plan D16).
 * Checked when a provider is registered or updated (`ssoRegistrationGuard`), with a probe that refuses
 * redirects. At fetch time Better Auth applies its own public-host check; provider origins are never added
 * to `trustedOrigins`, so there is nothing to re-check here at that point.
 *
 * Classification is Better Auth's own `isPublicRoutableHost` (`@better-auth/core/utils/host`), which
 * also sees through IPv4-mapped IPv6 (`::ffff:7f00:1`), NAT64 (`64:ff9b::/96`), 6to4 (`2002::/16`) and
 * Teredo, and treats benchmarking (`198.18.0.0/15`), CGNAT and cloud-metadata names as non-public.
 * A host NAME is resolved here and every address it points at must pass the same test.
 *
 * Limits, stated: a name can resolve differently between this check and the fetch (DNS rebinding),
 * and a public host can still redirect to a private one. The network policy of the pod (egress to the
 * cluster ranges denied) is the second layer; this is the first.
 */
export class SsrfError extends Error {
  /**
   * The message is deliberately GENERIC: it reaches the API caller, and "resolves to a private
   * address" or "does not resolve" would turn registration into a port-and-network scanner. The
   * `reason` is for the log only.
   */
  constructor(
    readonly url: string,
    readonly reason: string,
  ) {
    super('That URL is not allowed for SSO.');
    this.name = 'SsrfError';
  }
}

export interface SsrfPolicy {
  /** Resolve a host name to every address it points at. */
  resolve(host: string): Promise<string[]>;
  /**
   * Permit `http` and loopback. For the package's own tests, where the IdP is a local process.
   * `createIdentity` refuses to build with this on when NODE_ENV is `production`.
   */
  allowLocalNetwork: boolean;
}

export const defaultSsrfPolicy: SsrfPolicy = {
  allowLocalNetwork: false,
  resolve: async (host) => (await lookup(host, { all: true })).map((r) => r.address),
};

export async function assertSafeUrl(
  raw: string,
  policy: SsrfPolicy = defaultSsrfPolicy,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfError(raw, 'not a URL');
  }
  if (!policy.allowLocalNetwork && url.protocol !== 'https:')
    throw new SsrfError(raw, 'https is required');
  if (policy.allowLocalNetwork && url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new SsrfError(raw, 'http or https is required');
  }
  if (url.username || url.password) throw new SsrfError(raw, 'credentials in URL');
  if (policy.allowLocalNetwork) return url;

  const host = url.hostname.replace(/^\[|\]$/g, '');
  // Names Better Auth classifies without a lookup (localhost, cloud-metadata names, …).
  if (!isIP(host) && !isPublicRoutableHost(host))
    throw new SsrfError(raw, 'host name is not public');
  const addresses = isIP(host) ? [host] : await policy.resolve(host).catch(() => []);
  if (addresses.length === 0) throw new SsrfError(raw, 'host does not resolve');
  if (!addresses.every(isPublicRoutableHost))
    throw new SsrfError(raw, 'resolves to a non-public address');
  return url;
}

/** URLs inside a provider's `oidcConfig` (object or stored JSON) that the server will fetch. */
export function oidcFetchUrls(issuer: unknown, oidcConfig: unknown): string[] {
  let config: Record<string, unknown> = {};
  if (typeof oidcConfig === 'string') {
    try {
      config = JSON.parse(oidcConfig) as Record<string, unknown>;
    } catch {
      /* unparseable config: only the issuer is checked */
    }
  } else if (oidcConfig && typeof oidcConfig === 'object') {
    config = oidcConfig as Record<string, unknown>;
  }
  const keys = [
    'discoveryEndpoint',
    'authorizationEndpoint',
    'tokenEndpoint',
    'jwksEndpoint',
    'userInfoEndpoint',
  ];
  return [issuer, ...keys.map((k) => config[k])].filter(
    (v): v is string => typeof v === 'string' && v.length > 0,
  );
}

/**
 * A public URL can still answer with a redirect to a private one, and Better Auth's fetch follows
 * redirects. At registration the URL is therefore probed once WITHOUT following them; a 3xx is refused.
 * (The fetch Better Auth makes later cannot be intercepted; pod egress policy is the second layer.)
 * A host that does not answer is let through: Better Auth's own discovery will fail on it.
 */
export async function assertNoRedirect(
  raw: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  let status: number;
  try {
    const res = await fetchImpl(raw, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
    status = res.status;
    await res.body?.cancel();
  } catch {
    return;
  }
  if (status >= 300 && status < 400) throw new SsrfError(raw, 'answers with a redirect');
}
