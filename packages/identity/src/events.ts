import { requestCorrelationId, validCorrelationId } from './correlation';
/**
 * Security events (identity plan §5.2, §9.4). Identity raises them; the product decides where they
 * go (`observability` metrics and logs, the audit table). A sink must not throw into the request:
 * identity swallows and logs a failing sink.
 */
export type SecurityEventName =
  | 'sign_in.success'
  | 'sign_in.failure'
  | 'account.locked'
  | 'password.reset_requested'
  | 'password.reset'
  | 'sessions.revoked'
  | 'account.unverified_replaced'
  | 'account.unverified_purged'
  | 'admin.user_banned';

export interface SecurityEvent {
  name: SecurityEventName;
  /** Never an email address or a token: ids and counts only. */
  userId?: string;
  ip?: string;
  detail?: Record<string, string | number | boolean>;
}

export interface SecurityEventSink {
  emit(event: SecurityEvent): void | Promise<void>;
}

export const noopSink: SecurityEventSink = { emit: () => undefined };

/** Emit without ever letting the sink break authentication. */
export async function emitSafely(
  sink: SecurityEventSink,
  event: SecurityEvent,
  onError: (error: unknown) => void = () => undefined,
): Promise<void> {
  try {
    await sink.emit(event);
  } catch (error) {
    onError(error);
  }
}

/**
 * Where Better Auth's own log lines go. Satisfied by a Nest `Logger`, a pino logger or `console`.
 * Only `warn` and `error` are forwarded (failed sign-ins and refused requests are warnings there);
 * Better Auth never logs a password or a token in them.
 */
export interface IdentityLogger {
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

/** Structured fields for a log line: bounded identifiers only, never an address or a token. */
export type LogFields = Record<string, string | number | boolean>;

/** Logged at ERROR when Better Auth's handler threw instead of answering; the request got a 500. */
export const AUTH_HANDLER_THREW = 'identity.auth_handler_threw';

/**
 * What may be said about an error in a log line: its class and the SQLSTATE or code it carries, the
 * same for its cause (a Drizzle error wraps the driver's), and the request's correlation id. Never
 * the message: a database error can quote the row, the address or the statement.
 *
 * `error` is the class (`DrizzleQueryError`, not the `Error` its `name` says), `cause` the cause's,
 * `errorCode` the first string `code` on the chain (`25P02`, `P0001`, `ECONNRESET`).
 */
export function errorFields(error: unknown): LogFields {
  const bounded = (value: unknown): string | undefined =>
    typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(value) ? value : undefined;
  const className = (e: unknown): string | undefined =>
    bounded((e as { constructor?: { name?: unknown } })?.constructor?.name) ??
    bounded((e as Error)?.name);
  const chain: unknown[] = [];
  for (let e = error; e && chain.length < 4; e = (e as { cause?: unknown }).cause) chain.push(e);
  const name = chain.length > 0 ? className(chain[0]) : undefined;
  const cause = chain.length > 1 ? className(chain[1]) : undefined;
  const errorCode = chain.map((e) => bounded((e as { code?: unknown }).code)).find(Boolean);
  const correlationId = validCorrelationId(requestCorrelationId());
  return {
    ...(name ? { error: name } : {}),
    ...(cause ? { cause } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(correlationId ? { correlationId } : {}),
  };
}

/** Used when a product passes no `logger`. */
export const consoleLogger: IdentityLogger = {
  warn: (message, fields) => console.warn(message, fields ?? ''),
  error: (message, fields) => console.error(message, fields ?? ''),
};

/**
 * Logged at ERROR when an auth email could not be enqueued (for example `mail.send` was never
 * registered in this process). Better Auth swallows the throw and answers as if nothing were wrong, so
 * this line is the only sign; alert on it.
 */
export const MAIL_ENQUEUE_FAILED = 'identity.mail_enqueue_failed';
