import { context, trace, TraceFlags, type SpanContext } from '@opentelemetry/api';

/**
 * W3C trace-context propagation across the outbox boundary.
 *
 * A trace normally ends when the request that enqueued work commits, and a fresh,
 * unrelated trace starts when the worker relays it. That makes "why did this
 * notification take four minutes" unanswerable from one trace, because the halves
 * are not linked. Persisting the `traceparent` on the row and restoring it in the
 * relay joins them.
 *
 * The header is serialised and parsed here rather than through
 * `propagation.inject/extract`, for two reasons: those depend on a propagator having
 * been registered globally — it is when the SDK starts, but silently is not when the
 * SDK is disabled — and the format is a fixed, trivially-parsed spec. Doing it
 * explicitly means this module behaves identically regardless of global state, which
 * is what makes it testable without booting an SDK.
 *
 * Format: `00-<32 hex trace id>-<16 hex span id>-<2 hex flags>`
 */

const VERSION = '00';
const TRACEPARENT_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
/** All-zero ids are explicitly invalid per the spec. */
const INVALID_TRACE_ID = '0'.repeat(32);
const INVALID_SPAN_ID = '0'.repeat(16);

/**
 * Serialise the active span as a `traceparent`, or `null` when nothing is tracing.
 * Stored on the queued row.
 */
export function currentTraceparent(): string | null {
  const spanContext = trace.getActiveSpan()?.spanContext();
  if (!spanContext) return null;
  if (spanContext.traceId === INVALID_TRACE_ID || spanContext.spanId === INVALID_SPAN_ID) {
    return null;
  }

  const flags = (spanContext.traceFlags & TraceFlags.SAMPLED ? 1 : 0).toString(16).padStart(2, '0');
  return `${VERSION}-${spanContext.traceId}-${spanContext.spanId}-${flags}`;
}

/** Parse a `traceparent`, or `null` when it is absent or malformed. */
function parseTraceparent(traceparent: string): SpanContext | null {
  const match = TRACEPARENT_PATTERN.exec(traceparent.trim().toLowerCase());
  if (!match) return null;

  const [, traceId, spanId, flags] = match;
  if (traceId === INVALID_TRACE_ID || spanId === INVALID_SPAN_ID) return null;

  return {
    traceId,
    spanId,
    traceFlags: Number.parseInt(flags, 16) & TraceFlags.SAMPLED,
    // The producer ran in another process, so this is a remote parent — that flag is
    // what makes the relay span a child instead of a new root.
    isRemote: true,
  };
}

/**
 * Run `fn` as a continuation of the trace `traceparent` came from.
 *
 * Falls through to running `fn` unchanged when the value is absent or malformed: a
 * bad header must never stop the work being relayed, it only loses the link.
 */
export function withRestoredTrace<T>(traceparent: string | null | undefined, fn: () => T): T {
  if (!traceparent) return fn();

  const parentContext = parseTraceparent(traceparent);
  if (!parentContext) return fn();

  return context.with(trace.setSpanContext(context.active(), parentContext), fn);
}
