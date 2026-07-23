import { describe, it, expect } from 'vitest';
import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  createLocalJWKSet,
  type JWTVerifyGetKey,
} from 'jose';
import { OidcTokenVerifier } from './oidc-verifier';
import type { ResolvedConnection } from './oidc-connection';

const V2 = 'https://idp/x/v2.0';
const V1 = 'https://sts.windows.net/x/';

const conn: ResolvedConnection = {
  id: 'c1',
  kind: 'directory',
  provider: 'entra',
  clientId: 'aud-cid',
  clientSecret: 's',
  redirectUri: 'https://app/cb',
  scopes: 'openid',
  issuer: V2,
  acceptedIssuers: [V2, V1], // accept both Entra v2 and legacy v1 issuers
  authorizeEndpoint: 'a',
  tokenEndpoint: 't',
  jwksUri: 'https://idp/x/keys',
};

async function setup() {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'k1';
  const localJwks = createLocalJWKSet({ keys: [jwk] });
  const resolver: (u: URL) => JWTVerifyGetKey = () => localJwks;
  const sign = (claims: Record<string, unknown>, issuer = V2, audience = conn.clientId) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(issuer)
      .setAudience(audience)
      .setExpirationTime('5m')
      .sign(privateKey);
  return { resolver, sign };
}

describe('OidcTokenVerifier', () => {
  it('verifies a valid token and maps claims', async () => {
    const { resolver, sign } = await setup();
    const token = await sign({ oid: 'o1', email: 'A@X.com', name: 'A', tid: 'tid1', roles: ['r'] });
    const claims = await new OidcTokenVerifier(resolver).verify(token, conn);
    expect(claims).toMatchObject({
      oid: 'o1',
      email: 'a@x.com', // lower-cased
      displayName: 'A',
      externalTenantId: 'tid1',
      roles: ['r'],
    });
  });

  it('accepts an alternate accepted issuer (Entra v1)', async () => {
    const { resolver, sign } = await setup();
    const token = await sign({ oid: 'o1', email: 'a@x.com' }, V1);
    await expect(new OidcTokenVerifier(resolver).verify(token, conn)).resolves.toMatchObject({
      oid: 'o1',
    });
  });

  it('rejects a foreign issuer', async () => {
    const { resolver, sign } = await setup();
    const token = await sign({ oid: 'o1', email: 'a@x.com' }, 'https://evil/iss');
    await expect(new OidcTokenVerifier(resolver).verify(token, conn)).rejects.toThrow(
      /verification failed/i,
    );
  });

  it('rejects a wrong audience', async () => {
    const { resolver, sign } = await setup();
    const token = await sign({ oid: 'o', email: 'e@x.com' }, V2, 'other-aud');
    await expect(new OidcTokenVerifier(resolver).verify(token, conn)).rejects.toThrow(
      /verification failed/i,
    );
  });

  it('rejects a nonce mismatch', async () => {
    const { resolver, sign } = await setup();
    const token = await sign({ oid: 'o1', email: 'a@x.com', nonce: 'good' });
    await expect(
      new OidcTokenVerifier(resolver).verify(token, conn, 'expected'),
    ).rejects.toThrow(/nonce mismatch/);
  });

  it('rejects missing subject/email', async () => {
    const { resolver, sign } = await setup();
    const token = await sign({ name: 'no-subject' });
    await expect(new OidcTokenVerifier(resolver).verify(token, conn)).rejects.toThrow(
      /missing subject\/email/,
    );
  });

  it('falls back to sub when oid is absent (non-Entra IdP)', async () => {
    const { resolver, sign } = await setup();
    const token = await sign({ sub: 'google-123', email: 'g@x.com' });
    await expect(new OidcTokenVerifier(resolver).verify(token, conn)).resolves.toMatchObject({
      oid: 'google-123',
      externalTenantId: null,
    });
  });
});
