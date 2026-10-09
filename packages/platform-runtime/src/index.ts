/**
 * `@quynhonsemiconductor/platform-runtime`
 *
 * Runtime primitives every QNSC product backend needs and none of them should own a
 * private copy of: environment validation and typed access, `/livez` and `/readyz`, graceful
 * shutdown for pod drains, leader-elected scheduled jobs, and request-arrival timing.
 *
 * `load-env` is deliberately ABSENT from this barrel and reachable only at
 * `@quynhonsemiconductor/platform-runtime/load-env`. It must run before the OpenTelemetry
 * bootstrap, and importing it through here would first load Nest — the very modules
 * auto-instrumentation still needs to patch. Its own header explains the failure that
 * proved it.
 */
export * from './config';
export * from './scheduling';
export * from './http';
export * from './health';
export * from './shutdown';
