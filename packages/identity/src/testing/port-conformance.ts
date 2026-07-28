/**
 * Port conformance suites — the behaviour a product's real adapters must have.
 *
 * The port interfaces pin method NAMES and TYPES; the compiler checks those. What
 * they cannot express is the semantics the shared auth logic depends on, and those
 * are where a Drizzle adapter silently gets it wrong: a `revokeByIdIfActive` that
 * returns `true` unconditionally still typechecks, and turns single-use refresh
 * rotation into a token that can be replayed for ever.
 *
 * So each suite is exported for a consumer to run against its own implementation:
 *
 * ```ts
 * import { describeAuthSessionRepositoryContract } from '@qnsc-vn/identity/testing';
 *
 * describeAuthSessionRepositoryContract({
 *   name: 'AuthSessionDrizzleRepository',
 *   create: async () => new AuthSessionDrizzleRepository(db),
 * });
 * ```
 *
 * `describe`/`it`/`expect` are taken from the caller's vitest globals rather than
 * imported here, so this file adds no test-framework dependency to the package's
 * runtime and works in whichever project runs it.
 */
import type { AuthSession, CreateSessionInput, User } from '../domain-types';
import type { IAuthSessionRepository, IUserRepository } from '../repository-ports';

/** Minimal vitest surface these suites need, declared so the package needs no globals types. */
interface TestApi {
  describe: (name: string, fn: () => void) => void;
  it: (name: string, fn: () => void | Promise<void>) => void;
  expect: (actual: unknown) => {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toBeNull(): void;
  };
  beforeEach: (fn: () => void | Promise<void>) => void;
}

function testApi(): TestApi {
  const g = globalThis as unknown as Partial<TestApi>;
  if (!g.describe || !g.it || !g.expect || !g.beforeEach) {
    throw new Error(
      'Port conformance suites need vitest globals. Enable `test.globals: true` in the ' +
        'consuming vitest config, or wrap the suite in your own describe with globals on.',
    );
  }
  return g as TestApi;
}

export interface SessionContractOptions<Tx = unknown> {
  /** Shown in the describe title, e.g. the adapter class name. */
  name: string;
  /** Fresh, EMPTY repository per test. A shared one makes ordering matter. */
  create: () => Promise<IAuthSessionRepository<Tx>> | IAuthSessionRepository<Tx>;
}

/**
 * The session semantics refresh-token rotation depends on. Every assertion here
 * corresponds to a real failure mode, not to a method existing.
 */
export function describeAuthSessionRepositoryContract<Tx = unknown>(
  options: SessionContractOptions<Tx>,
): void {
  const { describe, it, expect, beforeEach } = testApi();

  describe(`${options.name} satisfies IAuthSessionRepository`, () => {
    let repo: IAuthSessionRepository<Tx>;

    const input = (overrides: Partial<CreateSessionInput> = {}): CreateSessionInput => ({
      id: 'session-1',
      contextId: 'context-1',
      userId: 'user-1',
      tokenHash: 'hash-1',
      familyId: 'family-1',
      expiresAt: new Date(Date.now() + 60_000),
      ...overrides,
    });

    beforeEach(async () => {
      repo = await options.create();
    });

    it('finds a created session by its token hash', async () => {
      await repo.create(input());
      const found = await repo.findByTokenHash('hash-1');
      expect(found?.id).toBe('session-1');
      expect(found?.isRevoked).toBe(false);
    });

    it('returns null for an unknown token hash rather than throwing', async () => {
      // The refresh path treats null as "reuse or forgery" and must reach that
      // branch; an adapter that throws turns a 401 into a 500.
      expect(await repo.findByTokenHash('never-issued')).toBeNull();
    });

    it('revokeByIdIfActive wins exactly once', async () => {
      // THE rotation contract. Two concurrent refreshes present the same token;
      // only one may proceed. An adapter returning `true` both times lets a stolen
      // refresh token be replayed indefinitely.
      await repo.create(input());
      expect(await repo.revokeByIdIfActive('session-1')).toBe(true);
      expect(await repo.revokeByIdIfActive('session-1')).toBe(false);
    });

    it('revokeByIdIfActive reports false for a session that never existed', async () => {
      expect(await repo.revokeByIdIfActive('missing')).toBe(false);
    });

    it('revokeFamily revokes every session in the family and nothing outside it', async () => {
      // Theft detection revokes the whole family. Over-revoking logs out unrelated
      // sessions; under-revoking leaves the thief's descendant alive.
      await repo.create(input({ id: 's1', tokenHash: 'h1', familyId: 'family-a' }));
      await repo.create(input({ id: 's2', tokenHash: 'h2', familyId: 'family-a' }));
      await repo.create(input({ id: 's3', tokenHash: 'h3', familyId: 'family-b' }));

      await repo.revokeFamily('family-a');

      expect((await repo.findByTokenHash('h1'))?.isRevoked).toBe(true);
      expect((await repo.findByTokenHash('h2'))?.isRevoked).toBe(true);
      expect((await repo.findByTokenHash('h3'))?.isRevoked).toBe(false);
    });

    it('revokeAllForUser revokes across families but only for that user', async () => {
      // Offboarding. Scoping this wrongly either leaves a departed employee signed
      // in or signs out the whole tenant.
      await repo.create(input({ id: 's1', tokenHash: 'h1', userId: 'user-1', familyId: 'f1' }));
      await repo.create(input({ id: 's2', tokenHash: 'h2', userId: 'user-1', familyId: 'f2' }));
      await repo.create(input({ id: 's3', tokenHash: 'h3', userId: 'user-2', familyId: 'f3' }));

      await repo.revokeAllForUser('user-1');

      expect((await repo.findByTokenHash('h1'))?.isRevoked).toBe(true);
      expect((await repo.findByTokenHash('h2'))?.isRevoked).toBe(true);
      expect((await repo.findByTokenHash('h3'))?.isRevoked).toBe(false);
    });

    it('revokeById is idempotent', async () => {
      await repo.create(input());
      await repo.revokeById('session-1');
      await repo.revokeById('session-1');
      expect((await repo.findByTokenHash('hash-1'))?.isRevoked).toBe(true);
    });
  });
}

export interface UserContractOptions<Tx = unknown> {
  name: string;
  /**
   * Fresh repository per test, seeded with `seed` so the suite does not depend on
   * a create method the port does not expose.
   */
  create: (seed: User[]) => Promise<IUserRepository<Tx>> | IUserRepository<Tx>;
  /** A user the suite can look up; must have a stable `id` and `email`. */
  seedUser: User;
}

/** The user-lookup and JIT-provisioning semantics the SSO login path depends on. */
export function describeUserRepositoryContract<Tx = unknown>(
  options: UserContractOptions<Tx>,
): void {
  const { describe, it, expect, beforeEach } = testApi();

  describe(`${options.name} satisfies IUserRepository`, () => {
    let repo: IUserRepository<Tx>;
    const seeded = options.seedUser;

    beforeEach(async () => {
      repo = await options.create([seeded]);
    });

    it('finds a seeded user by id and by email', async () => {
      expect((await repo.findById(seeded.id))?.id).toBe(seeded.id);
      expect((await repo.findByEmail(seeded.email))?.id).toBe(seeded.id);
    });

    it('returns null for unknown lookups rather than throwing', async () => {
      expect(await repo.findById('nobody')).toBeNull();
      expect(await repo.findByEmail('nobody@example.test')).toBeNull();
    });

    it('findSsoIdentity returns null before any link exists', async () => {
      expect(await repo.findSsoIdentity('entra', 'oid-unknown')).toBeNull();
    });

    it('upsertBySsoIdentity is idempotent for the same identity', async () => {
      // A user signing in twice — or two tabs racing the first login — must not
      // produce two users. The real adapter gets this from a unique constraint.
      const first = await repo.upsertBySsoIdentity('entra', 'oid-1', 'new@example.test', 'New');
      const second = await repo.upsertBySsoIdentity('entra', 'oid-1', 'new@example.test', 'New');
      expect(second.id).toBe(first.id);
    });

    it('upsertBySsoIdentity links to the EXISTING user when the email already exists', async () => {
      // Otherwise an invited user who then signs in via SSO gets a second account
      // and loses every grant attached to the first.
      const linked = await repo.upsertBySsoIdentity(
        'entra',
        'oid-2',
        seeded.email,
        seeded.displayName,
      );
      expect(linked.id).toBe(seeded.id);
      expect((await repo.findSsoIdentity('entra', 'oid-2'))?.userId).toBe(seeded.id);
    });

    it('updateProfile returns the updated row', async () => {
      const updated = await repo.updateProfile(seeded.id, { displayName: 'Renamed' });
      expect(updated.displayName).toBe('Renamed');
      expect((await repo.findById(seeded.id))?.displayName).toBe('Renamed');
    });

    it('updateLastLogin does not change identity fields', async () => {
      await repo.updateLastLogin(seeded.id);
      const after = await repo.findById(seeded.id);
      expect(after?.id).toBe(seeded.id);
      expect(after?.email).toBe(seeded.email);
    });
  });
}

/** Re-exported so a consumer can type its own fixtures without deep imports. */
export type { AuthSession, CreateSessionInput, User };
