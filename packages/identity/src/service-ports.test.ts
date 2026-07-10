import { describe, expect, it } from 'vitest';
import {
  ACCESS_SERVICE,
  AUDIT_SERVICE,
  WORKSPACE_SERVICE,
  type IAccessService,
  type IAuditService,
  type IWorkspaceService,
} from './service-ports';
import { TRANSACTION_RUNNER, type ITransactionRunner } from './transaction-runner';

describe('service port DI tokens', () => {
  it('are distinct symbols', () => {
    const tokens = [ACCESS_SERVICE, WORKSPACE_SERVICE, AUDIT_SERVICE, TRANSACTION_RUNNER];
    expect(tokens.every((t) => typeof t === 'symbol')).toBe(true);
    expect(new Set(tokens).size).toBe(tokens.length);
  });
});

// ── Compile-time contract checks ─────────────────────────────────────────────
// Never executed; they fail the build if a port's shape regresses.

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _access: IAccessService = {
  getUserRoleAndPermissions: async () => ({ role: 'r', permissions: [] }),
  elevateToWorkspaceAdmin: async () => false,
  ensureDefaultRole: async () => {},
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _workspace: IWorkspaceService = {
  getMemberships: async () => [],
  getMembership: async () => null,
  touchMembership: async () => {},
  enrollMember: async () => {},
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _audit: IAuditService = {
  record: async () => {},
};

type Tx = { readonly _brand: 'tx' };

const _runner: ITransactionRunner<Tx> = {
  transaction: async (fn) => fn({ _brand: 'tx' }),
};

describe('transaction runner threads its tx handle', () => {
  it('passes the tx to the callback and returns its result', async () => {
    let received: Tx | null = null;
    const result = await _runner.transaction(async (tx) => {
      received = tx;
      return 42;
    });
    expect(result).toBe(42);
    expect(received).toEqual({ _brand: 'tx' });
  });
});
