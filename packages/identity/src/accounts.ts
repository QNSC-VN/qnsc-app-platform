import { DEFAULTS } from './defaults';
import { emitSafely, type SecurityEventSink } from './events';

/**
 * The slice of Better Auth's context these rules need. Typed structurally so it is satisfied by
 * `await auth.$context` and by a fake in a unit test.
 */
export interface AccountContext {
  internalAdapter: {
    findUserByEmail(
      email: string,
      options: { includeAccounts: true },
    ): Promise<{
      user: { id: string; emailVerified: boolean };
      accounts: Array<{ providerId: string }>;
    } | null>;
    deleteUser(userId: string): Promise<unknown>;
  };
  adapter: {
    findMany(args: {
      model: string;
      where?: Array<{ field: string; operator?: string; value: unknown }>;
      limit?: number;
    }): Promise<Array<{ id: string }>>;
  };
}

export type ContextProvider = () => Promise<AccountContext>;

/**
 * An UNVERIFIED password account proves nothing about its owner (ADR 0002, decision 2): password
 * sign-in is refused until the address is verified, so such an account has never held a session.
 * It is replaceable only if that still holds — unverified, nothing but credential accounts, no
 * session — so a user created unverified by SSO (which does have sessions and an SSO account) is
 * never touched.
 */
async function replaceable(
  ctx: AccountContext,
  userId: string,
  accounts: Array<{ providerId: string }>,
) {
  if (accounts.some((a) => a.providerId !== 'credential')) return false;
  // The DATABASE decides, not `internalAdapter.listSessions`: with secondary storage that reads
  // Valkey, where a restart or an outage looks like "no sessions" and would delete a used account.
  const sessions = await ctx.adapter.findMany({
    model: 'session',
    where: [{ field: 'userId', value: userId }],
    limit: 1,
  });
  return sessions.length === 0;
}

/**
 * Rule 2. Call this when a provider has just ASSERTED a verified email (Entra, Google, verified
 * SSO). If the only existing account for that email is a replaceable squatter, delete it and let
 * sign-in continue as a new user. Returns whether an account was removed.
 */
export async function replaceUnverifiedAccount(
  getContext: ContextProvider,
  sink: SecurityEventSink,
  email: string,
): Promise<boolean> {
  const ctx = await getContext();
  const found = await ctx.internalAdapter.findUserByEmail(email.toLowerCase(), {
    includeAccounts: true,
  });
  if (!found || found.user.emailVerified) return false;
  if (!(await replaceable(ctx, found.user.id, found.accounts))) return false;
  await ctx.internalAdapter.deleteUser(found.user.id);
  await emitSafely(sink, { name: 'account.unverified_replaced', userId: found.user.id });
  return true;
}

/**
 * Rule 3. Delete replaceable accounts created more than `olderThanHours` ago. Scheduled hourly by
 * `registerIdentityJobs`; safe to run any number of times concurrently (a second run finds nothing).
 */
export async function purgeWith(
  getContext: ContextProvider,
  sink: SecurityEventSink,
  options: { now?: Date; olderThanHours?: number } = {},
): Promise<number> {
  const ctx = await getContext();
  const now = options.now ?? new Date();
  const hours = options.olderThanHours ?? DEFAULTS.unverifiedAccountTtlHours;
  const cutoff = new Date(now.getTime() - hours * 3600_000);
  const candidates = await ctx.adapter.findMany({
    model: 'user',
    where: [
      { field: 'emailVerified', value: false },
      { field: 'createdAt', operator: 'lt', value: cutoff },
    ],
    limit: 500,
  });
  let purged = 0;
  for (const { id } of candidates) {
    const accounts = await ctx.adapter.findMany({
      model: 'account',
      where: [{ field: 'userId', value: id }],
    });
    if (!(await replaceable(ctx, id, accounts as unknown as Array<{ providerId: string }>)))
      continue;
    await ctx.internalAdapter.deleteUser(id);
    purged += 1;
    await emitSafely(sink, { name: 'account.unverified_purged', userId: id });
  }
  return purged;
}
