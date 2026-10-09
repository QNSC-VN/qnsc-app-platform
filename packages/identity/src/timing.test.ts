import { afterEach, describe, expect, it, vi } from 'vitest';
import { withTimingFloor } from './timing';

const call = (handler: ReturnType<typeof withTimingFloor>, path: string, method = 'POST') =>
  handler(new Request(`https://x.test/api/auth${path}`, { method }));

/** Fake clock: no wall-clock bounds, so a slow CI machine cannot fail these. */
describe('withTimingFloor', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const settled = (promise: Promise<unknown>) => {
    const state = { done: false };
    void promise.then(() => (state.done = true));
    return state;
  };

  it('holds the enumeration-sensitive POST paths until the floor has passed', async () => {
    vi.useFakeTimers();
    const fast = withTimingFloor(async () => new Response('ok'), '/api/auth', 60);
    for (const path of ['/request-password-reset', '/send-verification-email', '/sign-up/email']) {
      const state = settled(call(fast, path));
      await vi.advanceTimersByTimeAsync(59);
      expect(state.done, `${path} before the floor`).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(state.done, `${path} at the floor`).toBe(true);
    }
  });

  it('does not delay any other path, or a GET, at all', async () => {
    vi.useFakeTimers();
    const fast = withTimingFloor(async () => new Response('ok'), '/api/auth', 60);
    const timers = vi.getTimerCount();
    await call(fast, '/get-session', 'GET'); // resolves with the clock frozen: nothing was scheduled
    await call(fast, '/sign-in/email');
    await call(fast, '/request-password-reset', 'GET');
    expect(vi.getTimerCount()).toBe(timers);
  });

  it('adds nothing to a response that already took longer than the floor', async () => {
    vi.useFakeTimers();
    const slow = withTimingFloor(
      async () => (await new Promise((r) => setTimeout(r, 80)), new Response('ok')),
      '/api/auth',
      60,
    );
    const state = settled(call(slow, '/request-password-reset'));
    await vi.advanceTimersByTimeAsync(80);
    expect(state.done).toBe(true); // 80 ms is past the floor: no extra wait on top
  });
});
