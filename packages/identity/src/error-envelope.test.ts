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
const wrap = (response: Response | (() => never), logger?: IdentityLogger) =>
  withErrorEnvelope(async () => {
    if (typeof response === 'function') response();
    return response as Response;
  }, logger);
const call = (
  response: Response | (() => never),
  correlationId?: string,
  logger?: IdentityLogger,
) => {
  const run = () => wrap(response, logger)(new Request('https://auth.example.test/api/auth/x'));
  return correlationId === undefined
    ? run()
    : requestContextStorage.run(
        {
          workspaceId: undefined,
          userId: undefined,
          sessionId: undefined,
          correlationId,
          traceparent: undefined,
        },
        run,
      );
};
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
const bodyOf = async (res: Response) => (await res.json()) as Record<string, unknown>;
const errorOf = async (res: Response) => (await bodyOf(res))['error'] as Record<string, unknown>;

describe('withErrorEnvelope (additive: Better Auth’s body stays, `error` is added)', () => {
  it('keeps status, headers and every Better Auth field; adds error with the same code and message', async () => {
    const res = await call(
      json(
        429,
        {
          message: 'Too many requests',
          code: 'RATE_LIMITED_BY_AUTH',
          retryAfter: 7,
          extra: { a: 1 },
        },
        { 'retry-after': '7', 'x-correlation-id': 'req-1' },
      ),
      'req-1',
    );
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('7');
    expect(res.headers.get('x-correlation-id')).toBe('req-1');
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await bodyOf(res)).toEqual({
      code: 'RATE_LIMITED_BY_AUTH',
      message: 'Too many requests',
      retryAfter: 7,
      extra: { a: 1 },
      error: {
        code: 'RATE_LIMITED_BY_AUTH',
        message: 'Too many requests',
        details: [],
        correlationId: 'req-1',
      },
    });
  });

  it('a 4xx without a usable code gets the platform code of its status at BOTH levels; a body that is not JSON is no reason to fail', async () => {
    for (const [status, code] of [
      [400, 'BAD_REQUEST'],
      [401, 'UNAUTHORIZED'],
      [403, 'FORBIDDEN'],
      [404, 'NOT_FOUND'],
      [405, 'METHOD_NOT_ALLOWED'],
      [409, 'CONFLICT'],
      [429, 'RATE_LIMITED'],
      [418, 'BAD_REQUEST'],
    ] as const) {
      for (const body of [null, '<html>nope</html>']) {
        const res = await call(new Response(body, { status }));
        expect(res.status).toBe(status);
        const parsed = await bodyOf(res);
        expect(parsed['code']).toBe(code);
        expect((parsed['error'] as Record<string, unknown>)['code']).toBe(code);
        expect(JSON.stringify(parsed)).not.toContain('html');
      }
    }
  });

  it('a code that is not a plain machine code is not echoed in the envelope (the top level is Better Auth’s, as sent)', async () => {
    const parsed = await bodyOf(await call(json(400, { code: 'bad code\r\nX: y', message: 'm' })));
    expect(parsed['code']).toBe('bad code\r\nX: y');
    expect((parsed['error'] as Record<string, unknown>)['code']).toBe('BAD_REQUEST');
  });

  it('validation stays 400 VALIDATION_ERROR at the top level; the envelope is VALIDATION_FAILED with one issue per field', async () => {
    const message = '[body.email] Invalid email address; [body.password] Too short';
    const res = await call(json(400, { code: 'VALIDATION_ERROR', message }));
    expect(res.status).toBe(400);
    const parsed = await bodyOf(res);
    expect(parsed['code']).toBe('VALIDATION_ERROR');
    expect(parsed['message']).toBe(message);
    expect(parsed['error']).toEqual({
      code: 'VALIDATION_FAILED',
      message: 'Validation failed',
      details: [
        { path: 'body.email', message: 'Invalid email address' },
        { path: 'body.password', message: 'Too short' },
      ],
      correlationId: 'unknown',
    });
  });

  it('a body that already has an `error` key (an OAuth-style answer) is left exactly as it is', async () => {
    const original = json(400, { error: 'invalid_request', error_description: 'nope' });
    expect(await call(original)).toBe(original);
  });

  it('every 5xx is INTERNAL_ERROR with the fixed message at BOTH levels, whatever Better Auth said; 503 is SERVICE_UNAVAILABLE', async () => {
    const res = await call(
      json(500, { code: 'FAILED_TO_CREATE_USER', message: 'insert into "user" failed', secret: 1 }),
      'req-9',
    );
    expect(res.status).toBe(500);
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
    const empty = await bodyOf(await call(new Response(null, { status: 502 })));
    expect(empty['code']).toBe('INTERNAL_ERROR'); // never a null body
    expect((await errorOf(await call(new Response(null, { status: 503 }))))['code']).toBe(
      'SERVICE_UNAVAILABLE',
    );
  });

  it('a handler that throws is LOGGED (class and code, the request id, never the message) and answers a 500 with a body', async () => {
    const { lines, logger } = spy();
    const cause = Object.assign(new Error('relation "secret_table" does not exist'), {
      code: '42P01',
    });
    const res = await call(
      () => {
        throw new Error('select * from users where email = a@b.test', { cause });
      },
      'req-7',
      logger,
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

  it('successes and redirects are untouched, and an invalid correlation id is never echoed', async () => {
    const ok = json(200, { user: { id: 'u' } });
    expect(await call(ok)).toBe(ok);
    const redirect = new Response(null, { status: 302, headers: { location: '/?error=x' } });
    expect(await call(redirect)).toBe(redirect);
    const bad = await errorOf(await call(new Response(null, { status: 401 }), 'a b\r\nc'));
    expect(bad['correlationId']).toBe('unknown');
  });
});
