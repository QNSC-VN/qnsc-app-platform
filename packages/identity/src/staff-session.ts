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
    };
    adapter: {
      findOne(args: {
        model: string;
        where: Array<{ field: string; value: unknown }>;
      }): Promise<Row | null>;
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
    user: { email: string };
  } | null>;
  findAccounts(userId: string): Promise<Array<{ providerId: string }>>;
}

/**
 * A staff session never needs refreshing, so it must not be refreshed.
 *
 * Better Auth refreshes a session on `get-session` once `expiresAt - expiresIn + updateAge <= now`.
 * For a staff session `expiresAt` is `createdAt + 12 h`, always at least as old as that threshold
 * in an instance whose lifetime is the public 7 days, and after the first hour in a staff-only one.
 * So every read of a staff session asked for a refresh to `now + 7 d`, which `update.before` above
 * clamped back to the SAME `createdAt + 12 h`: a database UPDATE, two Valkey writes and a
 * Set-Cookie per request, to change nothing. (Measured: see the PR for #N1.)
 *
 * The clamp stays as the guarantee, and is now idempotent: when the session Better Auth has just
 * loaded is a staff session already at or under its cap, the refresh is switched off for that
 * request (`setShouldSkipSessionRefresh`, Better Auth's own request-scoped switch). A session over
 * its cap (created before the cap existed) is NOT skipped: the refresh runs once, is clamped, and
 * the next read finds it at the cap. Public sessions keep their sliding refresh.
 *
 * The decision hangs on `findSession`, the one place the loaded session and its user are in hand
 * without a second read; the staff test costs a query only when the session was about to refresh.
 */
export function staffRefreshGuard(policy: StaffSessionPolicy): BetterAuthPlugin {
  const capMs = DEFAULTS.session.staff.expiresInSeconds * 1000;
  const wrapped = new WeakSet<object>();

  return {
    id: 'qnsc-staff-refresh-guard',
    hooks: {
      before: [
        {
          matcher: () => true,
          handler: createAuthMiddleware(async (ctx) => {
            const adapter = ctx.context.internalAdapter as unknown as SessionAdapter;
            if (wrapped.has(adapter)) return;
            wrapped.add(adapter);
            const { sessionConfig } = ctx.context;
            const find = adapter.findSession.bind(adapter);
            adapter.findSession = async (token) => {
              const found = await find(token);
              if (!found) return found;
              const expiresAt = new Date(found.session.expiresAt).getTime();
              const createdAt = new Date(found.session.createdAt).getTime();
              // Not about to refresh, or past its cap: nothing to decide here.
              const due = expiresAt - (sessionConfig.expiresIn - sessionConfig.updateAge) * 1000;
              if (due > Date.now() || expiresAt > createdAt + capMs) return found;
              const userId = (found.user as { id?: unknown }).id;
              const staff =
                domainIn(emailDomain(found.user.email), policy.staffDomains) ||
                (typeof userId === 'string' &&
                  (await adapter.findAccounts(userId)).some((a) => a.providerId === 'microsoft'));
              if (staff) await setShouldSkipSessionRefresh(true);
              return found;
            };
          }),
        },
      ],
    },
  };
}
