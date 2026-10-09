import { createHmac } from 'node:crypto';
import type { TestClient } from './client';
import { API, uniqueEmail, strongPassword, type Stack } from './harness';
import { verifiedUser } from './flows';
import type { MockIdp } from './mock-idp';

/** The injected test framework: the package imports none, so any runner can drive the kit. */
export interface TestApi {
  describe(name: string, fn: () => void): void;
  it(name: string, fn: () => unknown | Promise<unknown>, timeoutMs?: number): void;
  beforeAll(fn: () => unknown | Promise<unknown>, timeoutMs?: number): void;
  afterAll(fn: () => unknown | Promise<unknown>, timeoutMs?: number): void;
  // The runner's own `expect`; its matcher surface is the runner's business.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expect: (actual: unknown, message?: string) => any;
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s) from a base32 secret, to drive the 2FA flows. */
export function totp(base32Secret: string, now = Date.now()): string {
  let bits = '';
  for (const ch of base32Secret.replace(/=+$/, '').toUpperCase())
    bits += BASE32.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const h = createHmac('sha1', key).update(counter).digest();
  const o = h[h.length - 1]! & 0xf;
  const code =
    (((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!) % 1_000_000;
  return String(code).padStart(6, '0');
}

export const OIDC_CLIENT_ID = 'partner-client';

export interface Partner {
  organizationId: string;
  providerId: string;
  domain: string;
  owner: TestClient;
}

/**
 * A partner organisation with its own OIDC IdP, set up the way a product would: an organisation
 * owner registers the provider through the API (so the secret goes through the encrypting adapter),
 * then the domain is marked verified (the DNS-TXT proof cannot run offline).
 */
/**
 * An organization with an owner, created the way a product's admin tool does (open creation is OFF,
 * so a stranger cannot make one through the API).
 */
export async function createOrganization(
  stack: Stack,
  t: TestApi,
  slug = `org-${crypto.randomUUID().slice(0, 8)}`,
): Promise<{ organizationId: string; owner: TestClient; ownerId: string; slug: string }> {
  const ownerEmail = uniqueEmail('owner');
  const owner = await verifiedUser(stack, ownerEmail, strongPassword(), t.expect);
  const ownerId = (
    await stack.pool.query<{ id: string }>(`select id from identity."user" where email = $1`, [
      ownerEmail,
    ])
  ).rows[0]!.id;
  const organizationId = (
    await stack.pool.query<{ id: string }>(
      `insert into identity.organization (id, name, slug, created_at) values (uuidv7(), $1, $1, now()) returning id`,
      [slug],
    )
  ).rows[0]!.id;
  await stack.pool.query(
    `insert into identity.member (id, organization_id, user_id, role, created_at) values (uuidv7(), $1::uuid, $2::uuid, 'owner', now())`,
    [organizationId, ownerId],
  );
  return { organizationId, owner, ownerId, slug };
}

export async function registerPartner(
  stack: Stack,
  idp: MockIdp,
  t: TestApi,
  options: { domain: string; verified?: boolean; slug?: string },
): Promise<Partner & { clientSecret: string }> {
  const { organizationId, owner, slug } = await createOrganization(stack, t, options.slug);
  const providerId = `sso-${slug}`;
  const clientSecret = `partner-${crypto.randomUUID()}`;
  const res = await owner.post(`${API}/sso/register`, {
    providerId,
    issuer: `${idp.base}/oidc`,
    domain: options.domain,
    organizationId,
    oidcConfig: {
      clientId: OIDC_CLIENT_ID,
      clientSecret,
      discoveryEndpoint: `${idp.base}/.well-known/openid-configuration`,
      pkce: true,
      mapping: {
        email: 'email',
        emailVerified: 'email_verified',
        name: 'name',
        extraFields: { groups: 'groups' },
      },
    },
  });
  t.expect(res.status, res.body).toBe(200);
  t.expect(
    res.body.includes(clientSecret),
    'the register response must not echo the client secret',
  ).toBe(false);
  if (options.verified !== false) {
    await stack.pool.query(
      `update identity.sso_provider set domain_verified = true where provider_id = $1`,
      [providerId],
    );
  }
  return { organizationId, providerId, domain: options.domain, owner, clientSecret };
}

/** Start an SSO sign-in by email and follow it through the IdP. */
export async function ssoSignIn(client: TestClient, body: Record<string, unknown>) {
  const start = await client.post(`${API}/sign-in/sso`, { callbackURL: '/', ...body });
  if (start.status !== 200) return { start } as const;
  const authz = await client.get(start.json<{ url: string }>().url);
  const callback = await client.get(authz.location!);
  return { start, authz, callback } as const;
}

/** Sign a user in through the mock Entra (the Microsoft provider), following every hop. */
export async function microsoftSignIn(
  stack: Stack,
  idp: MockIdp,
  identity: Parameters<MockIdp['loginAs']>[0],
  client: TestClient = stack.client(),
) {
  idp.loginAs(identity);
  const start = await client.post(`${API}/sign-in/social`, {
    provider: 'microsoft',
    callbackURL: '/',
  });
  const authz = await client.get(start.json<{ url: string }>().url);
  const callback = await client.get(authz.location!);
  return { client, callback };
}
