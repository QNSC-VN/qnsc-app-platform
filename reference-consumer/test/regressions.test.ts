import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Stack } from './support/stack';

/**
 * REGRESSION tests for two behaviours of the published packages that the first M6 run found wrong
 * and that a release has since fixed. They were characterization tests (they asserted the BUG, so a
 * change would be noticed); they now assert the fix, so the bug coming back is noticed.
 *
 *   #192  a `mail.send` job nobody picks up was kept 14 days with the verification link in clear
 *         -> fixed by `retention.pending` (platform-jobs 0.1.2, platform-mail 0.1.2)
 *   #191  a SQL error while enqueuing inside the sign-up transaction answered 200 with a user that
 *         did not exist -> fixed in identity 8.0.1 (a transaction that cannot commit answers 5xx,
 *         with the platform error envelope added to Better Auth's body)
 *
 * No worker runs here: nothing picks a job up, which is the point of the first test.
 */
const stack = new Stack();
const rand = () => randomBytes(3).toString('hex');

beforeAll(async () => {
  await stack.start();
});
afterAll(async () => {
  await stack.stop();
});

const DAY_SECONDS = 24 * 3600;

describe('regressions (no worker)', () => {
  it('a mail.send job nobody has picked up is kept at most 24 hours (#192)', async () => {
    // ADR 0002 decision 4 bounds the bearer link in a job row at 24 h: completed jobs are deleted at
    // once and failed or dead-lettered ones kept at most 24 h. A job still in `created`/`retry` is
    // governed by pg-boss's `retentionSeconds` instead; it used to be left at the default, 14 days.
    const email = `keep-${rand()}@example.test`;
    expect((await stack.signUp(email, 'reg-retention')).status).toBe(200);

    const { rows } = await stack.admin.query(
      `SELECT state,
              extract(epoch FROM (keep_until - now()))::float AS seconds
         FROM pgboss.job WHERE name = 'mail.send' AND data->>'to' = $1`,
      [email],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe('created'); // really unprocessed: this is the retention that applies
    expect(rows[0].seconds).toBeGreaterThan(0);
    expect(rows[0].seconds).toBeLessThanOrEqual(DAY_SECONDS);

    // The queue says the same, so the bound is configuration, not an accident of this row.
    const queue = await stack.admin.query(
      `SELECT retention_seconds, deletion_seconds FROM pgboss.queue WHERE name = 'mail.send'`,
    );
    expect(queue.rows[0].retention_seconds).toBeLessThanOrEqual(DAY_SECONDS);
    expect(queue.rows[0].deletion_seconds).toBeLessThanOrEqual(DAY_SECONDS);
  });

  it('when the enqueue fails in SQL inside the sign-up transaction, sign-up answers 500 and creates no user and no job (#191)', async () => {
    // Better Auth swallows what an email callback throws (ADR 0002 criterion 9), and a SQL error inside
    // a transaction aborts it: the COMMIT that follows used to be a silent ROLLBACK, so the API
    // reported an account that was never created. Reproduced by taking INSERT on the job table away
    // from the application role; a missing grant, a schema mismatch or a deadlock do the same.
    const email = `phantom-${rand()}@example.test`;
    const id = `reg-phantom-${rand()}`;
    await stack.admin.query('REVOKE INSERT ON ALL TABLES IN SCHEMA pgboss FROM m6_app');
    try {
      const res = await stack.signUp(email, id);

      expect(res.status).toBe(500);
      // The hybrid body: Better Auth's own top-level `code`/`message` (what better-auth/client reads)
      // AND the platform envelope next to it, with this request's correlation id.
      const body = (await res.json()) as {
        code?: string;
        message?: string;
        error?: { code?: string; message?: string; correlationId?: string };
      };
      expect(body.code).toBe('INTERNAL_ERROR');
      expect(body.error?.code).toBe('INTERNAL_ERROR');
      expect(body.error?.correlationId).toBe(id);
      // Nothing about the cause is on the wire: it is in the log.
      const wire = JSON.stringify(body);
      expect(wire).not.toMatch(/pgboss|permission denied|INSERT|m6_app/i);

      // And nothing was created: no user, and no job for that address.
      const users = await stack.admin.query('SELECT 1 FROM identity."user" WHERE email = $1', [email]);
      expect(users.rowCount).toBe(0);
      const jobs = await stack.admin.query(
        `SELECT 1 FROM pgboss.job WHERE name = 'mail.send' AND data->>'to' = $1`,
        [email],
      );
      expect(jobs.rowCount).toBe(0);

      // The cause is logged, with the request's id, as identity.mail_enqueue_failed (README promises this).
      const failure = await stack.api.waitFor(/mail_enqueue_failed/, 10_000, id);
      expect(failure['level']).toBe(50);
    } finally {
      await stack.admin.query('GRANT INSERT ON ALL TABLES IN SCHEMA pgboss TO m6_app');
    }

    // Control: with the grant back, the same call succeeds. So the 500 above was the missing grant.
    const ok = `recovered-${rand()}@example.test`;
    expect((await stack.signUp(ok, `reg-recovered-${rand()}`)).status).toBe(200);
    const created = await stack.admin.query('SELECT 1 FROM identity."user" WHERE email = $1', [ok]);
    expect(created.rowCount).toBe(1);
  });
});
