import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { DEFAULTS } from './defaults';

/**
 * SSO client secrets at rest (ADR 0002, decision 1): AES-256-GCM, stored as
 * `enc:v<N>:<base64(iv | ciphertext | tag)>` inside `sso_provider.oidc_config`.
 *
 * Keys come from `IDENTITY_ENCRYPTION_KEY`:
 *   - one key: 32 random bytes, base64            -> version 1
 *   - several:  `v2=<base64>,v1=<base64>`          -> encrypt with the highest version, decrypt with any
 *
 * Rotation is therefore: add `v2=…` in front, deploy, re-save providers (or leave them: v1 keeps
 * decrypting), drop `v1` when no row carries it.
 */
export interface Keyring {
  /** Version used for new ciphertext. */
  current: number;
  keys: ReadonlyMap<number, Buffer>;
}

const IV_BYTES = 12;
const TAG_BYTES = 16;
/** Binds a ciphertext to its purpose, so a value moved to another column does not decrypt. */
const AAD = Buffer.from('identity:sso:client-secret');

export class EncryptionKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptionKeyError';
  }
}

function decodeKey(b64: string, label: string): Buffer {
  const key = Buffer.from(b64.trim(), 'base64');
  if (key.length !== 32) {
    throw new EncryptionKeyError(
      `${DEFAULTS.encryptionKeyEnv}: ${label} must be 32 bytes, base64 (got ${key.length}). ` +
        'Generate one with `openssl rand -base64 32`.',
    );
  }
  return key;
}

/** Parse the env value. Never echoes key material in an error. */
export function parseKeyring(value: string | undefined): Keyring {
  if (!value || !value.trim()) {
    throw new EncryptionKeyError(`${DEFAULTS.encryptionKeyEnv} is required when SSO is enabled`);
  }
  const keys = new Map<number, Buffer>();
  if (!/^\s*v\d+=/.test(value)) {
    keys.set(1, decodeKey(value, 'the key'));
    return { current: 1, keys };
  }
  for (const part of value.split(',')) {
    const m = /^\s*v(\d+)=(.+)$/.exec(part);
    if (!m)
      throw new EncryptionKeyError(
        `${DEFAULTS.encryptionKeyEnv}: expected "v<N>=<base64>" entries`,
      );
    const version = Number(m[1]);
    if (keys.has(version))
      throw new EncryptionKeyError(`${DEFAULTS.encryptionKeyEnv}: duplicate version v${version}`);
    keys.set(version, decodeKey(m[2]!, `v${version}`));
  }
  return { current: Math.max(...keys.keys()), keys };
}

export function isEncrypted(value: unknown): value is string {
  return typeof value === 'string' && /^enc:v\d+:/.test(value);
}

export function encryptSecret(plain: string, ring: Keyring): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', ring.keys.get(ring.current)!, iv);
  cipher.setAAD(AAD);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const payload = Buffer.concat([iv, body, cipher.getAuthTag()]);
  return `enc:v${ring.current}:${payload.toString('base64')}`;
}

export function decryptSecret(value: string, ring: Keyring): string {
  const m = /^enc:v(\d+):(.+)$/.exec(value);
  if (!m) throw new EncryptionKeyError('not an encrypted value');
  const key = ring.keys.get(Number(m[1]));
  if (!key) throw new EncryptionKeyError(`no key configured for version v${m[1]}`);
  const payload = Buffer.from(m[2]!, 'base64');
  if (payload.length < IV_BYTES + TAG_BYTES) throw new EncryptionKeyError('ciphertext too short');
  const decipher = createDecipheriv('aes-256-gcm', key, payload.subarray(0, IV_BYTES), {
    authTagLength: TAG_BYTES,
  });
  decipher.setAAD(AAD);
  decipher.setAuthTag(payload.subarray(payload.length - TAG_BYTES));
  try {
    return Buffer.concat([
      decipher.update(payload.subarray(IV_BYTES, payload.length - TAG_BYTES)),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // GCM failure: wrong key, tampered value or moved ciphertext. Say nothing more.
    throw new EncryptionKeyError('secret could not be decrypted');
  }
}

type Json = Record<string, unknown>;

/** Apply `fn` to `clientSecret` inside a stored `oidc_config` JSON string. Other fields untouched. */
function mapClientSecret(config: unknown, fn: (secret: string) => string): unknown {
  if (typeof config !== 'string') return config;
  let parsed: Json;
  try {
    parsed = JSON.parse(config) as Json;
  } catch {
    return config;
  }
  if (typeof parsed['clientSecret'] !== 'string') return config;
  return JSON.stringify({ ...parsed, clientSecret: fn(parsed['clientSecret']) });
}

export const sealOidcConfig = (config: unknown, ring: Keyring): unknown =>
  mapClientSecret(config, (s) => (isEncrypted(s) ? s : encryptSecret(s, ring)));

export const openOidcConfig = (config: unknown, ring: Keyring): unknown =>
  mapClientSecret(config, (s) => (isEncrypted(s) ? decryptSecret(s, ring) : s));

/**
 * Seal a client secret the way the package stores it (`enc:vN:…`), for tooling that writes
 * `sso_provider.oidc_config` OUTSIDE the application: the v7 -> v8 migration of `sso_connections`
 * secrets, a seed script. Uses `IDENTITY_ENCRYPTION_KEY` from `env`. Idempotent on a value that is
 * already sealed. Never log the argument or the result.
 */
export function sealSsoClientSecret(secret: string, env: NodeJS.ProcessEnv = process.env): string {
  return isEncrypted(secret)
    ? secret
    : encryptSecret(secret, parseKeyring(env[DEFAULTS.encryptionKeyEnv]));
}
