import { describe, expect, it } from 'vitest';
import { FAIL_OPEN_FIELD, failOpenLog, type FailOpenControl } from './fail-open';

/**
 * These assertions belong to the package because the guarantee belongs to the
 * package: consumers point a CloudWatch metric filter at `$.securityFailOpen`,
 * and nothing in their own code can stop this helper from emitting a different
 * shape. They previously lived in rally's repo, which meant the second consumer
 * inherited the behaviour without inheriting the guard.
 *
 * What CANNOT move here is the other half of the contract — that a consumer's
 * Terraform actually filters on the field. Each app repo asserts that against its
 * own `infra/` tree (rally: `libs/platform/src/observability/fail-open.spec.ts`),
 * because the package has no infrastructure to inspect. A repo adopting this
 * package needs its own copy of that check, or its alarm is disarmed while the app
 * still emits the field.
 */
describe('failOpenLog', () => {
  it('tags the control that degraded', () => {
    expect(failOpenLog('denylist')).toEqual({ securityFailOpen: 'denylist' });
    expect(failOpenLog('rate_limit')).toEqual({ securityFailOpen: 'rate_limit' });
  });

  it('preserves the caller context', () => {
    const err = new Error('ECONNRESET');
    expect(failOpenLog('rate_limit', { err, ip: '1.1.1.1' })).toEqual({
      err,
      ip: '1.1.1.1',
      securityFailOpen: 'rate_limit',
    });
  });

  it('does not let caller context overwrite the field the alarm matches', () => {
    // The spread puts the control LAST on purpose. A caller passing its own
    // `securityFailOpen` — by accident, or by logging a payload it received —
    // must not be able to relabel or blank the signal an alarm is watching.
    expect(failOpenLog('denylist', { [FAIL_OPEN_FIELD]: 'rate_limit' })).toEqual({
      securityFailOpen: 'denylist',
    });
  });

  it('emits the exact field name consumers alarm on', () => {
    // Renaming this is invisible from both sides: the app keeps logging, the
    // filter keeps matching nothing. Pin the literal, not just the reference.
    expect(FAIL_OPEN_FIELD).toBe('securityFailOpen');
  });
});

/**
 * Every control must be a deliberate addition. `Record<FailOpenControl, …>` makes
 * widening the union a COMPILE error here until the new control is listed, which
 * is the moment to ask whether it needs its own alarm treatment — the union is
 * both a metric label and an alarm-pattern match, so it has to stay bounded.
 */
describe('FailOpenControl', () => {
  const CONTROLS: Record<FailOpenControl, true> = {
    denylist: true,
    rate_limit: true,
    authz_epoch: true,
    authz_epoch_bump: true,
  };

  it.each(Object.keys(CONTROLS) as FailOpenControl[])('%s produces a tagged payload', (control) => {
    expect(failOpenLog(control)).toEqual({ [FAIL_OPEN_FIELD]: control });
  });
});
