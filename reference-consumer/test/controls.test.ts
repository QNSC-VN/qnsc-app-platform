import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Proc} from './support/process';
import { eventually, sleep } from './support/process';
import { Stack } from './support/stack';

/**
 * Negative controls for async-path.test.ts: each flips ONE thing that a property of that file depends
 * on and shows the opposite outcome. A test that cannot fail proves nothing; these are why the passes
 * there mean something. They run on their own stack because they change it (the first drops the fault
 * injection).
 */
const stack = new Stack();
let worker: Proc;
const rand = () => randomBytes(4).toString('hex');
const address = (prefix: string) => `${prefix}-${rand()}@example.test`;

beforeAll(async () => {
  await stack.start();
  worker = await stack.worker('worker-controls');
});
afterAll(async () => {
  await stack.stop();
});

describe('controls', () => {
  it('rollback: WITHOUT the injected COMMIT failure, the same sign-up succeeds and its mail is sent', async () => {
    const failing = await stack.signUp(`rollback-${rand()}@example.test`, 'control-with-fault');
    expect(failing.status).toBe(500);

    await stack.admin.query('DROP TRIGGER user_fail_at_commit ON identity."user"');
    const email = `rollback-${rand()}@example.test`;
    const ok = await stack.signUp(email, 'control-without-fault');
    expect(ok.status).toBe(200);
    expect(await stack.mailTo(email, 1)).toHaveLength(1);
  });

  it('duplicate: WITHOUT the idempotency ledger, re-enqueuing a sent key sends a second mail', async () => {
    const to = address('no-ledger');
    const key = `nl-${rand()}`;
    await stack.notify({ to, key }, 'control-ledger-a');
    await stack.mailTo(to, 1);
    await eventually(async () => {
      if ((await stack.jobsFor(to)).length > 0) throw new Error('job still there');
    });

    // Wipe platform-mail's ledger (and nothing else it needs: the pacing bucket refills on its own).
    const { default: IORedis } = (await import('ioredis')) as unknown as {
      default: new (url: string) => {
        keys(pattern: string): Promise<string[]>;
        del(...keys: string[]): Promise<number>;
        disconnect(): void;
      };
    };
    const redis = new IORedis(stack.valkey.url);
    const ledger = (await redis.keys('m6:mail:sent:*')).filter(Boolean);
    expect(ledger.length).toBeGreaterThan(0);
    await redis.del(...ledger);
    redis.disconnect();

    await stack.notify({ to, key }, 'control-ledger-b');
    await stack.mailTo(to, 2, 30_000);
    await sleep(1_000);
    expect(await stack.mailpit.messagesTo(to)).toHaveLength(2);
    expect(worker.alive).toBe(true);
  });
});
