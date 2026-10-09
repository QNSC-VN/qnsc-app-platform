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
