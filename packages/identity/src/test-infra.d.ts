/**
 * The slice of `@quynhonsemiconductor/testing` this package's tests use, declared here and mapped in
 * tsconfig.test.json. Importing the real source type-checks its TLS helper too, and that file does not
 * compile in a program that also contains Better Auth's types (the SAML dependency `@xmldom/xmldom`
 * pulls in the DOM library, which changes the global `Crypto`). Vitest still loads the real module.
 */
import type { Pool, PoolConfig } from 'pg';

export function dockerTestsEnabled(): Promise<boolean>;

export interface PostgresHarness {
  env(): Record<string, string>;
  createPool(overrides?: PoolConfig): Pool;
  stop(): Promise<void>;
}
export function startPostgres(options?: { database?: string }): Promise<PostgresHarness>;

export interface ValkeyHarness {
  readonly url: string;
  stop(): Promise<void>;
}
export function startValkey(): Promise<ValkeyHarness>;
