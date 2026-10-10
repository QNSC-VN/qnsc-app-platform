import { getMeter } from '@quynhonsemiconductor/observability';
import type { IdentityLogger, SecurityEvent, SecurityEventSink } from '../events';

/**
 * Security events -> `observability` (identity plan §5.2, §9.4; review A14): a counter
 * `identity.security_events{event}` for the Grafana alerts (failed sign-in spikes, lockout spikes,
 * account replacement) and one structured log line per event.
 *
 * `event` is a bounded enum, never a message. Log lines carry ids, the client address and counts only:
 * never an email address, a password or a token (the events do not contain them).
 */
export function observabilitySecurityEvents(logger: {
  info(object: Record<string, unknown>, message: string): void;
}): SecurityEventSink {
  const counter = getMeter().createCounter('identity.security_events', {
    description: 'Authentication security events by name',
  });
  return {
    emit(event: SecurityEvent) {
      counter.add(1, { event: event.name });
      logger.info(
        { event: event.name, userId: event.userId, ip: event.ip, ...event.detail },
        `security event: ${event.name}`,
      );
    },
  };
}

/** Adapt a pino-style logger (`warn(object, message)`) to the two-argument-free shape Better Auth's output needs. */
export function identityLoggerFrom(logger: {
  warn(object: Record<string, unknown>, message: string): void;
  error(object: Record<string, unknown>, message: string): void;
}): IdentityLogger {
  return {
    // A line with fields is identity's own (e.g. `identity.mail_enqueue_failed`); without, it is Better Auth's.
    warn: (message, fields) =>
      logger.warn({ source: fields ? 'identity' : 'better-auth', ...fields }, message),
    error: (message, fields) =>
      logger.error({ source: fields ? 'identity' : 'better-auth', ...fields }, message),
  };
}
