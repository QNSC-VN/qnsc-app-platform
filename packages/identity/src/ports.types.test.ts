import { describe, expect, it } from 'vitest';
import type { Jobs, SendOptions } from '@quynhonsemiconductor/platform-jobs';
import { AUTH_MAIL_PRIORITY, type JobEnqueue, type JobRegistry } from './ports';

/**
 * The ports must be satisfied by the real `platform-jobs` `Jobs` type. The assertions are compile-time:
 * `pnpm typecheck` (tsconfig.test.json) fails if a port stops accepting the real type. The one runtime
 * `it` exists so the file is also collected by the runner.
 */

// The assignments ARE the test. Never called: they exist to be type-checked.
export function realJobsSatisfyThePorts(jobs: Jobs): [JobEnqueue, JobRegistry] {
  return [jobs, jobs];
}

// ...and the other direction: the port may not name an option `platform-jobs` lacks. This is the check
// that would have caught `retention`, which type-checks as an assignment (extra optional members are
// allowed) and is then silently ignored at run time.
type PortSendOptions = NonNullable<Parameters<JobEnqueue['send']>[2]>;
type MustBeNever<T extends never> = T;
export type NoOptionPlatformJobsLacks = MustBeNever<
  Exclude<keyof PortSendOptions, keyof SendOptions>
>;

describe('ports vs platform-jobs', () => {
  it('auth mail priority is a number platform-jobs understands (higher runs first)', () => {
    expect(AUTH_MAIL_PRIORITY).toBe(10);
    expect(AUTH_MAIL_PRIORITY).toBeGreaterThan(0);
  });
});
