import type { DBAdapterInstance } from 'better-auth';
import { openOidcConfig, sealOidcConfig, type Keyring } from './sso-crypto';

/**
 * Wraps a Better Auth database adapter so `ssoProvider.oidcConfig.clientSecret` is encrypted on every
 * write and decrypted on every read (ADR 0002, decision 1). The rest of Better Auth, and the SSO
 * plugin, only ever see plain text in memory; the column only ever holds `enc:vN:…`.
 *
 * The adapter is patched IN PLACE rather than proxied: Better Auth keys its schema check on the
 * adapter object, and a proxy would silently switch that check off.
 */
type Row = Record<string, unknown>;
// The adapter surface is Better Auth's and is generic over model names; keep the wrapper loose.
/* eslint-disable @typescript-eslint/no-explicit-any */
type Adapter = Record<string, any>;

const PATCHED = new WeakSet<object>();
const MODEL = 'ssoProvider';

function patch(adapter: Adapter, ring: Keyring): Adapter {
  if (PATCHED.has(adapter)) return adapter;
  PATCHED.add(adapter);

  const seal = (data: Row | undefined): Row | undefined =>
    data && 'oidcConfig' in data
      ? { ...data, oidcConfig: sealOidcConfig(data['oidcConfig'], ring) }
      : data;
  const open = <T>(row: T): T =>
    row && typeof row === 'object' && 'oidcConfig' in (row as Row)
      ? ({ ...(row as Row), oidcConfig: openOidcConfig((row as Row)['oidcConfig'], ring) } as T)
      : row;

  const wrap = (name: string, fn: (original: (...a: any[]) => any, args: any) => any): void => {
    const original = adapter[name];
    if (typeof original !== 'function') return;
    adapter[name] = (args: any, ...rest: any[]) =>
      args?.model === MODEL
        ? fn((a) => original.call(adapter, a, ...rest), args)
        : original.call(adapter, args, ...rest);
  };

  wrap('create', (call, args) => call({ ...args, data: seal(args.data) }).then(open));
  wrap('update', (call, args) => call({ ...args, update: seal(args.update) }).then(open));
  wrap('updateMany', (call, args) => call({ ...args, update: seal(args.update) }));
  wrap('findOne', (call, args) => call(args).then(open));
  wrap('findMany', (call, args) => call(args).then((rows: unknown[]) => rows.map(open)));

  const transaction = adapter['transaction'];
  if (typeof transaction === 'function') {
    adapter['transaction'] = (cb: (trx: Adapter) => Promise<unknown>) =>
      transaction.call(adapter, (trx: Adapter) => cb(patch(trx, ring)));
  }
  return adapter;
}

export function withEncryptedSsoSecrets(
  factory: DBAdapterInstance,
  ring: Keyring,
): DBAdapterInstance {
  return ((options: never) =>
    patch((factory as (o: never) => Adapter)(options), ring)) as unknown as DBAdapterInstance;
}
