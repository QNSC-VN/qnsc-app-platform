/**
 * Request paths that produce neither a useful span nor a useful access-log line:
 * orchestrator probes and browser chrome.
 *
 * A leaf module with NO dependencies, on purpose. Both the OTel bootstrap and each
 * product's HTTP interceptor need this list, but the bootstrap must never be reachable
 * from the package barrel — it imports the whole SDK, and loading that before
 * instrumentation installs would leave modules unpatched. Putting the constant here
 * lets both sides share one list without the barrel dragging in the SDK.
 */

/**
 * Health-probe paths — the ONE list. The tracing ignore hook (`startOtel`) and the
 * request-log skip list (`HttpLoggingInterceptor` in `@quynhonsemiconductor/platform-http`)
 * both derive from it, so they cannot drift apart again: before this existed the tracing
 * list did not know `/livez` and the logging list knew only the two `/v1/*` paths, so every
 * kubelet probe produced a span and a log line.
 *
 * Both prefixed and unprefixed forms are listed so products differ in global prefix
 * without losing the filter. `/v1/*` stays until the last ECS/EKS deployment is retired.
 */
export const PROBE_PATHS: readonly string[] = Object.freeze([
  '/livez',
  '/readyz',
  '/v1/readyz',
  '/healthz',
  '/v1/healthz',
]);

/** Browser chrome — never a useful span or log line, but not a probe either. */
const BROWSER_CHROME_PATHS: readonly string[] = ['/favicon.ico'];

/** {@link PROBE_PATHS} plus browser chrome: everything tracing and access logs skip. */
export const IGNORED_REQUEST_PATHS: ReadonlySet<string> = new Set([
  ...PROBE_PATHS,
  ...BROWSER_CHROME_PATHS,
]);

/**
 * Whether a raw request URL is a probe or browser-chrome request. The query string is
 * ignored, so `/livez?verbose=1` is skipped like `/livez`. The match is on the whole
 * path, never a prefix: `/livez/anything` is a real route and stays visible.
 */
export function isIgnoredRequestPath(url: string | undefined): boolean {
  if (!url) return false;
  const queryStart = url.indexOf('?');
  return IGNORED_REQUEST_PATHS.has(queryStart === -1 ? url : url.slice(0, queryStart));
}
