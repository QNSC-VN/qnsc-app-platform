/**
 * Request paths that produce neither a useful span nor a useful access-log line:
 * load-balancer probes and browser chrome.
 *
 * A leaf module with NO dependencies, on purpose. Both the OTel bootstrap and each
 * product's HTTP interceptor need this list, but the bootstrap must never be reachable
 * from the package barrel — it imports the whole SDK, and loading that before
 * instrumentation installs would leave modules unpatched. Putting the constant here
 * lets both sides share one list without the barrel dragging in the SDK.
 *
 * Both prefixed and unprefixed forms are listed so products differ in global prefix
 * without losing the filter.
 */
export const IGNORED_REQUEST_PATHS: ReadonlySet<string> = new Set([
  '/v1/healthz',
  '/v1/readyz',
  '/healthz',
  '/readyz',
  '/favicon.ico',
]);
