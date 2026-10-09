import { expect } from 'vitest';
import type { Client } from './client';
import type { Stack } from './stack';

/** 12+ characters, generated at call time: no credential is ever a literal in the repo. */
export function strongPassword(): string {
  return `pw-${crypto.randomUUID()}`;
}

export const API = '/api/auth';

export async function signUp(
  client: Client,
  email: string,
  password: string,
  name = 'Spike User',
): Promise<void> {
  const res = await client.post(`${API}/sign-up/email`, { email, password, name });
  expect(res.status, res.body).toBe(200);
}

export async function signIn(client: Client, email: string, password: string) {
  return client.post(`${API}/sign-in/email`, { email, password });
}

/** The single emailed link for `to`, after running the mail worker. */
export async function emailedLink(stack: Stack, to: string): Promise<string> {
  const sent = await stack.drainMail();
  const mail = sent.filter((m) => m.to === to);
  expect(mail, `mail for ${to}`).toHaveLength(1);
  return mail[0]!.text;
}

/** Register + verify + sign in; returns the signed-in client. */
export async function verifiedUser(stack: Stack, email: string, password: string): Promise<Client> {
  const c = stack.client();
  await signUp(c, email, password);
  const link = await emailedLink(stack, email);
  const verified = await c.get(link);
  expect([200, 302]).toContain(verified.status);
  const res = await signIn(c, email, password);
  expect(res.status, res.body).toBe(200);
  return c;
}

export const uniqueEmail = (tag: string): string =>
  `${tag}-${crypto.randomUUID().slice(0, 8)}@example.test`;
