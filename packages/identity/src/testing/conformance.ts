import { hardeningConformance } from './conformance-hardening';
import { decisionsConformance } from './conformance-decisions';
import { defaultsConformance } from './conformance-defaults';
import type { ConformanceInfra } from './harness';
import type { TestApi } from './support';

/**
 * The identity conformance kit. Run it in a product's CI against its own `ConformanceInfra`
 * (PostgreSQL 18 + Valkey) to prove that every secure default of identity plan §5.4 and every
 * decision of ADR 0002 is still in force after a Better Auth bump or a change to `defaults.ts`.
 *
 * ```ts
 * import { describe, it, beforeAll, afterAll, expect } from 'vitest';
 * runIdentityConformance({ describe, it, beforeAll, afterAll, expect }, infra);
 * ```
 */
export function runIdentityConformance(t: TestApi, infra: ConformanceInfra): void {
  t.describe('identity conformance: secure defaults (plan §5.4)', () =>
    defaultsConformance(t, infra),
  );
  t.describe('identity conformance: decisions (ADR 0002, plan §13)', () =>
    decisionsConformance(t, infra),
  );
  t.describe('identity conformance: review hardening (PR #168)', () =>
    hardeningConformance(t, infra),
  );
}
