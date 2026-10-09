import type { TestClient } from './client';
import { API, type Stack } from './harness';

type Expect = (actual: unknown, message?: string) => { toBe(expected: unknown): void };

/** Register, verify through the emailed link and sign in. Returns the signed-in client. */
export async function verifiedUser(
  stack: Stack,
  email: string,
  password: string,
  expect: Expect,
): Promise<TestClient> {
  const c = stack.client();
  expect(
    (await c.post(`${API}/sign-up/email`, { email, password, name: 'Conformance User' })).status,
  ).toBe(200);
  const verified = await c.get(await stack.link(email));
  expect(verified.status).toBe(302);
  const res = await c.post(`${API}/sign-in/email`, { email, password });
  expect(res.status, res.body).toBe(200);
  return c;
}

export const signIn = (c: TestClient, email: string, password: string) =>
  c.post(`${API}/sign-in/email`, { email, password });
