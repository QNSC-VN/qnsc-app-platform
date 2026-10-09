import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Logger, type INestApplication } from '@nestjs/common';
import { requestContextStorage, type RequestContext } from '@quynhonsemiconductor/observability';
import { readMode } from './cache-requirement';

/** Header read from the request and echoed on the response. Lower-case: Node lower-cases incoming names. */
export const CORRELATION_ID_HEADER = 'x-correlation-id';

/** Opt-out variable for {@link enableCorrelationId}: `disabled`. Unset means `enabled`. */
export const CORRELATION_ID_MODE_ENV = 'CORRELATION_ID_MODE';

export type CorrelationIdMode = 'enabled' | 'disabled';

/** Read {@link CORRELATION_ID_MODE_ENV}. Unset means `enabled`. Throws on an unknown value. */
export function readCorrelationIdMode(env: NodeJS.ProcessEnv = process.env): CorrelationIdMode {
  return readMode<CorrelationIdMode>(
    env,
    CORRELATION_ID_MODE_ENV,
    ['enabled', 'disabled'],
    'enabled',
  );
}

/**
 * What a caller-supplied id may look like: 1 to 128 of letters, digits and `. _ : -`.
 *
 * The id is echoed into every log line and back out in a response header, so it is untrusted input on
 * both paths. A UUID-only check would discard the ids upstream systems really send (ULIDs, hex trace
 * ids, `service:request` composites) and break correlation across a call chain, which is the point
 * of the header. What must be excluded is anything that can inject: CR, LF, other control
 * characters and whitespace (forge a log record, split a header), quotes and braces. This class
 * allows what callers send and nothing that can do that.
 *
 * JavaScript's `$` (without the `m` flag) matches only at the very end of the input, so a trailing
 * newline does not slip through.
 */
const SAFE_CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * W3C Trace Context is a fully specified wire format, so an exact match is right here: a malformed
 * value is not a differently-shaped id, it is not a `traceparent` at all.
 */
const W3C_TRACEPARENT = /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

/** Why a supplied value was not used. Never carries the value itself. */
export interface CorrelationIdReplacement {
  /** `multiple`: the header arrived more than once. `invalid`: empty, too long, or a character outside the class. */
  reason: 'invalid' | 'multiple';
  /** Length of the rejected value (the first one, for `multiple`). A number is safe to log; the value is not. */
  length: number;
}

export interface ResolvedCorrelationId {
  id: string;
  /** Set only when a header WAS supplied and was not used. Absent header: not a replacement. */
  replaced?: CorrelationIdReplacement;
}

/**
 * Decide the correlation id for a request: keep the caller's if it is valid, otherwise generate one.
 *
 * Pure apart from `generate`, so it is testable without a server. The raw input is never returned,
 * logged or reflected: only its length and a reason.
 */
export function resolveCorrelationId(
  supplied: string | string[] | undefined,
  generate: () => string = randomUUID,
): ResolvedCorrelationId {
  if (supplied === undefined) return { id: generate() };
  if (Array.isArray(supplied)) {
    return { id: generate(), replaced: { reason: 'multiple', length: (supplied[0] ?? '').length } };
  }
  if (SAFE_CORRELATION_ID.test(supplied)) return { id: supplied };
  return { id: generate(), replaced: { reason: 'invalid', length: supplied.length } };
}

function firstValid(value: string | string[] | undefined, pattern: RegExp): string | undefined {
  const single = Array.isArray(value) ? value[0] : value;
  return single !== undefined && pattern.test(single) ? single : undefined;
}

const enabledFor = new WeakSet<object>();
const logger = new Logger('CorrelationId');

/**
 * Give every request a correlation id, before anything else in the Nest pipeline runs.
 *
 * Registered with `app.use()`, which Nest runs ahead of every middleware a module configures (a
 * Fastify `onRequest` hook added after `NestFactory.create` runs AFTER them, which was measured, and
 * would leave an earlier middleware without a context). It therefore covers module middleware,
 * guards, pipes, filters, 404s and probe routes alike, and sits outside the global prefix.
 *
 * On each request it:
 *
 * 1. takes `X-Correlation-Id` if it is a single value of 1-128 characters from `[A-Za-z0-9._:-]`;
 *    otherwise generates a UUID (`crypto.randomUUID()`) and logs a DEBUG line saying why (never the
 *    rejected value);
 * 2. echoes the id on the response as `X-Correlation-Id`;
 * 3. enters `observability`'s request context with it, so `correlationId` is on every log line,
 *    error body and `RequestContextService.getCorrelationId()` for the rest of the request. The W3C
 *    `traceparent` is carried in the same context when it is well formed.
 *
 * Call it after creating the application and before `listen()` / `init()`, like `enableHealth`:
 *
 * ```ts
 * const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());
 * enableCorrelationId(app);
 * ```
 *
 * **A product that already seeds the context keeps working.** The id settled on here is also written
 * back to the request's `x-correlation-id` header, so a product middleware that reads that header
 * adopts it (and one that trusts the raw header no longer reflects bad input). If that middleware
 * then enters its own context, its id is the effective one: its `setHeader` wins over this one, and
 * its context is the innermost. One id, the product's, as before. A context that already exists when
 * this runs is reused, not replaced. Switch this off without a code change with
 * `CORRELATION_ID_MODE=disabled`, and remove the product's middleware at leisure.
 *
 * @throws if called twice for the same application, or on an unknown `CORRELATION_ID_MODE`.
 */
export function enableCorrelationId(
  app: INestApplication,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (enabledFor.has(app)) {
    throw new Error('enableCorrelationId() was already called for this application.');
  }
  enabledFor.add(app);

  if (readCorrelationIdMode(env) === 'disabled') {
    logger.log(`${CORRELATION_ID_MODE_ENV}=disabled: the product seeds the correlation id itself`);
    return;
  }

  app.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const existing = requestContextStorage.getStore();
    const { id, replaced } = existing
      ? { id: existing.correlationId, replaced: undefined }
      : resolveCorrelationId(req.headers[CORRELATION_ID_HEADER]);

    if (replaced) {
      // Reason and length only. The value is attacker-chosen and may hold CR/LF.
      logger.debug({
        msg: 'correlation id replaced',
        reason: replaced.reason,
        length: replaced.length,
        correlationId: id,
      });
    }

    // Plain `setHeader`: a product middleware that sets the header too (later, and so last) wins,
    // which keeps the response in step with the context that middleware enters.
    res.setHeader(CORRELATION_ID_HEADER, id);
    // Whatever reads the header later (a product middleware, HttpLoggingInterceptor) now sees the
    // validated id, never the raw input.
    // A literal key, not the constant: a computed key on an object that also holds caller-supplied
    // values is what static analysis flags as property injection. `CORRELATION_ID_HEADER` is
    // `'x-correlation-id'`, which the test for that constant pins.
    req.headers['x-correlation-id'] = id;

    if (existing) {
      next();
      return;
    }

    const context: RequestContext = {
      workspaceId: undefined,
      userId: undefined,
      sessionId: undefined,
      correlationId: id,
      traceparent: firstValid(req.headers['traceparent'], W3C_TRACEPARENT),
    };
    requestContextStorage.run(context, next);
  });
}
