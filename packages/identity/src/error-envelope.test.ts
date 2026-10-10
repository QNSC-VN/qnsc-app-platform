import { describe, expect, it } from 'vitest';
import { requestContextStorage } from '@quynhonsemiconductor/observability';
import { withErrorEnvelope } from './error-envelope';
import type { IdentityLogger } from './events';

type Logged = { message: string; fields?: Record<string, string | number | boolean> | undefined };
const spy = () => {
  const lines: Logged[] = [];
  const logger: IdentityLogger = {
    warn: () => undefined,
    error: (message, fields) => lines.push({ message, fields }),
  };
  return { lines, logger };
};
const call = (
  handler: () => Promise<Response>,
  options: { correlationId?: string; logger?: IdentityLogger } = {},
) => {
  const run = () =>
    withErrorEnvelope(handler, options.logger)(new Request('https://auth.example.test/api/auth/x'));
  return options.correlationId === undefined
    ? run()
    : requestContextStorage.run(
        {
          workspaceId: undefined,
          userId: undefined,
          sessionId: undefined,
          correlationId: options.correlationId,
          traceparent: undefined,
        },
        run,
      );
};
const bodyOf = async (res: Response) => (await res.json()) as Record<string, unknown>;

describe('withErrorEnvelope (5xx: additive hybrid)', () => {
  it('a body-less 500 gets Better Auth’s top-level code and message AND the envelope, with the request id', async () => {
    const res = await call(async () => new Response(null, { status: 500 }), {
      correlationId: 'req-9',
    });
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await bodyOf(res)).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
        details: [],
        correlationId: 'req-9',
      },
    });
  });

  it('whatever Better Auth put in a 5xx body is not echoed; headers survive; 503 is SERVICE_UNAVAILABLE; no id says unknown', async () => {
    const leaky = new Response(
      JSON.stringify({ code: 'X', message: 'insert into "user" failed' }),
      {
        status: 500,
        headers: { 'x-correlation-id': 'req-1', 'content-type': 'application/json' },
      },
    );
    const res = await call(async () => leaky);
    expect(res.headers.get('x-correlation-id')).toBe('req-1');
    const body = await bodyOf(res);
    expect(JSON.stringify(body)).not.toContain('insert');
    expect((body['error'] as Record<string, unknown>)['correlationId']).toBe('unknown');
    const unavailable = await bodyOf(await call(async () => new Response(null, { status: 503 })));
    expect(unavailable['code']).toBe('SERVICE_UNAVAILABLE');
    expect((unavailable['error'] as Record<string, unknown>)['code']).toBe('SERVICE_UNAVAILABLE');
  });

  it('an invalid correlation id is never echoed', async () => {
    const res = await call(async () => new Response(null, { status: 500 }), {
      correlationId: 'a b\r\nc',
    });
    expect(((await bodyOf(res))['error'] as Record<string, unknown>)['correlationId']).toBe(
      'unknown',
    );
  });

  it('below 500 nothing is touched', async () => {
    const unauthorized = new Response(JSON.stringify({ code: 'A', message: 'b' }), { status: 401 });
    expect(await call(async () => unauthorized)).toBe(unauthorized);
    const redirect = new Response(null, { status: 302, headers: { location: '/' } });
    expect(await call(async () => redirect)).toBe(redirect);
  });

  it('a handler that throws is LOGGED (class and code, the request id, never the message) and answers a 500 with a body', async () => {
    const { lines, logger } = spy();
    const cause = Object.assign(new Error('relation "secret_table" does not exist'), {
      code: '42P01',
    });
    const res = await call(
      async () => {
        throw new Error('select * from users where email = a@b.test', { cause });
      },
      { correlationId: 'req-7', logger },
    );
    expect(res.status).toBe(500);
    expect((await bodyOf(res))['code']).toBe('INTERNAL_ERROR');
    expect(lines).toHaveLength(1);
    expect(lines[0]!.message).toContain('identity.auth_handler_threw');
    expect(lines[0]!.fields).toEqual({
      code: 'identity.auth_handler_threw',
      error: 'Error',
      cause: 'Error',
      errorCode: '42P01',
      correlationId: 'req-7',
    });
    expect(JSON.stringify(lines)).not.toMatch(/secret_table|select \*|a@b\.test/);
  });
});
