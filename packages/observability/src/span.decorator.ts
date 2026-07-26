import { SpanStatusCode, trace } from '@opentelemetry/api';

export interface SpanOptions {
  /** Custom span name. Defaults to the decorated method name. */
  name?: string;
  /** Static semantic attributes stamped on the span at creation. */
  attributes?: Record<string, string | number | boolean>;
}

/**
 * Tracer identity. Taken from the environment so every product reports under its own
 * name — the previous hard-coded 'rally-api' would have mislabelled every other
 * product's spans, and mislabelled rally's own worker.
 */
const TRACER_NAME = process.env['OTEL_SERVICE_NAME'] ?? 'qnsc';
const TRACER_VERSION = process.env['SERVICE_VERSION'] ?? 'dev';

/**
 * Method decorator that wraps the decorated async method in an OpenTelemetry span.
 * When OTel is disabled or unconfigured, `trace.getTracer()` returns a no-op
 * tracer — so there is zero overhead.
 *
 * @example
 * ```ts
 * @Span('work-items.create')
 * async create(dto: CreateWorkItemDto) { ... }
 *
 * @Span({ name: 'db.query', attributes: { 'db.system': 'postgresql' } })
 * async runQuery(sql: string) { ... }
 * ```
 */
export function Span(optionsOrName: SpanOptions | string = {}): MethodDecorator {
  const options: SpanOptions =
    typeof optionsOrName === 'string' ? { name: optionsOrName } : optionsOrName;

  return function (
    _target: object,
    propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ) {
    const originalMethod = descriptor.value as (...args: unknown[]) => Promise<unknown>;
    const spanName = options.name ?? String(propertyKey);

    descriptor.value = async function (...args: unknown[]) {
      const tracer = trace.getTracer(TRACER_NAME, TRACER_VERSION);

      return tracer.startActiveSpan(spanName, async (span) => {
        if (options.attributes) {
          for (const [key, value] of Object.entries(options.attributes)) {
            span.setAttribute(key, value);
          }
        }

        try {
          const result = await originalMethod.apply(this, args);
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (error: unknown) {
          const err = error as Error;
          span.recordException(err);
          span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
          throw error;
        } finally {
          span.end();
        }
      });
    };

    return descriptor;
  };
}
