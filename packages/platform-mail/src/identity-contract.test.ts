import type {
  EmailMessage as IdentityEmailMessage,
  EmailSender as IdentityEmailSender,
} from '@quynhonsemiconductor/identity';
import { describe, expect, it } from 'vitest';
import { createGraphSender } from './graph';
import type { EmailMessage, EmailSender } from './message';
import { MemoryEmailSender } from './testing';

/**
 * `identity` v8 names its own `EmailSender` port and says `platform-mail` satisfies it. These are
 * the REAL types, imported from identity (a type-only devDependency: neither package depends on
 * the other at runtime). The assignments are checked by `tsc` (`pnpm typecheck` runs
 * tsconfig.test.json), so a change on either side that breaks the contract fails the build.
 */
describe('the identity v8 EmailSender port', () => {
  const message: IdentityEmailMessage = {
    to: 'user@example.test',
    subject: 'Verify your email',
    html: '<p>x</p>',
    text: 'x',
    category: 'auth.verify-email',
    idempotencyKey: 'verify-email:0190f3a2-0000-7000-8000-000000000000:' + 'a'.repeat(64),
  };

  it("every transport is assignable to identity's port", async () => {
    const memory: IdentityEmailSender = new MemoryEmailSender();
    const graph: IdentityEmailSender = createGraphSender({
      sender: 'noreply-academy@qnsc.vn',
      credential: { getToken: async () => ({ token: 't' }) },
      fetch: async () => new Response(null, { status: 202 }),
    });
    // ...and so is anything typed as our contract.
    const viaContract = (sender: EmailSender): IdentityEmailSender => sender;
    expect(viaContract).toBeTypeOf('function');

    await expect(memory.send(message)).resolves.toMatchObject({ id: expect.any(String) });
    await expect(graph.send(message)).resolves.toMatchObject({ id: expect.any(String) });
  });

  it("identity's message is assignable to ours, and its categories are valid", async () => {
    const ours: EmailMessage = message;
    const sender = new MemoryEmailSender();
    await sender.send(ours);
    await sender.send({
      ...ours,
      category: 'auth.reset-password',
      idempotencyKey: 'reset-password:u:h',
    });

    expect(sender.sent.map((m) => m.category)).toEqual([
      'auth.verify-email',
      'auth.reset-password',
    ]);
  });

  it('identity’s message plus a correlationId is still ours, and the field survives validation', async () => {
    // `correlationId` is optional in both: identity can add it without this package changing.
    const withId: IdentityEmailMessage & { correlationId?: string } = {
      ...message,
      correlationId: 'req-1',
    };
    const ours: EmailMessage = withId;
    const sender = new MemoryEmailSender();
    await sender.send(ours);

    expect(sender.sent[0]?.correlationId).toBe('req-1');
  });

  it("the result carries identity's { id } and a transport name besides", async () => {
    const result = await new MemoryEmailSender().send(message);
    expect(Object.keys(result).sort()).toEqual(['id', 'transport']);
  });
});
