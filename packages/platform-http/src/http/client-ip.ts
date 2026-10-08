import { isIP } from 'node:net';

/**
 * The slice of a request {@link clientIp} reads. Structural on purpose, so a Fastify
 * request, a raw Node `IncomingMessage` and a test fake all fit without a cast.
 */
export interface ClientIpRequest {
  headers?: Record<string, string | string[] | undefined>;
  /** Fastify's resolved address (honours `trustProxy`). Used only as the last fallback. */
  ip?: string;
  socket?: { remoteAddress?: string };
}

/** What {@link clientIp} returns when no source yields an address. */
export const UNKNOWN_CLIENT_IP = 'unknown';

function firstHeader(req: ClientIpRequest, name: string): string | undefined {
  const value = req.headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

/** A trimmed value if (and only if) it is a literal IPv4/IPv6 address. */
function asIp(value: string | undefined): string | undefined {
  const candidate = value?.trim();
  return candidate && isIP(candidate) !== 0 ? candidate : undefined;
}

/**
 * The address of the original client, for access logs and rate-limit keys.
 *
 * Order: `cf-connecting-ip` → first `x-forwarded-for` entry → socket address.
 *
 * Behind Cloudflare Tunnel the origin sees only `cloudflared`'s address, and
 * `x-forwarded-for` is appended to by every hop — its first entry is whatever the client
 * chose to send. `cf-connecting-ip` is set by Cloudflare's edge, overwriting anything the
 * client supplied, so when it is present a forged `x-forwarded-for` is ignored.
 *
 * **Trust boundary.** `cf-connecting-ip` is only authoritative when the origin is
 * reachable *only* through Cloudflare (the Tunnel — no public listener, no `NodePort`).
 * A pod that something else can reach directly lets that caller choose its own address
 * and so pick its own rate-limit bucket. That is a property of the deployment, not of
 * this function; the platform contract requires Tunnel-only ingress.
 *
 * A header value that is not a literal IP address is skipped, never used: it ends up in
 * Redis keys and log lines, and a header is attacker-controlled text.
 */
export function clientIp(req: ClientIpRequest): string {
  return (
    asIp(firstHeader(req, 'cf-connecting-ip')) ??
    asIp(firstHeader(req, 'x-forwarded-for')?.split(',')[0]) ??
    req.socket?.remoteAddress ??
    req.ip ??
    UNKNOWN_CLIENT_IP
  );
}
