import 'reflect-metadata';
import {
  Body,
  Controller,
  Get,
  Injectable,
  Logger,
  Module,
  Post,
  type CanActivate,
  type MiddlewareConsumer,
  type NestMiddleware,
  type NestModule,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD, NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  RequestContextService,
  createLoggerOptions,
  requestContextStorage,
} from '@quynhonsemiconductor/observability';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '../errors';
import {
  CORRELATION_ID_HEADER,
  CORRELATION_ID_MODE_ENV,
  enableCorrelationId,
  readCorrelationIdMode,
  resolveCorrelationId,
} from './correlation-id';
import { GlobalExceptionFilter } from './global-exception.filter';
import { REQUEST_CONTEXT } from './request-context';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('resolveCorrelationId', () => {
  it.each([
    ['a UUID', randomUUID()],
    ['a ULID', '01ARZ3NDEKTSV4RRFFQ69G5FAV'],
    ['a composite with every allowed punctuation', 'svc:req.42_a-b'],
    ['a single character', 'x'],
    ['exactly 128 characters', 'a'.repeat(128)],
  ])('keeps %s', (_name, value) => {
    expect(resolveCorrelationId(value)).toEqual({ id: value });
  });

  it.each([
    ['129 characters', 'a'.repeat(129), 129],
    ['an empty header', '', 0],
    ['a space', 'abc def', 7],
    ['a comma-joined duplicate header', 'abc, def', 8],
    ['a quote', 'abc"def', 7],
    ['an angle bracket', '<script>', 8],
    ['a non-ASCII letter', 'abcé', 4],
    ['a NUL', 'abc\0def', 7],
    ['an LF in the middle', 'abc\ndef', 7],
    ['a CRLF header-splitting attempt', 'abc\r\nSet-Cookie: x=1', 20],
    ['a trailing LF (JavaScript `$` must not let it through)', 'abc\n', 4],
    ['a trailing CRLF', 'abc\r\n', 5],
    ['a log-forging payload', 'abc","level":60,"msg":"forged', 29],
  ])('replaces %s', (_name, value, length) => {
    const resolved = resolveCorrelationId(value, () => 'generated-id');
    expect(resolved.id).toBe('generated-id');
    expect(resolved.replaced).toEqual({ reason: 'invalid', length });
    // The rejected value appears nowhere in what the caller gets back to log.
    expect(JSON.stringify(resolved)).not.toContain(value === '' ? '\u0000never' : value);
  });

  it('replaces a header that arrived more than once, naming the reason', () => {
    expect(resolveCorrelationId(['abc', 'def'], () => 'g')).toEqual({
      id: 'g',
      replaced: { reason: 'multiple', length: 3 },
    });
  });

  it('generates a UUID v4 with crypto.randomUUID when the header is absent, and does not call that a replacement', () => {
    const resolved = resolveCorrelationId(undefined);
    expect(resolved.id).toMatch(UUID_V4);
    expect(resolved.replaced).toBeUndefined();
    expect(resolveCorrelationId(undefined).id).not.toBe(resolved.id);
  });
});

describe('readCorrelationIdMode', () => {
  it('is enabled when unset or blank', () => {
    expect(readCorrelationIdMode({})).toBe('enabled');
    expect(readCorrelationIdMode({ [CORRELATION_ID_MODE_ENV]: '  ' })).toBe('enabled');
  });
  it('accepts enabled and disabled', () => {
    expect(readCorrelationIdMode({ [CORRELATION_ID_MODE_ENV]: 'enabled' })).toBe('enabled');
    expect(readCorrelationIdMode({ [CORRELATION_ID_MODE_ENV]: 'disabled' })).toBe('disabled');
  });
  it('refuses a typo instead of quietly meaning the default', () => {
    expect(() => readCorrelationIdMode({ [CORRELATION_ID_MODE_ENV]: 'disable' })).toThrow(
      /CORRELATION_ID_MODE.*enabled, disabled/,
    );
  });
});

// ── Against a real Nest + Fastify server on a real socket ──────────────────────────────────────

/** What a handler, a guard and the logger mixin each see, so the tests can compare them. */
function snapshot() {
  const mixin = (
    createLoggerOptions({
      serviceName: 'test',
      nodeEnv: 'test',
      serviceVersion: 'dev',
      level: 'info',
      pretty: false,
    }).pinoHttp as { mixin: () => Record<string, unknown> }
  ).mixin();
  return {
    store: requestContextStorage.getStore()?.correlationId ?? null,
    traceparent: requestContextStorage.getStore()?.traceparent ?? null,
    service: new RequestContextService().getCorrelationId() ?? null,
    // The exact function pino calls to add fields to every log line.
    logLine: (mixin['correlationId'] as string | undefined) ?? null,
  };
}

@Controller()
class ProbeController {
  @Get('ctx')
  get() {
    return snapshot();
  }

  @Post('ctx')
  post(@Body() body: unknown) {
    return { ...snapshot(), body };
  }

  @Get('missing')
  missing(): never {
    throw new NotFoundException('THING_NOT_FOUND', 'no such thing');
  }
}

const seenByGuard: (string | null)[] = [];
@Injectable()
class RecordingGuard implements CanActivate {
  canActivate(): boolean {
    seenByGuard.push(requestContextStorage.getStore()?.correlationId ?? null);
    return true;
  }
}

/** A faithful copy of rova's / opshub's middleware: its own pattern, header echo and context. */
@Injectable()
class ProductStyleMiddleware implements NestMiddleware {
  use(
    req: { headers: Record<string, string | string[] | undefined> },
    res: { setHeader(name: string, value: string): void },
    next: () => void,
  ): void {
    const supplied = Array.isArray(req.headers['x-correlation-id'])
      ? req.headers['x-correlation-id'][0]
      : req.headers['x-correlation-id'];
    const correlationId =
      supplied !== undefined && /^[A-Za-z0-9_-]{8,64}$/.test(supplied) ? supplied : randomUUID();
    res.setHeader('x-correlation-id', correlationId);
    requestContextStorage.run(
      {
        workspaceId: undefined,
        userId: undefined,
        sessionId: undefined,
        correlationId,
        traceparent: undefined,
      },
      next,
    );
  }
}

const seenByMiddleware: (string | null)[] = [];
/** A product middleware that only LOOKS at the context (a request logger, say). */
@Injectable()
class ObservingMiddleware implements NestMiddleware {
  use(_req: unknown, _res: unknown, next: () => void): void {
    seenByMiddleware.push(requestContextStorage.getStore()?.correlationId ?? null);
    next();
  }
}

/** solodesk's middleware: trusts the raw header as it arrives, validates nothing, echoes nothing. */
@Injectable()
class TrustingMiddleware implements NestMiddleware {
  use(
    req: { headers: Record<string, string | string[] | undefined> },
    _res: unknown,
    next: () => void,
  ): void {
    const correlationId = (req.headers['x-correlation-id'] as string | undefined) ?? randomUUID();
    requestContextStorage.run(
      {
        workspaceId: undefined,
        userId: undefined,
        sessionId: undefined,
        correlationId,
        traceparent: undefined,
      },
      next,
    );
  }
}

const apps: NestFastifyApplication[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  seenByGuard.length = 0;
  seenByMiddleware.length = 0;
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

interface BootOptions {
  /** Keep the product's own middleware, as a product mid-rollout would. */
  productMiddleware?: boolean;
  /** A middleware that trusts the raw header, as solodesk's does. */
  trustingMiddleware?: boolean;
  /** A module middleware that only observes the context. */
  observingMiddleware?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Run before `enableCorrelationId`, as a product's own earlier hook would. */
  beforeEnable?: (app: NestFastifyApplication) => void;
  skipEnable?: boolean;
}

async function boot(
  options: BootOptions = {},
): Promise<{ app: NestFastifyApplication; url: string }> {
  @Module({
    controllers: [ProbeController],
    providers: [
      RequestContextService,
      { provide: REQUEST_CONTEXT, useExisting: RequestContextService },
      { provide: APP_GUARD, useClass: RecordingGuard },
      { provide: APP_FILTER, useClass: GlobalExceptionFilter },
    ],
  })
  class AppModule implements NestModule {
    configure(consumer: MiddlewareConsumer): void {
      if (options.productMiddleware) consumer.apply(ProductStyleMiddleware).forRoutes('*');
      if (options.trustingMiddleware) consumer.apply(TrustingMiddleware).forRoutes('*');
      if (options.observingMiddleware) consumer.apply(ObservingMiddleware).forRoutes('*');
    }
  }

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    logger: false,
  });
  apps.push(app);
  options.beforeEnable?.(app);
  if (!options.skipEnable) enableCorrelationId(app, options.env ?? {});
  await app.listen(0, '127.0.0.1');
  return { app, url: await app.getUrl() };
}

async function getCtx(url: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${url}/ctx`, { headers });
  return { res, body: (await res.json()) as ReturnType<typeof snapshot> };
}

describe('enableCorrelationId (real server)', () => {
  it('keeps a valid X-Correlation-Id, and the response, the context, the service and the log line all carry it', async () => {
    const { url } = await boot();
    const { res, body } = await getCtx(url, { 'x-correlation-id': 'upstream:req.7_a-b' });
    expect(res.headers.get('x-correlation-id')).toBe('upstream:req.7_a-b');
    expect(body).toMatchObject({
      store: 'upstream:req.7_a-b',
      service: 'upstream:req.7_a-b',
      logLine: 'upstream:req.7_a-b',
    });
  });

  it('generates a UUID when the header is absent, and echoes the same one', async () => {
    const { url } = await boot();
    const { res, body } = await getCtx(url);
    const echoed = res.headers.get('x-correlation-id');
    expect(echoed).toMatch(UUID_V4);
    expect(body.store).toBe(echoed);
    expect(body.logLine).toBe(echoed);
  });

  it('gives two requests two different ids', async () => {
    const { url } = await boot();
    const [a, b] = await Promise.all([getCtx(url), getCtx(url)]);
    expect(a.body.store).not.toBe(b.body.store);
  });

  it('replaces an oversized id, never reflecting it, and logs a DEBUG line without the value', async () => {
    const debug = vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    const { url } = await boot();
    const oversized = 'z'.repeat(129);
    const { res, body } = await getCtx(url, { 'x-correlation-id': oversized });
    const echoed = res.headers.get('x-correlation-id');
    expect(echoed).toMatch(UUID_V4);
    expect(body.store).toBe(echoed);

    expect(debug).toHaveBeenCalledTimes(1);
    const line = debug.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(line).toMatchObject({
      msg: 'correlation id replaced',
      reason: 'invalid',
      length: 129,
      correlationId: echoed,
    });
    expect(JSON.stringify(debug.mock.calls)).not.toContain(oversized);
  });

  it('does not log a replacement when the header is simply absent or valid', async () => {
    const debug = vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    const { url } = await boot();
    await getCtx(url);
    await getCtx(url, { 'x-correlation-id': 'fine-id-1' });
    expect(debug).not.toHaveBeenCalled();
  });

  it('replaces a header with CR/LF in it and never lets it reach a response header', async () => {
    const debug = vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    const { app } = await boot();
    // light-my-request hands the value over untouched. Node's HTTP parser would refuse CR/LF on a
    // real socket, so this is the only way to put one in front of the hook.
    const injected = 'abc\r\nSet-Cookie: pwned=1';
    const res = await app.inject({
      method: 'GET',
      url: '/ctx',
      headers: { 'x-correlation-id': injected },
    });
    expect(res.headers['x-correlation-id']).toMatch(UUID_V4);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.json().store).toBe(res.headers['x-correlation-id']);
    expect(JSON.stringify(debug.mock.calls)).not.toContain('pwned');
    expect(debug.mock.calls[0]?.[0]).toMatchObject({ reason: 'invalid', length: injected.length });
  });

  it('replaces an id of the wrong shape sent over the wire (a space, quotes)', async () => {
    const { url } = await boot();
    for (const bad of ['has space', 'quo"te', 'semi;colon', 'a,b']) {
      const { res } = await getCtx(url, { 'x-correlation-id': bad });
      expect(res.headers.get('x-correlation-id'), bad).toMatch(UUID_V4);
    }
  });

  it('carries the context into a guard, through a JSON body, and into the exception filter', async () => {
    const { url } = await boot();
    const post = await fetch(`${url}/ctx`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-correlation-id': 'post-id-1' },
      body: JSON.stringify({ n: 1 }),
    });
    const body = (await post.json()) as ReturnType<typeof snapshot> & { body: unknown };
    // AsyncLocalStorage must survive body parsing, which happens on stream events.
    expect(body).toMatchObject({ store: 'post-id-1', logLine: 'post-id-1', body: { n: 1 } });
    expect(seenByGuard).toContain('post-id-1');

    const missing = await fetch(`${url}/missing`, { headers: { 'x-correlation-id': 'err-id-1' } });
    expect(missing.status).toBe(404);
    expect(missing.headers.get('x-correlation-id')).toBe('err-id-1');
    expect(
      ((await missing.json()) as { error: { correlationId: string } }).error.correlationId,
    ).toBe('err-id-1');
  });

  it('runs before module middleware, so a middleware a product configures already sees the context', async () => {
    const { url } = await boot({ observingMiddleware: true });
    await getCtx(url, { 'x-correlation-id': 'mw-sees-me-1' });
    await fetch(`${url}/no-such-route`, { headers: { 'x-correlation-id': 'mw-sees-me-2' } });
    expect(seenByMiddleware).toEqual(['mw-sees-me-1', 'mw-sees-me-2']);
  });

  it('echoes on a route that does not exist, too', async () => {
    const { url } = await boot();
    const res = await fetch(`${url}/no-such-route`);
    expect(res.status).toBe(404);
    expect(res.headers.get('x-correlation-id')).toMatch(UUID_V4);
  });

  it('seeds a well-formed traceparent and drops a malformed one', async () => {
    const { url } = await boot();
    const good = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    expect((await getCtx(url, { traceparent: good })).body.traceparent).toBe(good);
    expect((await getCtx(url, { traceparent: 'not-a-traceparent' })).body.traceparent).toBeNull();
  });

  it('refuses a second enableCorrelationId for the same application', async () => {
    const { app } = await boot();
    expect(() => enableCorrelationId(app, {})).toThrow(/already called/);
  });
});

describe('CORRELATION_ID_MODE=disabled (opt-out)', () => {
  it('registers nothing: no context, no response header', async () => {
    const { url } = await boot({ env: { [CORRELATION_ID_MODE_ENV]: 'disabled' } });
    const { res, body } = await getCtx(url, { 'x-correlation-id': 'ignored-1' });
    expect(res.headers.get('x-correlation-id')).toBeNull();
    expect(body).toMatchObject({ store: null, service: null, logLine: null });
  });

  it('leaves a product that seeds the context itself exactly as it was', async () => {
    const { url } = await boot({
      env: { [CORRELATION_ID_MODE_ENV]: 'disabled' },
      productMiddleware: true,
    });
    const { res, body } = await getCtx(url, { 'x-correlation-id': 'product-id-1234' });
    expect(res.headers.get('x-correlation-id')).toBe('product-id-1234');
    expect(body.store).toBe('product-id-1234');
  });

  it('fails the boot on a typo rather than meaning the default', async () => {
    await expect(boot({ env: { [CORRELATION_ID_MODE_ENV]: 'off' } })).rejects.toThrow(
      /CORRELATION_ID_MODE/,
    );
  });
});

describe('a product whose own middleware still sets the header (rollout in progress)', () => {
  it('ends up with ONE id when the caller sent a valid one', async () => {
    const { url } = await boot({ productMiddleware: true });
    const { res, body } = await getCtx(url, { 'x-correlation-id': 'caller-id-12345' });
    expect(res.headers.get('x-correlation-id')).toBe('caller-id-12345');
    expect(body).toMatchObject({ store: 'caller-id-12345', logLine: 'caller-id-12345' });
  });

  it('ends up with ONE id when there was no header', async () => {
    const { url } = await boot({ productMiddleware: true });
    const { res, body } = await getCtx(url);
    const echoed = res.headers.get('x-correlation-id');
    expect(echoed).toMatch(UUID_V4);
    expect(body.store).toBe(echoed);
    expect(body.logLine).toBe(echoed);
  });

  it('stops a middleware that trusts the raw header from reflecting a bad one: it now reads the validated id', async () => {
    // solodesk today reads the header with no validation. This hook writes the id it settled on back
    // to the header, so that middleware never sees the raw input.
    const { url } = await boot({ trustingMiddleware: true });
    const bad = await getCtx(url, { 'x-correlation-id': 'has space' });
    expect(bad.res.headers.get('x-correlation-id')).toMatch(UUID_V4);
    expect(bad.body.store).toBe(bad.res.headers.get('x-correlation-id'));
    expect(bad.body.store).not.toBe('has space');

    const good = await getCtx(url, { 'x-correlation-id': 'caller-id-77' });
    expect(good.body.store).toBe('caller-id-77');
    expect(good.res.headers.get('x-correlation-id')).toBe('caller-id-77');
  });

  it("ends up with ONE id (the product's) when this package accepts an id the product would not", async () => {
    // "a.b:c" is valid here (. and : are allowed, no minimum length) but not for the product's
    // stricter pattern, so the product generates its own. The header and the context must still agree.
    const { url } = await boot({ productMiddleware: true });
    const { res, body } = await getCtx(url, { 'x-correlation-id': 'a.b:c' });
    const echoed = res.headers.get('x-correlation-id');
    expect(echoed).toMatch(UUID_V4);
    expect(body.store).toBe(echoed);
    expect(body.logLine).toBe(echoed);
  });

  it('reuses a context that already exists when it runs, instead of replacing it', async () => {
    const { url } = await boot({
      beforeEnable: (app) => {
        // An earlier app.use(), as a product's own bootstrap might have registered.
        app.use((_req: unknown, _res: unknown, next: () => void) =>
          requestContextStorage.run(
            {
              workspaceId: 'w1',
              userId: undefined,
              sessionId: undefined,
              correlationId: 'pre-existing-1',
              traceparent: undefined,
            },
            next,
          ),
        );
      },
    });
    const { res, body } = await getCtx(url, { 'x-correlation-id': 'caller-sent-id' });
    expect(res.headers.get('x-correlation-id')).toBe('pre-existing-1');
    expect(body.store).toBe('pre-existing-1');
  });
});

describe('the header name', () => {
  it('is x-correlation-id', () => {
    expect(CORRELATION_ID_HEADER).toBe('x-correlation-id');
  });
});
