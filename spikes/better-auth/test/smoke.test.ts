import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStack, type Stack } from './support/stack';

describe('smoke: Better Auth inside NestJS 11 + Fastify 5', () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack();
  });
  afterAll(async () => {
    await stack?.stop();
  });

  it('boots, serves a public route, protects the rest', async () => {
    const c = stack.client();
    expect((await c.get('/v1/public')).status).toBe(200);
    const denied = await c.get('/v1/me');
    expect(denied.status).toBe(401);
    expect(denied.json()).toMatchObject({ error: { code: 'AUTH_UNAUTHENTICATED' } });
  });
});
