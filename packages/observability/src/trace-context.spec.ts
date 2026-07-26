import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { currentTraceparent, withRestoredTrace } from './trace-context';

/**
 * Exercises real propagation rather than mocks: the point of this module is that a
 * trace survives a database round-trip, and only the real propagator + tracer can
 * demonstrate that the ids actually match.
 */
describe('outbox trace propagation', () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });

  const contextManager = new AsyncLocalStorageContextManager();

  beforeAll(() => {
    trace.setGlobalTracerProvider(provider);
    // A ContextManager is what makes `context.with()` actually propagate — without
    // one the API silently falls back to a no-op and `getActiveSpan()` is always
    // undefined. NodeSDK registers one in production; BasicTracerProvider does not,
    // so the spec must. Deliberately NO global propagator: this module parses the
    // header itself, and omitting one proves that.
    context.setGlobalContextManager(contextManager.enable());
  });

  afterAll(async () => {
    contextManager.disable();
    context.disable();
    await provider.shutdown();
  });

  const tracer = () => trace.getTracer('spec');

  describe('currentTraceparent', () => {
    it('is null when nothing is tracing', () => {
      // OTel disabled, or a writer outside any span — the row simply has no parent.
      expect(currentTraceparent()).toBeNull();
    });

    it('serialises the active span in W3C form', () => {
      const span = tracer().startSpan('producer');
      const captured = context.with(trace.setSpan(context.active(), span), () =>
        currentTraceparent(),
      );
      span.end();

      expect(captured).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
      expect(captured).toContain(span.spanContext().traceId);
    });
  });

  describe('withRestoredTrace', () => {
    it('joins the consumer span to the producer trace', () => {
      // The whole point: one trace across the queue boundary, so "why did this take
      // four minutes" is answerable from a single trace.
      const producer = tracer().startSpan('api-request');
      const traceparent = context.with(trace.setSpan(context.active(), producer), () =>
        currentTraceparent(),
      );
      producer.end();

      const consumerTraceId = withRestoredTrace(traceparent, () => {
        const consumer = tracer().startSpan('relay-row');
        const traceId = consumer.spanContext().traceId;
        consumer.end();
        return traceId;
      });

      expect(consumerTraceId).toBe(producer.spanContext().traceId);
    });

    it('starts an unrelated trace when there is no traceparent', () => {
      // Pre-column rows and cron-enqueued events must still be relayed.
      const traceId = withRestoredTrace(null, () => {
        const span = tracer().startSpan('relay-row');
        const id = span.spanContext().traceId;
        span.end();
        return id;
      });

      expect(traceId).toMatch(/^[0-9a-f]{32}$/);
    });

    it('tolerates a malformed traceparent rather than dropping the work', () => {
      // A corrupt header loses the link; it must never stop the row being processed.
      expect(withRestoredTrace('not-a-traceparent', () => 'processed')).toBe('processed');
      expect(withRestoredTrace('', () => 'processed')).toBe('processed');
      expect(withRestoredTrace(undefined, () => 'processed')).toBe('processed');
    });

    it('returns the callback result', () => {
      expect(withRestoredTrace(null, () => 42)).toBe(42);
    });
  });
});
