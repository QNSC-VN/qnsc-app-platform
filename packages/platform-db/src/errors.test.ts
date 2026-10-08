import { describe, expect, it } from 'vitest';
import { classifyDatabaseError, DatabaseConnectionError } from './errors';

const target = { host: 'pg-rova-rw', port: 5432, database: 'rova', user: 'rova_app' };

/** What the Postgres driver and Node's TLS layer actually put on `.code`. */
function coded(code: string, message = code): Error {
  return Object.assign(new Error(message), { code });
}

describe('classifyDatabaseError', () => {
  it.each([
    ['28P01', 'AUTH_FAILED', /DATABASE_PASSWORD.*CloudNativePG/s],
    ['28000', 'AUTH_FAILED', /pg_hba|does not exist/],
    ['53300', 'CONNECTION_LIMIT', /CONNECTION LIMIT.*DB_POOL_MAX/s],
    ['SELF_SIGNED_CERT_IN_CHAIN', 'TLS_UNTRUSTED_CA', /DATABASE_SSL_CA/],
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'TLS_UNTRUSTED_CA', /DATABASE_SSL_CA/],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'TLS_UNTRUSTED_CA', /DATABASE_SSL_CA/],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'TLS_CERT_INVALID', /DATABASE_HOST/],
    ['CERT_HAS_EXPIRED', 'TLS_CERT_INVALID', /expired/],
    ['ECONNREFUSED', 'UNREACHABLE', /DATABASE_HOST/],
    ['ENOTFOUND', 'UNREACHABLE', /DNS/],
    ['ETIMEDOUT', 'UNREACHABLE', /NetworkPolicy/],
  ] as const)('%s → %s', (code, expected, message) => {
    const result = classifyDatabaseError(coded(code), target);
    expect(result).toBeInstanceOf(DatabaseConnectionError);
    expect(result.code).toBe(expected);
    expect(result.message).toMatch(message);
    expect(result.message).toContain('pg-rova-rw');
    expect(result.message).toContain('rova_app');
  });

  it('classifies a server that does not offer TLS, and says it will not downgrade', () => {
    const result = classifyDatabaseError(new Error('The server does not support SSL connections'));
    expect(result.code).toBe('TLS_NOT_OFFERED');
    expect(result.message).toMatch(/Refusing to fall back to plaintext/);
  });

  it('classifies the pool giving up on a connection', () => {
    const result = classifyDatabaseError(new Error('timeout exceeded when trying to connect'));
    expect(result.code).toBe('CONNECT_TIMEOUT');
    expect(result.message).toMatch(/DB_POOL_CONNECT_TIMEOUT_MS/);
  });

  it('finds the cause under the wrapper Drizzle puts around driver errors', () => {
    const wrapped = new Error('Failed query: select 1', { cause: coded('28P01') });
    expect(classifyDatabaseError(wrapped, target).code).toBe('AUTH_FAILED');
  });

  it('keeps the original error as `cause`', () => {
    const original = coded('28P01');
    expect(classifyDatabaseError(original).cause).toBe(original);
  });

  it('passes an already-classified error through untouched', () => {
    const classified = new DatabaseConnectionError('UNREACHABLE', 'x');
    expect(classifyDatabaseError(classified)).toBe(classified);
  });

  it('falls back to UNKNOWN rather than mislabelling what it does not recognise', () => {
    const result = classifyDatabaseError(new Error('something else'), target);
    expect(result.code).toBe('UNKNOWN');
    expect(result.message).toContain('something else');
  });

  it('survives a cause cycle', () => {
    const a: Error & { cause?: unknown } = new Error('a');
    a.cause = a;
    expect(classifyDatabaseError(a).code).toBe('UNKNOWN');
  });
});
