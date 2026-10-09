/**
 * Errors that name their cause.
 *
 * A bare `28P01` or `SELF_SIGNED_CERT_IN_CHAIN` in a pod's logs sends an engineer to the
 * database, when the fault is usually one hop away: a stale secret, the wrong CA file, a
 * pool sized past the role's `CONNECTION LIMIT`. Every failure that reaches a caller through
 * this package is classified into a {@link DatabaseErrorCode} and carries a message saying
 * which environment variable or Kubernetes object to look at.
 */

export type DatabaseErrorCode =
  /** A required variable is missing or malformed. Thrown before any connection is tried. */
  | 'CONFIG'
  /** `28P01` / `28000`: the server refused the role or its password. */
  | 'AUTH_FAILED'
  /** The server certificate does not chain to `DATABASE_SSL_CA`. */
  | 'TLS_UNTRUSTED_CA'
  /** The certificate chains to the CA but is not valid for `DATABASE_HOST`, or has expired. */
  | 'TLS_CERT_INVALID'
  /** TLS is required and the server does not offer it. Never silently downgraded. */
  | 'TLS_NOT_OFFERED'
  /** `53300`: the role or the server is out of connection slots. */
  | 'CONNECTION_LIMIT'
  /** DNS, refused or timed-out TCP connection. */
  | 'UNREACHABLE'
  /** The pool gave up waiting for a connection (`DB_POOL_CONNECT_TIMEOUT_MS`). */
  | 'CONNECT_TIMEOUT'
  | 'UNKNOWN';

/** A configuration problem, found before any connection is attempted. */
export class DatabaseConfigError extends Error {
  readonly code = 'CONFIG' as const;
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseConfigError';
  }
}

/** A failure to reach, authenticate to or hold a connection with the database. */
export class DatabaseConnectionError extends Error {
  constructor(
    readonly code: DatabaseErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'DatabaseConnectionError';
  }
}

/** What the caller was trying to reach, so a message can say more than "the database". */
export interface ConnectionTarget {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
}

interface ErrorLike {
  code?: unknown;
  message?: unknown;
  cause?: unknown;
}

/**
 * Drizzle WRAPS driver errors ("Failed query: …") and keeps the original on `.cause`, so a
 * check on the top-level error alone silently never matches. Look at the whole chain.
 */
function chain(err: unknown): ErrorLike[] {
  const out: ErrorLike[] = [];
  let current: unknown = err;
  while (current !== null && typeof current === 'object' && out.length < 8) {
    out.push(current as ErrorLike);
    current = (current as ErrorLike).cause;
  }
  return out;
}

const UNTRUSTED_CA_CODES = new Set([
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_UNTRUSTED',
]);
const CERT_INVALID_CODES = new Set([
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_REVOKED',
]);
const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  // 57P03: the server is up but still starting or recovering.
  '57P03',
]);

function where(target: ConnectionTarget): string {
  const host = target.host
    ? `${target.host}${target.port ? `:${target.port}` : ''}`
    : 'the database';
  const as = target.user ? ` as role "${target.user}"` : '';
  const db = target.database ? ` (database "${target.database}")` : '';
  return `${host}${as}${db}`;
}

/**
 * Turn whatever the driver threw into a {@link DatabaseConnectionError} whose message names
 * the cause and the thing to check. Already-classified errors pass through unchanged.
 */
export function classifyDatabaseError(
  err: unknown,
  target: ConnectionTarget = {},
): DatabaseConnectionError {
  if (err instanceof DatabaseConnectionError) return err;

  const links = chain(err);
  const codes = links.map((l) => (typeof l.code === 'string' ? l.code : '')).filter(Boolean);
  const text = links.map((l) => (typeof l.message === 'string' ? l.message : '')).join(' | ');
  const has = (set: Set<string>) => codes.some((c) => set.has(c));
  const at = where(target);

  const make = (code: DatabaseErrorCode, message: string) =>
    new DatabaseConnectionError(code, message, { cause: err });

  if (codes.includes('28P01')) {
    return make(
      'AUTH_FAILED',
      `Password authentication failed for ${at}. DATABASE_PASSWORD is wrong, stale or empty: ` +
        'in Kubernetes it comes from the CloudNativePG-generated Secret, and pods read it at ' +
        'start, so after a rotation the pods need a rolling restart.',
    );
  }
  if (codes.includes('28000')) {
    return make(
      'AUTH_FAILED',
      `The server rejected ${at} (28000). The role does not exist, cannot log in, or ` +
        'pg_hba.conf does not allow this client. Check DATABASE_USER and the role in the cluster.',
    );
  }
  if (codes.includes('53300') || /too many (connections|clients)/i.test(text)) {
    return make(
      'CONNECTION_LIMIT',
      `No connection slot is free for ${at} (53300). The role's CONNECTION LIMIT or the ` +
        "server's max_connections is reached. replicas × DB_POOL_MAX must stay under it: lower " +
        'DB_POOL_MAX, or put a CNPG Pooler in front.',
    );
  }
  if (has(UNTRUSTED_CA_CODES)) {
    return make(
      'TLS_UNTRUSTED_CA',
      `The TLS certificate presented by ${at} does not chain to the CA in DATABASE_SSL_CA ` +
        `(${codes.find((c) => UNTRUSTED_CA_CODES.has(c))}). Mount the CA of the cluster you are ` +
        'connecting to (for CloudNativePG: the <cluster>-ca Secret). Verification is never ' +
        'turned off to work around this.',
    );
  }
  if (has(CERT_INVALID_CODES)) {
    return make(
      'TLS_CERT_INVALID',
      `The TLS certificate presented by ${at} is not acceptable (${codes.find((c) => CERT_INVALID_CODES.has(c))}). ` +
        'Either DATABASE_HOST is not one of the names on the certificate (use the cluster service ' +
        'name, e.g. <cluster>-rw), or the certificate has expired.',
    );
  }
  if (/does not support SSL/i.test(text)) {
    return make(
      'TLS_NOT_OFFERED',
      `${at} does not offer TLS, and TLS is required. Refusing to fall back to plaintext. ` +
        'Point DATABASE_HOST at a server with TLS enabled; DATABASE_SSL=disable exists only for ' +
        'local development and is refused when NODE_ENV=production.',
    );
  }
  if (/timeout exceeded when trying to connect/i.test(text)) {
    return make(
      'CONNECT_TIMEOUT',
      `Timed out waiting for a connection to ${at}. Either the server is unreachable or every ` +
        'pooled connection is busy: see DB_POOL_CONNECT_TIMEOUT_MS and DB_POOL_MAX.',
    );
  }
  if (has(UNREACHABLE_CODES)) {
    return make(
      'UNREACHABLE',
      `Cannot reach ${at} (${codes.find((c) => UNREACHABLE_CODES.has(c))}). Check DATABASE_HOST / ` +
        'DATABASE_PORT, DNS, and the NetworkPolicy between this pod and the cluster.',
    );
  }
  return make('UNKNOWN', `Database error for ${at}: ${links[0]?.message ?? String(err)}`);
}
