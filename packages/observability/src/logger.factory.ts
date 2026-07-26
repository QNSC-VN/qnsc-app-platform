import { trace, isSpanContextValid } from '@opentelemetry/api';
import type { Params as PinoParams } from 'nestjs-pino';
import { requestContextStorage } from './request-context';

/**
 * The one pino configuration, shared by every app.
 *
 * Each process used to carry its own copy of this block, and the copies drifted:
 * in one product the worker's copy was missing the `redact` list entirely, so any
 * logged object carrying an `authorization` or `cookie` header — an AWS or GitHub
 * SDK error, for instance — would have written credentials to the log sink. A
 * shared factory makes that impossible to forget, which is the whole point of
 * putting it here rather than documenting it.
 */

/** Credential-bearing paths. Never log these, in any environment. */
const REDACTED_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'req.headers["x-api-key"]',
  'req.headers["x-csrf-token"]',
  // SDK errors nest the original request, which is the realistic leak path in
  // background workers that never see an inbound HTTP header.
  'err.config.headers.authorization',
  'err.request.headers.authorization',
];

export interface LoggerFactoryOptions {
  /** Value of the `service` field on every line — `rally-api`, `rally-worker`. */
  serviceName: string;
  /** `NODE_ENV`, used for the `env` field and the pretty-print default. */
  nodeEnv: string;
  /** `SERVICE_VERSION`, so a log line can be traced to a release. */
  serviceVersion: string;
  /** Pino level from config. */
  level: string;
  /** Explicit override for human-readable output; defaults to "not production". */
  pretty?: boolean;
}

/**
 * Build the `nestjs-pino` options.
 *
 * Two things make these logs queryable rather than merely present, and both are
 * why this must stay shared:
 *
 *  - **trace correlation** — `trace.id` / `span.id` from the active span, so a log
 *    line links to its trace in the backend;
 *  - **business context** — `workspaceId` / `userId` / `correlationId` pulled from
 *    AsyncLocalStorage on every write, so no call site has to remember to pass them.
 */
export function createLoggerOptions(options: LoggerFactoryOptions): PinoParams {
  const pretty = options.pretty ?? options.nodeEnv !== 'production';

  return {
    pinoHttp: {
      level: options.level,
      // pino-pretty for humans in dev; raw JSON in deployed environments, where a
      // log aggregator parses it.
      transport: pretty
        ? { target: 'pino-pretty', options: { colorize: true, singleLine: false } }
        : undefined,
      redact: { paths: [...REDACTED_PATHS], censor: '[REDACTED]' },
      // HttpLoggingInterceptor emits the per-request summary line instead, so the
      // default req/res pair would duplicate it.
      autoLogging: false,
      customProps: () => ({
        service: options.serviceName,
        env: options.nodeEnv,
        version: options.serviceVersion,
      }),
      mixin: () => {
        const fields: Record<string, unknown> = {};

        const span = trace.getActiveSpan();
        if (span) {
          const spanContext = span.spanContext();
          if (isSpanContextValid(spanContext)) {
            fields['trace.id'] = spanContext.traceId;
            fields['span.id'] = spanContext.spanId;
          }
        }

        const requestContext = requestContextStorage.getStore();
        if (requestContext) {
          if (requestContext.workspaceId) fields['workspaceId'] = requestContext.workspaceId;
          if (requestContext.userId) fields['userId'] = requestContext.userId;
          if (requestContext.correlationId) fields['correlationId'] = requestContext.correlationId;
        }

        return fields;
      },
    },
  };
}

/** Exported for the spec that pins the redaction list. */
export const __redactedPaths = REDACTED_PATHS;
