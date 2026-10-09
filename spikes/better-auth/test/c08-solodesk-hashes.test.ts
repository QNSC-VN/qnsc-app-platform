import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as nodeArgon2 from 'argon2';
import { argon2Password } from '../src/identity/password';
import { signIn, strongPassword, uniqueEmail } from './support/flows';
import { startStack, type Stack } from './support/stack';

/**
 * Criterion 8 — solodesk's existing argon2 hashes verify through the v8 password override.
 *
 * solodesk (services/backend-api/src/platform/auth/password.service.ts) hashes with the `argon2`
 * package (node-argon2, ^0.45.1) as `argon2.hash(plain, { type: argon2.argon2id })` — i.e. the
 * library defaults. The same package at the same version is used here, so the hashes below are
 * byte-for-byte what solodesk's production table holds, modulo salt.
 */
describe('C8 solodesk hashes under the v8 override', () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack();
  });
  afterAll(async () => {
    await stack?.stop();
  });

  /** A solodesk row: a verified user whose credential hash was minted by solodesk's code. */
  async function seedSolodeskUser(email: string, password: string): Promise<string> {
    const hash = await nodeArgon2.hash(password, { type: nodeArgon2.argon2id });
    const user = await stack.pool.query<{ id: string }>(
      `insert into identity."user" (id, name, email, email_verified, created_at, updated_at)
       values (uuidv7(), 'Household', $1, true, now(), now()) returning id`,
      [email],
    );
    await stack.pool.query(
      `insert into identity.account (id, account_id, provider_id, user_id, password, created_at, updated_at)
       values (uuidv7(), $1::text, 'credential', $2::uuid, $3, now(), now())`,
      [user.rows[0]!.id, user.rows[0]!.id, hash],
    );
    return hash;
  }

  it("solodesk's default parameters are NOT v8's baseline (so the override must read them from the hash)", async () => {
    const solodesk = await nodeArgon2.hash('x'.repeat(12), { type: nodeArgon2.argon2id });
    const v8 = await argon2Password.hash('x'.repeat(12));
    console.info(
      `[C8] solodesk: ${solodesk.split('$').slice(0, 4).join('$')}   v8: ${v8.split('$').slice(0, 4).join('$')}`,
    );
    expect(solodesk).toMatch(
      /^\$argon2id\$v=19\$m=65536,t=3,p=4\$|^\$argon2id\$v=19\$m=65536,p=4,t=3\$/,
    );
    expect(v8).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  });

  it('a solodesk user signs in with the existing hash, unchanged', async () => {
    const email = uniqueEmail('solodesk');
    const password = strongPassword();
    const hash = await seedSolodeskUser(email, password);
    const res = await signIn(stack.client(), email, password);
    expect(res.status, res.body).toBe(200);
    const after = await stack.pool.query<{ password: string }>(
      `select a.password from identity.account a join identity."user" u on u.id = a.user_id where u.email = $1`,
      [email],
    );
    // Better Auth has no rehash-on-login hook: the old hash stays. Fine here: solodesk's
    // parameters (64 MiB, t=3, p=4) are STRONGER than the v8 baseline, so no rehash is wanted.
    expect(after.rows[0]!.password).toBe(hash);
  });

  it('a wrong password against a solodesk hash is a plain 401', async () => {
    const email = uniqueEmail('solodesk-bad');
    await seedSolodeskUser(email, strongPassword());
    const res = await signIn(stack.client(), email, strongPassword());
    expect(res.status).toBe(401);
    expect(res.json()).toMatchObject({ code: 'INVALID_EMAIL_OR_PASSWORD' });
  });

  it('change-password keeps working and re-hashes with the v8 parameters', async () => {
    const email = uniqueEmail('solodesk-change');
    const password = strongPassword();
    const next = strongPassword();
    await seedSolodeskUser(email, password);
    const c = stack.client();
    expect((await signIn(c, email, password)).status).toBe(200);
    const res = await c.post('/api/auth/change-password', {
      currentPassword: password,
      newPassword: next,
    });
    expect(res.status, res.body).toBe(200);
    const { rows } = await stack.pool.query<{ password: string }>(
      `select a.password from identity.account a join identity."user" u on u.id = a.user_id where u.email = $1`,
      [email],
    );
    expect(rows[0]!.password).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect((await signIn(stack.client(), email, next)).status).toBe(200);
  });

  it("a hash in some OTHER format (bcrypt, Better Auth's scrypt) is a 401, never a 500", async () => {
    const email = uniqueEmail('legacy');
    const user = await stack.pool.query<{ id: string }>(
      `insert into identity."user" (id, name, email, email_verified, created_at, updated_at)
       values (uuidv7(), 'Legacy', $1, true, now(), now()) returning id`,
      [email],
    );
    await stack.pool.query(
      `insert into identity.account (id, account_id, provider_id, user_id, password, created_at, updated_at)
       values (uuidv7(), $1::text, 'credential', $2::uuid, $3, now(), now())`,
      [
        user.rows[0]!.id,
        user.rows[0]!.id,
        '$2b$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
      ],
    );
    const res = await signIn(stack.client(), email, strongPassword());
    expect(res.status).toBe(401);
  });

  it('cost: verify of a solodesk hash vs a v8 hash (measured, this machine)', async () => {
    const pw = strongPassword();
    const sd = await nodeArgon2.hash(pw, { type: nodeArgon2.argon2id });
    const v8 = await argon2Password.hash(pw);
    const time = async (fn: () => Promise<unknown>) => {
      const t = performance.now();
      for (let i = 0; i < 3; i += 1) await fn();
      return Math.round((performance.now() - t) / 3);
    };
    const tSd = await time(() => argon2Password.verify({ hash: sd, password: pw }));
    const tV8 = await time(() => argon2Password.verify({ hash: v8, password: pw }));
    console.info(
      `[C8 cost] verify solodesk-hash=${tSd}ms  v8-hash=${tV8}ms  (@node-rs/argon2 runs off the event loop)`,
    );
    expect(tSd).toBeLessThan(2000);
  });
});
