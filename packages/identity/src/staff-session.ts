import { hasRequestState } from '@better-auth/core/context';
import { createAuthMiddleware, setShouldSkipSessionRefresh } from 'better-auth/api';
import type { BetterAuthPlugin } from 'better-auth';
import { DEFAULTS } from './defaults';
import { domainIn, emailDomain } from './domains';
import type { AccountContext } from './accounts';

/**
 * The 12-hour staff session cap, enforced where sessions are written (identity plan §5.4, review S2).
 *
 * Better Auth's lifetime is per instance, so in an instance that also serves public users it is the
 * public 7 days. A cap in a framework guard only covers routes behind that guard: Better Auth's own
 * endpoints (`get-session`, `list-sessions`, `update-user`) would still honour a 7-day session. So the
 * cap is applied in `databaseHooks.session.create.before` and `session.update.before`, and a refresh
 * (which would push `expiresAt` to now + 7 days) is clamped to `createdAt + 12 h`.
 *
 * STAFF means a user with a Microsoft (tenant-verified) account OR an email in `staff.domains`. Email
 * alone is not the definition: a public user cannot be capped by guessing their domain, and a tenant
 * member with another address is still staff.
 */
type Row = Record<string, unknown>;

interface HookContext {
  context?: {
    internalAdapter: {
      findUserById(id: string): Promise<{ email: string } | null>;
      findAccounts(userId: string): Promise<Array<{ providerId: string }>>;
      deleteSessions(tokens: string[]): Promise<unknown>;
    };
    adapter: {
      findOne(args: {
        model: string;
        where: Array<{ field: string; value: unknown }>;
      }): Promise<Row | null>;
      findMany(args: {
        model: string;
        where: Array<{ field: string; value: unknown }>;
      }): Promise<Row[]>;
    };
    secret: string;
    authCookies: { sessionToken: { name: string } };
  };
  getSignedCookie?: (name: string, secret: string) => Promise<string | null | undefined>;
}

export interface StaffSessionPolicy {
  staffDomains: readonly string[];
  /** Used when a hook runs outside a request (no endpoint context). */
  getContext: () => Promise<AccountContext>;
}

export function staffSessionHooks(policy: StaffSessionPolicy) {
  const capMs = DEFAULTS.session.staff.expiresInSeconds * 1000;

  // Inside a request the CONTEXT's adapter is used: it joins the sign-in transaction, so a brand-new
  // user and their new Microsoft account (not yet committed) are visible. The global one would not.
  async function isStaff(userId: string, context: HookContext | null): Promise<boolean> {
    const ia =
      context?.context?.internalAdapter ??
      ((await policy.getContext()).internalAdapter as unknown as NonNullable<
        HookContext['context']
      >['internalAdapter']);
    const [user, accounts] = await Promise.all([ia.findUserById(userId), ia.findAccounts(userId)]);
    if (accounts.some((a) => a.providerId === 'microsoft')) return true;
    return !!user && domainIn(emailDomain(user.email), policy.staffDomains);
  }

  const earliest = (a: Date, b: Date): Date => (a.getTime() <= b.getTime() ? a : b);

  return {
    create: {
      before: async (session: Row, context: HookContext | null) => {
        const userId = session['userId'];
        if (typeof userId !== 'string' || !(await isStaff(userId, context))) return;
        const requested =
          session['expiresAt'] instanceof Date
            ? session['expiresAt']
            : new Date(Date.now() + capMs);
        const created = session['createdAt'] instanceof Date ? session['createdAt'] : new Date();
        return { data: { expiresAt: earliest(requested, new Date(created.getTime() + capMs)) } };
      },
    },
    update: {
      before: async (data: Row, context: HookContext | null) => {
        if (!(data['expiresAt'] instanceof Date)) return;
        // Which session is being refreshed? The one in the request's cookie.
        const inner = context?.context;
        const token = await context?.getSignedCookie?.(
          inner?.authCookies.sessionToken.name ?? '',
          inner?.secret ?? '',
        );
        const row =
          token && inner
            ? await inner.adapter.findOne({
                model: 'session',
                where: [{ field: 'token', value: token }],
              })
            : null;
        if (!row || typeof row['userId'] !== 'string') return;
        if (!(await isStaff(row['userId'], context))) return;
        const created = row['createdAt'] instanceof Date ? row['createdAt'] : new Date();
        return {
          data: { expiresAt: earliest(data['expiresAt'], new Date(created.getTime() + capMs)) },
        };
      },
    },
  };
}

/** The slice of Better Auth's internal adapter the refresh guard needs. */
interface SessionAdapter {
  findSession(token: string): Promise<{
    session: { createdAt: Date | string; expiresAt: Date | string };
    user: { id?: unknown; email: string };
  } | null>;
  findAccounts(userId: string): Promise<Array<{ providerId: string }>>;
  findUserById(userId: string): Promise<{ id?: unknown; email: string } | null>;
  listSessions(
    userId: string,
    options?: unknown,
  ): Promise<Array<{ createdAt: Date | string; expiresAt: Date | string }>>;
}

/** How long "is this user staff?" is remembered per process, and for how many users. */
const CLASSIFICATION_TTL_MS = 30_000;
const CLASSIFICATION_MAX = 10_000;

/**
 * Is this user staff? A staff-domain email says so for free. Otherwise it takes a query for a
 * Microsoft account, and THAT answer is remembered per process for 30 s: without it, every request
 * of every public user whose session is older than the cap would pay one `account` lookup (the
 * cookie cache is off in an instance with `staff`, so every request reaches the store). The memo can
 * only be stale in the direction of a user who has JUST become staff, and the hooks below revoke the
 * sessions that were living on a public lifetime at that moment, so nothing relies on it being fresh.
 */
export function staffClassifier(policy: StaffSessionPolicy) {
  const memo = new Map<string, { staff: boolean; until: number }>();
  const remember = (userId: string, staff: boolean) => {
    if (memo.size >= CLASSIFICATION_MAX) memo.delete(memo.keys().next().value as string);
    memo.set(userId, { staff, until: Date.now() + CLASSIFICATION_TTL_MS });
  };
  return {
    remember,
    async classify(
      adapter: Pick<SessionAdapter, 'findAccounts'>,
      user: { id?: unknown; email: string },
    ): Promise<boolean> {
      if (domainIn(emailDomain(user.email), policy.staffDomains)) return true;
      const id = user.id;
      if (typeof id !== 'string') return false;
      const hit = memo.get(id);
      if (hit && hit.until > Date.now()) return hit.staff;
      const staff = (await adapter.findAccounts(id)).some((a) => a.providerId === 'microsoft');
      remember(id, staff);
      return staff;
    },
  };
}

export type StaffClassifier = ReturnType<typeof staffClassifier>;

type SessionContext = { sessionConfig: { expiresIn: number; updateAge: number } };

/**
 * The staff cap, enforced when a session is READ, and a staff session at its cap never refreshed.
 *
 * Two decisions, both made in `findSession`, the one place the loaded session and its user are in
 * hand without a second read; and both only for the sessions that can need them:
 *
 * 1. ENFORCE. A staff session is dead once `createdAt + 12 h` has passed, whatever its stored
 *    `expiresAt` says. The clamp in `update.before` only runs when Better Auth refreshes, which for a
 *    session on a long lifetime is once an `updateAge` (a day, or a week in a staff-only instance),
 *    and the read that triggers it answers 200 with the row it just wrote. So a user who BECOMES
 *    staff mid-session (a staff-provider account linked, an email moved into `staff.domains`), or an
 *    instance that gains the `staff` preset while 7-day sessions live, kept a long session for up to
 *    that long. Now such a session comes back with `expiresAt = createdAt + cap`, Better Auth's own
 *    expiry check deletes it and answers `null`. The staff test runs only for a session OLDER than
 *    its cap that still stores a later expiry: never for a young session, nor one already at its cap.
 * 2. DO NOT REWRITE. A staff session at its cap needs no refresh (Better Auth would ask on every
 *    read, and `update.before` would write the same expiry back: an UPDATE, two Valkey writes and a
 *    Set-Cookie per request), so the refresh is switched off for the request with Better Auth's own
 *    `setShouldSkipSessionRefresh`. A staff session still holding a later expiry inside its first 12 h
 *    is NOT skipped: the refresh runs once and the clamp brings it to the cap.
 *
 * Public sessions, and any non-staff session, keep Better Auth's behaviour.
 */
export function staffRefreshGuard(
  policy: StaffSessionPolicy,
  classifier: StaffClassifier = staffClassifier(policy),
): BetterAuthPlugin & { install(context: object): void } {
  const capMs = DEFAULTS.session.staff.expiresInSeconds * 1000;
  const wrapped = new WeakSet<object>();

  // Wrap `internalAdapter.findSession` once. Better Auth rebuilds `internalAdapter` after plugin
  // `init`, so `init` cannot do it; it is done as soon as the instance's context resolves, and again
  // (idempotently) from a `before` hook, which no request can precede.
  function install(context: object): void {
    const ctx = context as SessionContext & { internalAdapter: SessionAdapter };
    const adapter = ctx.internalAdapter;
    if (!adapter || wrapped.has(adapter)) return;
    wrapped.add(adapter);
    const find = adapter.findSession.bind(adapter);
    adapter.findSession = async (token) => {
      const found = await find(token);
      if (!found) return found;
      const { sessionConfig } = ctx;
      const expiresAt = new Date(found.session.expiresAt).getTime();
      const capAt = new Date(found.session.createdAt).getTime() + capMs;
      const overCap = expiresAt > capAt;
      const pastCap = capAt < Date.now();
      const due =
        expiresAt - (sessionConfig.expiresIn - sessionConfig.updateAge) * 1000 <= Date.now();
      const mustDie = overCap && pastCap;
      const skippable = !overCap && due;
      if (!mustDie && !skippable) return found;
      if (!(await classifier.classify(adapter, found.user))) return found;
      if (mustDie) {
        return { ...found, session: { ...found.session, expiresAt: new Date(capAt) } };
      }
      // Outside a request (a product calling `internalAdapter.findSession` directly) there is no
      // request state to set, and setting it throws.
      if (await hasRequestState()) await setShouldSkipSessionRefresh(true);
      return found;
    };

    // `list-sessions` and the admin's `list-user-sessions` list from the store, which knows the stored
    // expiry and not the cap: a staff sibling past its cap would be listed as an active session
    // (and offered for revocation as one). It is dead, so it is not listed.
    const list = adapter.listSessions.bind(adapter);
    adapter.listSessions = async (userId, options) => {
      const sessions = await list(userId, options);
      const pastCap = (s: { createdAt: Date | string }) =>
        new Date(s.createdAt).getTime() + capMs < Date.now();
      if (!sessions.some(pastCap)) return sessions; // nothing old enough to be wrong: no lookup
      const user = await adapter.findUserById(userId);
      if (!user || !(await classifier.classify(adapter, { ...user, id: userId }))) return sessions;
      return sessions.filter((s) => !pastCap(s));
    };
  }

  return {
    id: 'qnsc-staff-refresh-guard',
    install,
    hooks: {
      before: [
        {
          matcher: () => true,
          handler: createAuthMiddleware(async (ctx) => {
            install(ctx.context);
          }),
        },
      ],
    },
  };
}

/**
 * When a user BECOMES staff, the sessions they already hold were issued on a public lifetime. The
 * read-time check above would end them within 12 h of their creation anyway; this ends them now, so
 * the user signs in again as staff. "Becomes staff" is: a staff-provider (Microsoft) account is
 * linked, or the email is moved onto a staff domain.
 *
 * Only the sessions that are NOT staff-shaped are revoked (stored expiry beyond `createdAt + cap`),
 * never all of them: a user who was already staff (by domain) keeps their capped sessions on other
 * devices, and a session issued by the very sign-in that linked the account would be capped too. The
 * sessions are read from the DATABASE, not through the secondary storage, which a restart or outage
 * would make look empty.
 */
export function staffBecameHooks(policy: StaffSessionPolicy, classifier: StaffClassifier) {
  const capMs = DEFAULTS.session.staff.expiresInSeconds * 1000;

  async function revokeUncapped(userId: string, context: HookContext | null): Promise<void> {
    const inner =
      context?.context ??
      ((await policy.getContext()) as unknown as NonNullable<HookContext['context']>);
    const rows = await inner.adapter.findMany({
      model: 'session',
      where: [{ field: 'userId', value: userId }],
    });
    const tokens = rows
      .filter((r) => {
        const created = r['createdAt'];
        const expires = r['expiresAt'];
        return (
          typeof r['token'] === 'string' &&
          created instanceof Date &&
          expires instanceof Date &&
          expires.getTime() > created.getTime() + capMs
        );
      })
      .map((r) => r['token'] as string);
    if (tokens.length > 0) await inner.internalAdapter.deleteSessions(tokens);
  }

  return {
    account: {
      create: {
        after: async (account: Row, context: HookContext | null) => {
          const userId = account['userId'];
          if (account['providerId'] !== 'microsoft' || typeof userId !== 'string') return;
          classifier.remember(userId, true);
          await revokeUncapped(userId, context);
        },
      },
    },
    user: {
      update: {
        after: async (user: Row | null, context: HookContext | null) => {
          const id = user?.['id'];
          const email = user?.['email'];
          if (typeof id !== 'string' || typeof email !== 'string') return;
          if (!domainIn(emailDomain(email), policy.staffDomains)) return;
          await revokeUncapped(id, context);
        },
      },
    },
  };
}
