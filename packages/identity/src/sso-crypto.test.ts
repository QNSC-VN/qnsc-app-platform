import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decryptSecret,
  EncryptionKeyError,
  encryptSecret,
  isEncrypted,
  openOidcConfig,
  parseKeyring,
  sealOidcConfig,
  sealSsoClientSecret,
} from './sso-crypto';
import { withEncryptedSsoSecrets } from './sso-protect';

const key = () => randomBytes(32).toString('base64');

describe('sso-crypto', () => {
  it('round-trips and never produces the same ciphertext twice', () => {
    const ring = parseKeyring(key());
    const a = encryptSecret('s3cret-value', ring);
    const b = encryptSecret('s3cret-value', ring);
    expect(a).toMatch(/^enc:v1:/);
    expect(a).not.toBe(b);
    expect(a).not.toContain('s3cret-value');
    expect(decryptSecret(a, ring)).toBe('s3cret-value');
  });

  it('rotates: new ciphertext uses the newest key, old ciphertext still decrypts', () => {
    const k1 = key();
    const k2 = key();
    const old = encryptSecret('x', parseKeyring(k1));
    const ring = parseKeyring(`v2=${k2},v1=${k1}`);
    expect(ring.current).toBe(2);
    expect(encryptSecret('x', ring)).toMatch(/^enc:v2:/);
    expect(decryptSecret(old, ring)).toBe('x');
    expect(() => decryptSecret(old, parseKeyring(`v2=${k2}`))).toThrow(
      /no key configured for version v1/,
    );
  });

  it('rejects a bad key without echoing it', () => {
    const bad = Buffer.from('short').toString('base64');
    expect(() => parseKeyring(bad)).toThrow(EncryptionKeyError);
    try {
      parseKeyring(bad);
    } catch (e) {
      expect(String(e)).not.toContain(bad);
    }
    expect(() => parseKeyring(undefined)).toThrow(/required/);
    expect(() => parseKeyring(`v1=${key()},v1=${key()}`)).toThrow(/duplicate/);
  });

  it('a tampered or foreign ciphertext fails closed', () => {
    const ring = parseKeyring(key());
    const other = parseKeyring(key());
    const c = encryptSecret('x', ring);
    expect(() => decryptSecret(c, other)).toThrow(/could not be decrypted/);
    expect(() => decryptSecret(c.slice(0, -4) + 'AAAA', ring)).toThrow(/could not be decrypted/);
  });

  it('seals only clientSecret inside the oidc_config JSON and is idempotent', () => {
    const ring = parseKeyring(key());
    const raw = JSON.stringify({ clientId: 'id', clientSecret: 'plain', pkce: true });
    const sealed = sealOidcConfig(raw, ring) as string;
    const parsed = JSON.parse(sealed) as Record<string, unknown>;
    expect(isEncrypted(parsed['clientSecret'])).toBe(true);
    expect(parsed['clientId']).toBe('id');
    expect(sealOidcConfig(sealed, ring)).toBe(sealed);
    expect(JSON.parse(openOidcConfig(sealed, ring) as string)).toMatchObject({
      clientSecret: 'plain',
    });
    // legacy plain rows and non-JSON pass through
    expect(openOidcConfig(raw, ring)).toBe(raw);
    expect(sealOidcConfig('not json', ring)).toBe('not json');
  });

  it('the adapter wrapper stores ciphertext and returns plain text, inside transactions too', async () => {
    const ring = parseKeyring(key());
    const stored: Array<Record<string, unknown>> = [];
    const base = {
      create: async ({ data }: { data: Record<string, unknown> }) => (stored.push(data), data),
      update: async ({ update }: { update: Record<string, unknown> }) => update,
      updateMany: async () => 0,
      findOne: async (_args?: unknown) => stored[0] ?? null,
      findMany: async (_args?: unknown) => stored,
      transaction: async (cb: (t: unknown) => Promise<unknown>) =>
        cb({ ...base, transaction: undefined }),
    };
    const adapter = withEncryptedSsoSecrets(
      (() => base) as never,
      ring,
    )({} as never) as unknown as typeof base;
    const config = JSON.stringify({ clientSecret: 'plain-secret' });

    const created = (await adapter.create({
      model: 'ssoProvider',
      data: { oidcConfig: config },
    } as never)) as Record<string, unknown>;
    expect(stored[0]!['oidcConfig']).not.toContain('plain-secret');
    expect(created['oidcConfig']).toContain('plain-secret');
    expect(
      JSON.parse(
        ((await adapter.findOne({ model: 'ssoProvider' } as never)) as Record<string, string>)[
          'oidcConfig'
        ]!,
      ),
    ).toMatchObject({ clientSecret: 'plain-secret' });

    await adapter.transaction(async (trx) => {
      await (trx as typeof base).create({
        model: 'ssoProvider',
        data: { oidcConfig: config },
      } as never);
    });
    expect(stored[1]!['oidcConfig']).not.toContain('plain-secret');

    // other models are untouched
    await adapter.create({ model: 'user', data: { oidcConfig: config } } as never);
    expect(stored[2]!['oidcConfig']).toBe(config);
  });

  it('sealSsoClientSecret seals for migration tooling, with the same key the application reads', () => {
    const k = key();
    const sealed = sealSsoClientSecret('legacy-secret', { IDENTITY_ENCRYPTION_KEY: k });
    expect(sealed).toMatch(/^enc:v1:/);
    expect(sealed).not.toContain('legacy-secret');
    expect(decryptSecret(sealed, parseKeyring(k))).toBe('legacy-secret');
    expect(sealSsoClientSecret(sealed, { IDENTITY_ENCRYPTION_KEY: k })).toBe(sealed);
    expect(() => sealSsoClientSecret('x', {})).toThrow(/required/);
  });
});
