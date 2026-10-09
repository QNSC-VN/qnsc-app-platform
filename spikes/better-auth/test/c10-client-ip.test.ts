import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type Redis from 'ioredis';
import { clientIp } from '@quynhonsemiconductor/platform-http';
import { CLIENT_IP_HEADER } from '../src/identity/create-identity';
import { emailedLink, signIn, signUp, strongPassword, uniqueEmail } from './support/flows';
import { startStack, type Stack } from './support/stack';
import { keysWithPrefix, rawValkey } from './support/valkey';

/**
 * Criterion 10 — the client IP Better Auth uses for rate limits matches platform-http's
 * `clientIp` (cf-connecting-ip behind Cloudflare Tunnel), configured through Better Auth's
 * IP-header option.
 *
 * Observed where it matters: the rate-limit key Better Auth writes to Valkey (`<ip>|<path>`).
 */
interface Case {
  name: string;
  headers: Record<string, string>;
  /** What platform-http `clientIp` returns for this request (the contract). */
  expected: string;
}

const CASES: Case[] = [
  {
    name: 'cloudflare header only',
    headers: { 'cf-connecting-ip': '203.0.113.7' },
    expected: '203.0.113.7',
  },
  {
    name: 'cloudflare header + spoofed x-forwarded-for: the spoof is ignored',
    headers: { 'cf-connecting-ip': '203.0.113.8', 'x-forwarded-for': '198.51.100.99, 10.0.0.1' },
    expected: '203.0.113.8',
  },
  {
    name: 'x-forwarded-for only, one hop',
    headers: { 'x-forwarded-for': '203.0.113.9' },
    expected: '203.0.113.9',
  },
  {
    name: 'x-forwarded-for only, a chain: clientIp takes the first entry',
    headers: { 'x-forwarded-for': '203.0.113.10, 10.0.0.2, 10.0.0.3' },
    expected: '203.0.113.10',
  },
  {
    name: 'cf-connecting-ip is not an address (log/Redis-key injection attempt): skipped',
    headers: { 'cf-connecting-ip': 'evil|/sign-in/email', 'x-forwarded-for': '203.0.113.11' },
    expected: '203.0.113.11',
  },
  {
    name: 'client sets our internal header itself: discarded, real source wins',
    headers: { 'cf-connecting-ip': '203.0.113.12', [CLIENT_IP_HEADER]: '1.2.3.4' },
    expected: '203.0.113.12',
  },
];

describe('C10 client IP', () => {
  let stack: Stack;
  let redis: Redis;
  beforeAll(async () => {
    stack = await startStack();
    redis = rawValkey();
  });
  afterAll(async () => {
    redis?.disconnect();
    await stack?.stop();
  });

  /** The IP part of the rate-limit key Better Auth wrote for the last `/get-session` call. */
  async function limiterIpFor(headers: Record<string, string>): Promise<string> {
    await redis.flushdb(); // the rate-limit key is the only thing this isolates on; app prefix keeps others apart
    const c = stack.client(headers);
    // `stack.client` injects a fresh cf-connecting-ip unless overridden; honour "absent" explicitly.
    const res = await fetch(`${stack.url}/api/auth/get-session`, {
      headers: { origin: stack.url, ...headers },
    });
    expect(res.status).toBe(200);
    void c;
    const keys = (await keysWithPrefix(redis, stack.keyPrefix)).filter((k) =>
      k.endsWith('|/get-session'),
    );
    expect(keys, 'exactly one rate-limit key').toHaveLength(1);
    return keys[0]!.slice(stack.keyPrefix.length).replace('|/get-session', '');
  }

  for (const c of CASES) {
    it(`${c.name}`, async () => {
      expect(clientIp({ headers: lower(c.headers) })).toBe(c.expected);
      expect(await limiterIpFor(c.headers)).toBe(c.expected);
    });
  }

  it('no proxy headers at all: both fall back to the socket address', async () => {
    const seen = await limiterIpFor({});
    expect(seen).toBe('127.0.0.1');
  });

  it('IPv6: Better Auth collapses to the /64 for the key (intended), clientIp keeps the full address', async () => {
    const full = '2001:db8:85a3:1:2:8a2e:370:7334';
    const seen = await limiterIpFor({ 'cf-connecting-ip': full });
    expect(clientIp({ headers: { 'cf-connecting-ip': full } })).toBe(full);
    expect(seen).toBe('2001:0db8:85a3:0001:0000:0000:0000:0000');
    // A DIFFERENCE, deliberate: one /64 is one subscriber, so per-/64 keys stop an attacker
    // rotating through their own prefix. Logs and audit keep the full address.
  });

  it('an attacker cannot dodge the per-IP limit by rotating x-forwarded-for when cf-connecting-ip is set', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const res = await fetch(`${stack.url}/api/auth/sign-in/email`, {
        method: 'POST',
        headers: {
          origin: stack.url,
          'content-type': 'application/json',
          'cf-connecting-ip': '203.0.113.77',
          'x-forwarded-for': `198.51.100.${i + 1}`,
        },
        body: JSON.stringify({
          email: `nobody${i}@example.test`,
          password: `pw-${crypto.randomUUID()}`,
        }),
      });
      codes.push(res.status);
    }
    expect(codes.slice(0, 3)).toEqual([401, 401, 401]);
    expect(codes.slice(3)).toEqual([429, 429]);
  });

  it('the session row records the same address', async () => {
    const email = uniqueEmail('ip');
    const password = strongPassword();
    const c = stack.client({ 'cf-connecting-ip': '203.0.113.55' });
    await signUp(c, email, password);
    await c.get(await emailedLink(stack, email));
    await signIn(c, email, password);
    const { rows } = await stack.pool.query<{ ip_address: string }>(
      `select s.ip_address from identity.session s join identity."user" u on u.id = s.user_id where u.email = $1`,
      [email],
    );
    expect(rows[0]!.ip_address).toBe('203.0.113.55');
  });
});

/**
 * The same cases WITHOUT the mount's normalisation: Better Auth's `ipAddressHeaders` option
 * alone, pointed straight at the Cloudflare headers. This is what "configured through Better
 * Auth's IP-header option" gives if nothing else is done, and why the mount resolves the address.
 */
describe('C10 option-only (no normalisation) vs clientIp', () => {
  const OPTION_ONLY = {
    advanced: { ipAddress: { ipAddressHeaders: ['cf-connecting-ip', 'x-forwarded-for'] } },
  };

  /**
   * Better Auth's own `getIP`, in a child process with NODE_ENV=production: its test/development
   * fallback to 127.0.0.1 is decided when the module loads, and would hide the null.
   */
  function betterAuthIps(all: Array<Record<string, string>>): Array<string | null> {
    const script = `
      import { getIP } from 'better-auth/api';
      const options = ${JSON.stringify(OPTION_ONLY)};
      const cases = ${JSON.stringify(all)};
      console.log(JSON.stringify(cases.map((h) => getIP(new Request('http://x/api/auth/get-session', { headers: h }), options))));`;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: process.cwd(),
      // vitest exports TEST=true, which Better Auth reads as "test mode" (isTest()).
      env: Object.fromEntries(
        Object.entries({ ...process.env, NODE_ENV: 'production' }).filter(
          ([k]) => !['TEST', 'VITEST', 'VITEST_WORKER_ID', 'VITEST_POOL_ID'].includes(k),
        ),
      ),
      encoding: 'utf8',
    });
    return JSON.parse(out.trim().split('\n').at(-1)!) as Array<string | null>;
  }

  const candidates = CASES.filter((c) => !(CLIENT_IP_HEADER in c.headers));
  const results = betterAuthIps(candidates.map((c) => c.headers));
  const rows = candidates.map((c, i) => ({
    name: c.name,
    expected: c.expected,
    optionOnly: results[i],
  }));

  it('prints the comparison', () => {
    console.info(
      `[C10 option-only] ipAddressHeaders=['cf-connecting-ip','x-forwarded-for'], no normalisation\n${rows
        .map(
          (r) =>
            `  ${r.optionOnly === r.expected ? 'match   ' : 'MISMATCH'} clientIp=${r.expected} betterAuth=${r.optionOnly}  (${r.name})`,
        )
        .join('\n')}`,
    );
  });

  it('matches for a single cf-connecting-ip and for a single-hop x-forwarded-for', () => {
    const [cf, , xff1] = results;
    expect(cf).toBe('203.0.113.7');
    expect(xff1).toBe('203.0.113.9');
  });

  it('DOES NOT match for a multi-hop x-forwarded-for: Better Auth returns null => ONE shared bucket', () => {
    const idx = candidates.findIndex((c) => c.name.startsWith('x-forwarded-for only, a chain'));
    expect(results[idx]).toBeNull();
  });

  it('DOES NOT match when cf-connecting-ip is junk and x-forwarded-for is a chain: null', () => {
    const [junk] = betterAuthIps([
      { 'cf-connecting-ip': 'evil|x', 'x-forwarded-for': '203.0.113.11, 10.0.0.1' },
    ]);
    expect(junk).toBeNull();
  });
});

function lower(h: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
}
