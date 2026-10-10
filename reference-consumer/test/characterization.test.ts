import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Stack } from './support/stack';

/**
 * CHARACTERIZATION of two behaviours of the published packages that the documentation does not
 * describe. They assert what happens TODAY, so a change is noticed. If one starts failing because the
 * behaviour was fixed, flip the assertion (and close the issue named next to it).
 *
 * No worker runs here: nothing picks a job up, which is the point of the second test.
 */
const stack = new Stack();
const rand = () => randomBytes(3).toString('hex');

beforeAll(async () => {
  await stack.start();
});
afterAll(async () => {
  await stack.stop();
});

describe('characterization (no worker)', () => {
  it('a mail.send job nobody has picked up is kept for 14 days, bearer link in clear', async () => {
    // ADR 0002 decision 4 bounds the bearer link in a job row: completed jobs are deleted at once and
    // failed or dead-lettered ones kept at most 24 h. A job still in `created`/`retry` is governed by
    // pg-boss's `retentionSeconds` instead, which platform-jobs' retention options do not set: 14 days.
    const email = `keep-${rand()}@example.test`;
    expect((await stack.signUp(email, 'char-retention')).status).toBe(200);

    const { rows } = await stack.admin.query(
      `SELECT state,
              round(extract(epoch FROM (keep_until - now())) / 86400, 1)::float AS days,
              data->>'text' AS text
         FROM pgboss.job WHERE name = 'mail.send' AND data->>'to' = $1`,
      [email],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe('created');
    expect(rows[0].days).toBeGreaterThan(13); // 14 days, not 24 hours
    expect(rows[0].text).toContain('/api/auth/verify-email?token='); // the credential, in clear

    // The queue itself says so: the configuration platform-mail sets leaves `retention_seconds` at the default.
    const queue = await stack.admin.query(
      `SELECT retention_seconds, deletion_seconds FROM pgboss.queue WHERE name = 'mail.send'`,
    );
    expect(queue.rows[0].retention_seconds).toBe(14 * 24 * 3600);
    expect(queue.rows[0].deletion_seconds).toBe(24 * 3600);
  });

  it('when the enqueue fails in SQL inside the sign-up transaction, sign-up still answers 200 with a user that does not exist', async () => {
    // Better Auth swallows what an email callback throws (ADR 0002 criterion 9), and a SQL error inside
    // a transaction aborts it: the COMMIT that follows is a silent ROLLBACK. So the API reports an
    // account that was never created. Reproduced by taking INSERT on the job table away from the
    // application role; a missing grant, a schema mismatch or a deadlock do the same.
    await stack.admin.query('REVOKE INSERT ON ALL TABLES IN SCHEMA pgboss FROM m6_app');
    try {
      const email = `phantom-${rand()}@example.test`;
      const id = `char-phantom-${rand()}`;
      const res = await stack.signUp(email, id);

      expect(res.status).toBe(200);
      const body = (await res.json()) as { user?: { email: string; emailVerified: boolean } };
      expect(body.user).toMatchObject({ email, emailVerified: false }); // "created"

      const users = await stack.admin.query('SELECT 1 FROM identity."user" WHERE email = $1', [email]);
      expect(users.rowCount).toBe(0); // it was not

      // The cause is logged, with the request's id, as identity.mail_enqueue_failed (README promises this).
      const failure = await stack.api.waitFor(/mail_enqueue_failed/, 10_000, id);
      expect(failure['level']).toBe(50);
    } finally {
      await stack.admin.query('GRANT INSERT ON ALL TABLES IN SCHEMA pgboss TO m6_app');
    }
  });
});
