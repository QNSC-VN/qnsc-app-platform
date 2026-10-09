import { DEFAULTS } from './defaults';

/** Paths whose response time must not reveal whether an address has an account. */
const PADDED = new Set(['/request-password-reset', '/send-verification-email', '/sign-up/email']);

/**
 * Wrap `auth.handler` so the padded paths take at least `timingFloorMs` (WP-10 decision D10; WP-9
 * measured a 2-4 ms gap on `request-password-reset` for a known address, from the extra writes).
 * The floor is far above the real cost, so both outcomes take the same time. Sign-in needs none:
 * it already hashes for unknown addresses and measured equal.
 */
export function withTimingFloor(
  handler: (request: Request) => Promise<Response>,
  basePath: string,
  floorMs: number = DEFAULTS.timingFloorMs,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const started = performance.now();
    const response = await handler(request);
    const path = new URL(request.url).pathname;
    const relative = path.startsWith(basePath) ? path.slice(basePath.length) : path;
    if (request.method === 'POST' && PADDED.has(relative)) {
      const remaining = floorMs - (performance.now() - started);
      if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
    }
    return response;
  };
}
