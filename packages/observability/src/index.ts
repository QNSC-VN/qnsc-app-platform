/**
 * Shared observability primitives.
 *
 * NOTE: `startOtel` / `shutdownOtel` are deliberately NOT re-exported here. The
 * OTel bootstrap must run before anything else is required, so importing it
 * through this barrel — which pulls in the logger and Nest types — would defeat
 * auto-instrumentation. Import them from `@qnsc-vn/observability/otel` instead.
 */
export * from './logger.factory';
export * from './request-context';
export * from './job-context';
export * from './metrics';
