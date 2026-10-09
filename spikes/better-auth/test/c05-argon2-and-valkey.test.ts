import { createServer } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type Redis from 'ioredis';
import { argon2Password } from '../src/identity/password';
import { API, signIn, strongPassword, uniqueEmail, verifiedUser } from './support/flows';
import { startStack, type Stack } from './support/stack';
import { keysWithPrefix, rawValkey } from './support/valkey';

/**
 * Criterion 5 — argon2id hash/verify override; rate limits and session cache in Valkey via
 * `secondaryStorage`.
 */
describe('C5 argon2id + Valkey secondaryStorage', () => {
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

  it('new passwords are stored as argon2id with the OWASP baseline m=19456,t=2,p=1', async () => {
    const email = uniqueEmail('hash');
    await verifiedUser(stack, email, strongPassword());
    const { rows } = await stack.pool.query<{ password: string }>(
      `select a.password from identity.account a join identity."user" u on u.id = a.user_id
        where u.email = $1 and a.provider_id = 'credential'`,
      [email],
    );
    expect(rows[0]!.password).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  });

  it('verify accepts the right password and rejects the wrong one; garbage hashes are "no match", not errors', async () => {
    const hash = await argon2Password.hash('correct horse battery staple');
    expect(await argon2Password.verify({ hash, password: 'correct horse battery staple' })).toBe(
      true,
    );
    expect(await argon2Password.verify({ hash, password: 'wrong' })).toBe(false);
    expect(
      await argon2Password.verify({ hash: 'salt:scryptlikeBetterAuthDefault', password: 'x' }),
    ).toBe(false);
    expect(await argon2Password.verify({ hash: '', password: 'x' })).toBe(false);
  });

  it('rate limits live in Valkey under the product prefix, keyed `<ip>|<path>`', async () => {
    const ip = '203.0.113.200';
    const c = stack.client({ 'cf-connecting-ip': ip });
    const email = uniqueEmail('rl');
    const codes: number[] = [];
    for (let i = 0; i < 5; i += 1) codes.push((await signIn(c, email, strongPassword())).status);
    // Built-in special rule: /sign-in/* is 3 requests per 10 s per IP.
    expect(codes.slice(0, 3)).toEqual([401, 401, 401]);
    expect(codes.slice(3)).toEqual([429, 429]);

    const keys = await keysWithPrefix(redis, stack.keyPrefix);
    expect(keys).toContain(`${stack.keyPrefix}${ip}|/sign-in/email`);
    const limited = await signIn(c, email, strongPassword());
    expect(limited.headers.get('x-retry-after')).toMatch(/^\d+$/);
    // and none of it is in Postgres
    const { rows } = await stack.pool.query(
      `select 1 from information_schema.tables where table_name = 'rate_limit'`,
    );
    expect(rows).toHaveLength(0);
  });

  it('the rate-limit counter has a TTL (it cannot leak keys forever)', async () => {
    const keys = (await keysWithPrefix(redis, stack.keyPrefix)).filter((k) =>
      k.includes('|/sign-in/email'),
    );
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      const ttl = await redis.ttl(k);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(10);
    }
  });

  it('sessions are cached in Valkey AND stored in Postgres; Valkey loss falls back to the database', async () => {
    const email = uniqueEmail('sess');
    const c = await verifiedUser(stack, email, strongPassword());
    const before = await keysWithPrefix(redis, stack.keyPrefix);
    expect(before.some((k) => k.includes('active-sessions-'))).toBe(true);

    const { rows } = await stack.pool.query(
      `select s.id from identity.session s join identity."user" u on u.id = s.user_id where u.email = $1`,
      [email],
    );
    expect(rows).toHaveLength(1);

    // Simulate a Valkey restart: everything cached is gone.
    for (const k of await keysWithPrefix(redis, stack.keyPrefix)) await redis.del(k);
    const me = await c.get('/v1/me');
    expect(me.status).toBe(200);
  });

  it('secondaryStorage.increment is atomic and sets the TTL only on creation', async () => {
    const storage = stack.auth.options.secondaryStorage!;
    const key = `probe:${crypto.randomUUID()}`;
    const results = await Promise.all(Array.from({ length: 20 }, () => storage.increment(key, 30)));
    expect([...results].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    const ttl1 = await redis.ttl(`${stack.keyPrefix}${key}`);
    await new Promise((r) => setTimeout(r, 1100));
    await storage.increment(key, 30);
    const ttl2 = await redis.ttl(`${stack.keyPrefix}${key}`);
    expect(ttl2).toBeLessThan(ttl1); // not extended
  });

  it('getAndDelete is atomic: exactly one of N concurrent callers gets the value', async () => {
    const storage = stack.auth.options.secondaryStorage!;
    const key = `probe:${crypto.randomUUID()}`;
    await storage.set(key, 'once', 30);
    const got = await Promise.all(Array.from({ length: 10 }, () => storage.getAndDelete(key)));
    expect(got.filter((v) => v === 'once')).toHaveLength(1);
  });
});

describe('C5 Valkey outage', () => {
  let stack: Stack;
  const degraded: string[] = [];
  beforeAll(async () => {
    const dead = await new Promise<number>((resolve) => {
      const s = createServer();
      s.listen(0, '127.0.0.1', () => {
        const { port } = s.address() as { port: number };
        s.close(() => resolve(port));
      });
    });
    stack = await startStack({
      valkeyUrl: `redis://127.0.0.1:${dead}`,
      identity: { onStorageDegraded: (op) => degraded.push(op) },
    });
  });
  afterAll(async () => {
    await stack?.stop();
  });

  it('with Valkey unreachable, users can still sign up, verify and sign in (sessions fall back to Postgres)', async () => {
    const email = uniqueEmail('outage');
    const password = strongPassword();
    const t0 = performance.now();
    const c = await verifiedUser(stack, email, password);
    const elapsed = Math.round(performance.now() - t0);
    console.info(
      `[C5 outage] sign-up+verify+sign-in with Valkey down: ${elapsed} ms, degraded ops: ${[...new Set(degraded)].join(',')}`,
    );
    expect((await c.get('/v1/me')).status).toBe(200);
    expect(degraded.length).toBeGreaterThan(0);
  });

  it('with Valkey unreachable the rate limiter fails OPEN (documented, deliberate)', async () => {
    const c = stack.client({ 'cf-connecting-ip': '203.0.113.201' });
    const codes: number[] = [];
    for (let i = 0; i < 5; i += 1)
      codes.push((await signIn(c, uniqueEmail('open'), strongPassword())).status);
    expect(codes).toEqual([401, 401, 401, 401, 401]);
    void API;
  });
});
