/**
 * Why a send failed, in terms a caller can act on. Bounded on purpose: the `code` becomes a
 * metric label and a log field, so it is a closed union, never a provider message.
 *
 * | code               | meaning                                                         | retry? |
 * | ------------------ | --------------------------------------------------------------- | ------ |
 * | `invalid_message`  | the message failed validation or the provider rejected it (400) | no     |
 * | `unauthenticated`  | no token could be obtained, or the provider refused it (401)    | yes¹   |
 * | `forbidden`        | the app may not send from this mailbox (403, RBAC scope)         | no     |
 * | `mailbox_not_found`| the sender mailbox does not exist (404)                          | no     |
 * | `too_large`        | the message exceeds the provider's limit (413)                   | no     |
 * | `throttled`        | 429, or the mailbox's quota is exhausted                         | yes    |
 * | `unavailable`      | 5xx from the provider                                            | yes    |
 * | `network`          | no response (DNS, connection refused or reset)                   | yes    |
 * | `timeout`          | no response within the request timeout                           | yes    |
 * | `config`           | the transport is mis-configured; nothing was attempted           | no     |
 *
 * ¹ A credential problem can be fixed by an operator while the job waits, so it is retried.
 */
export type MailErrorCode =
  | 'invalid_message'
  | 'unauthenticated'
  | 'forbidden'
  | 'mailbox_not_found'
  | 'too_large'
  | 'throttled'
  | 'unavailable'
  | 'network'
  | 'timeout'
  | 'config';

const RETRYABLE: ReadonlySet<MailErrorCode> = new Set([
  'unauthenticated',
  'throttled',
  'unavailable',
  'network',
  'timeout',
]);

export interface MailSendErrorOptions {
  /** HTTP status of the provider response, when there was one. */
  status?: number | undefined;
  /** Seconds the provider asked us to wait (`Retry-After`), when it did. */
  retryAfterSeconds?: number | undefined;
  /** The provider's request id, for a support ticket. Never a secret. */
  requestId?: string | undefined;
  cause?: unknown;
}

/**
 * Every failure to deliver a message. The message text never contains the email's content,
 * its recipients or a credential — only the code, the status and the provider's request id —
 * because it is logged and stored in the failed job's row.
 */
export class MailSendError extends Error {
  readonly code: MailErrorCode;
  readonly status: number | undefined;
  readonly retryAfterSeconds: number | undefined;
  readonly requestId: string | undefined;

  constructor(code: MailErrorCode, message: string, options: MailSendErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'MailSendError';
    this.code = code;
    this.status = options.status;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.requestId = options.requestId;
  }

  /** Whether trying the same message again later can succeed without anyone changing anything. */
  get retryable(): boolean {
    return RETRYABLE.has(this.code);
  }
}

/** Misconfiguration found while reading the environment; nothing was attempted. */
export class MailConfigError extends MailSendError {
  constructor(message: string) {
    super('config', message);
    this.name = 'MailConfigError';
  }
}
