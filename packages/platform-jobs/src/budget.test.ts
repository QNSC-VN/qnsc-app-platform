import { describe, expect, it } from 'vitest';
import { stopBudgetMs } from './budget';

describe('stopBudgetMs: the pod grace period minus the endpoint-removal delay (ADR 0001, F5)', () => {
  it('in a pod with the defaults: 25 s deadline - 5 s delay - 3 s reserve = 17 s', () => {
    expect(stopBudgetMs({ KUBERNETES_SERVICE_HOST: '10.43.0.1' })).toBe(17_000);
  });

  it('outside a pod there is no delay: 22 s', () => {
    expect(stopBudgetMs({})).toBe(22_000);
  });

  it('a worker has no HTTP server and so waited out no endpoint delay: the whole deadline is its own', () => {
    const pod = { KUBERNETES_SERVICE_HOST: '10.43.0.1' };
    expect(stopBudgetMs(pod, false)).toBe(22_000);
    expect(stopBudgetMs(pod, true)).toBe(17_000);
    expect(stopBudgetMs({ SHUTDOWN_ENDPOINT_DELAY_MS: '8000' }, false)).toBe(22_000);
  });

  it('follows the same variables as platform-runtime', () => {
    expect(stopBudgetMs({ SHUTDOWN_TIMEOUT_MS: '55000', SHUTDOWN_ENDPOINT_DELAY_MS: '5000' })).toBe(
      47_000,
    );
  });

  it('never goes below one second', () => {
    expect(stopBudgetMs({ SHUTDOWN_TIMEOUT_MS: '4000', SHUTDOWN_ENDPOINT_DELAY_MS: '3000' })).toBe(
      1_000,
    );
  });

  it('ignores a malformed value rather than inventing one', () => {
    expect(stopBudgetMs({ SHUTDOWN_TIMEOUT_MS: 'soon' })).toBe(22_000);
  });
});
