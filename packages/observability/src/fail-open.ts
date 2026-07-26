/**
 * Fail-open telemetry.
 *
 * Security controls that deliberately fail OPEN when their backing cache is
 * unreachable — typically an access-token denylist and a rate limiter.
 * Both choices are right on their own — an outage should not lock every user out,
 * and rate limiting is protective rather than load-bearing — but together they
 * mean a cache outage silently accepts revoked tokens AND serves unlimited
 * traffic. Until now the only trace was a `logger.warn`, which nothing watched.
 *
 * Emit BOTH signals for one event: this structured log field, which a log-based
 * alarm can match while OTel is disabled, and `SecurityMetrics.recordFailOpen`,
 * which drives the same alert once metrics have a backend. Neither alone survives
 * the migration without a gap, so {@link FailOpenControl} is shared between them —
 * a label and an alarm pattern that disagree are worse than either missing.
 */

/**
 * Which control degraded. A closed union, not a string: the value becomes both a
 * CloudWatch metric-filter match and a metric label, so it must stay bounded.
 *
 * `authz_epoch` — the epoch lookup could not be answered, so a possibly-superseded
 * token was allowed through. `authz_epoch_bump` — a permission change could not be
 * recorded, so it will not propagate until the token expires.
 */
export type FailOpenControl = 'denylist' | 'rate_limit' | 'authz_epoch' | 'authz_epoch_bump';

/**
 * The log field the alarm matches: `{ $.securityFailOpen = "*" }`.
 *
 * Renaming this breaks the alarm silently, so it lives here as a named constant
 * and is referenced by the metric filter's comment in the Terraform.
 */
export const FAIL_OPEN_FIELD = 'securityFailOpen';

/**
 * Build the structured payload for a fail-open event.
 *
 * @example
 * this.logger.warn(
 *   failOpenLog('denylist', { err }),
 *   'Token denylist check failed; failing open',
 * );
 */
export function failOpenLog(
  control: FailOpenControl,
  context: Record<string, unknown> = {},
): Record<string, unknown> {
  return { ...context, [FAIL_OPEN_FIELD]: control };
}
