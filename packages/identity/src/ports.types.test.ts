import { describe, expect, it } from 'vitest';
import type { DbExecutor } from '@quynhonsemiconductor/platform-db/drizzle';
import { AUTH_MAIL_PRIORITY, type JobEnqueue, type JobRegistry } from './ports';

/**
 * The ports must be satisfied by the real `platform-jobs` `Jobs` type. `platform-jobs` is not in
 * `main` yet (PR #173), so this is a STRUCTURAL test: the declarations below are copied from
 * `packages/platform-jobs/src/types.ts` of that PR (`SendOptions`, `ScheduleOptions`,
 * `HandleOptions`, `JobContext`, and the three members of `Jobs` identity touches), including the
 * generics. Once #173 is merged, replace the copy with
 * `import type { Jobs } from '@quynhonsemiconductor/platform-jobs'` (a devDependency) and delete it.
 *
 * The assertions are compile-time: `pnpm typecheck` (tsconfig.test.json) fails if a port stops
 * accepting the real type. The one runtime `it` exists so the file is also collected by the runner.
 */
interface RealSendOptions {
  tx?: DbExecutor;
  idempotencyKey?: string;
  startAfter?: Date | number;
  priority?: number;
}
interface RealScheduleOptions {
  tz?: string;
}
interface RealHandleOptions {
  concurrency?: number;
  pollingIntervalSeconds?: number;
  expireInSeconds?: number;
}
interface RealJobContext<T extends object = object> {
  id: string;
  data: T;
  attempt: number;
  signal: AbortSignal;
}
interface RealJobs {
  send<T extends object>(queue: string, data: T, options?: RealSendOptions): Promise<string | null>;
  handle<T extends object>(
    queue: string,
    handler: (job: RealJobContext<T>) => Promise<void>,
    options?: RealHandleOptions,
  ): Promise<void>;
  schedule(name: string, cron: string, data?: object, options?: RealScheduleOptions): Promise<void>;
}

// The assignments ARE the test. Never called: they exist to be type-checked.
export function realJobsSatisfyThePorts(jobs: RealJobs): [JobEnqueue, JobRegistry] {
  return [jobs, jobs];
}

// ...and the other direction: the port may not name an option `platform-jobs` lacks. This is the
// check that would have caught `retention`, which type-checks as an assignment (extra optional
// members are allowed) and is then silently ignored at run time.
type PortSendOptions = NonNullable<Parameters<JobEnqueue['send']>[2]>;
type MustBeNever<T extends never> = T;
export type NoOptionPlatformJobsLacks = MustBeNever<
  Exclude<keyof PortSendOptions, keyof RealSendOptions>
>;

describe('ports vs platform-jobs', () => {
  it('auth mail priority is a number platform-jobs understands (higher runs first)', () => {
    expect(AUTH_MAIL_PRIORITY).toBe(10);
    expect(AUTH_MAIL_PRIORITY).toBeGreaterThan(0);
  });
});
