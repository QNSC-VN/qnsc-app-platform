import { MailSendError } from './errors';

/**
 * A finished email. Rendering is the product's job: this package receives HTML and text and
 * never sees a template.
 *
 * Addresses are bare `local@domain` strings — no display names, no `Name <addr>` — so there is
 * nothing to parse and nothing for a header-injection payload to hide in. The sender's own
 * display name belongs to the mailbox.
 */
export interface EmailMessage {
  to: string | readonly string[];
  cc?: string | readonly string[] | undefined;
  bcc?: string | readonly string[] | undefined;
  /**
   * Optional, and only ever the configured sender mailbox. A message cannot choose another
   * mailbox: that would be spoofing at best and a 403 from Exchange RBAC at worst.
   */
  from?: string | undefined;
  replyTo?: string | undefined;
  subject: string;
  html: string;
  text: string;
  /** Extra headers. Names must start with `x-` (Microsoft Graph accepts nothing else). */
  headers?: Readonly<Record<string, string>> | undefined;
  /**
   * What kind of message this is (`auth.verify-email`, `digest.daily`), for routing and
   * metrics. It is a metric label: lower-case, dot/dash separated, at most 64 characters.
   */
  category: string;
  /**
   * Stable per message: a duplicate key produces one email. The `mail.send` handler checks it
   * BEFORE sending. A direct `send()` does not — it has no memory.
   */
  idempotencyKey: string;
  /**
   * The correlation id of the request that caused this email (platform contract §7): the job
   * continues it, so one id follows the action from the API request into the worker's log lines.
   * 1-128 characters from `[A-Za-z0-9._:-]`; anything else is rejected, never logged. Optional —
   * work that did not start in a request gets its own.
   */
  correlationId?: string | undefined;
}

export interface SendResult {
  /** The provider's request id (Graph `request-id`, SMTP `Message-ID`). For tracing, not for lookup. */
  id: string;
  /** Which transport delivered it. */
  transport: string;
}

export interface SendOptions {
  /** Abort the attempt, including a wait for `Retry-After`. */
  signal?: AbortSignal | undefined;
  /**
   * Called when the provider throttles the mailbox and the transport is about to WAIT it out inside
   * this `send()`, with the number of seconds it will wait. It is called BEFORE the wait, so the
   * caller can tell the other workers at once (the `mail.send` handler starts the mailbox-wide
   * cooldown from it). A throw is ignored.
   */
  onThrottled?: ((retryAfterSeconds: number) => void | Promise<void>) | undefined;
}

/**
 * The contract every transport satisfies, and the port `identity` v8 names (`EmailSender` in
 * its `ports.ts`): `identity`'s narrower message and `{ id }` result are assignable to and from
 * these, which `identity-contract.test.ts` pins.
 */
export interface EmailSender {
  send(message: EmailMessage, options?: SendOptions): Promise<SendResult>;
  /**
   * The mailbox this sender sends from, when it has one. The `mail.send` queue paces sends per
   * mailbox with it.
   */
  readonly mailbox?: string | undefined;
}

/** Limits that come from the providers, not from taste. */
export const MESSAGE_LIMITS = Object.freeze({
  /** Exchange Online: 500 recipients across to, cc and bcc. */
  maxRecipients: 500,
  /** RFC 5321 forbids a longer forward-path. */
  maxAddressLength: 254,
  /** RFC 5322 line limit. */
  maxSubjectLength: 998,
  /** Graph's request limit is about 4 MB with attachments; there are none, so this is generous. */
  maxBodyBytes: 2 * 1024 * 1024,
  maxHeaders: 10,
  maxHeaderValueLength: 998,
  maxCategoryLength: 64,
  maxIdempotencyKeyLength: 512,
});

// `local@domain.tld`: no whitespace, quotes, angle brackets, commas, semicolons or colons.
// Deliberately stricter than RFC 5322 — every real mailbox of ours fits, and the characters it
// excludes are the ones that turn an address into a second header or a second recipient.
const ADDRESS = /^[^\s@<>()[\],;:"\\]+@[^\s@<>()[\],;:"\\]+\.[^\s@<>()[\],;:"\\]+$/;
const CATEGORY = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const HEADER_NAME = /^x-[a-z0-9-]+$/i;
// Headers Exchange itself reads: they steer its transport rules, spam filtering and
// authentication results, so a message must not be able to set them.
const RESERVED_HEADER = /^x-(ms-exchange-|microsoft-)/i;
// Contract §7: the same class every service accepts a correlation id from.
const CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;
// eslint-disable-next-line no-control-regex -- the point is to reject control characters
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * Whether `value` is a correlation id a service may put in a log line (contract §7). A string
 * only: a number or an object is not coerced into one.
 */
export function isCorrelationId(value: unknown): value is string {
  return typeof value === 'string' && CORRELATION_ID.test(value);
}

function invalid(reason: string): never {
  throw new MailSendError('invalid_message', `Invalid email message: ${reason}`);
}

function list(value: string | readonly string[] | undefined): readonly string[] {
  if (value === undefined) return [];
  return typeof value === 'string' ? [value] : value;
}

function checkAddress(field: string, value: unknown): string {
  if (typeof value !== 'string') invalid(`${field} must be a string`);
  if (value.length === 0 || value.length > MESSAGE_LIMITS.maxAddressLength) {
    invalid(`${field} must be 1-${MESSAGE_LIMITS.maxAddressLength} characters`);
  }
  // `\s` in ADDRESS covers CR, LF and tab but not NUL, the other C0 controls or DEL.
  if (CONTROL.test(value)) invalid(`${field} contains a control character`);
  if (!ADDRESS.test(value)) invalid(`${field} is not a plain email address`);
  return value;
}

/** A message that passed {@link validateMessage}: addresses as arrays, nothing optional left to guess. */
export interface ValidatedMessage {
  to: readonly string[];
  cc: readonly string[];
  bcc: readonly string[];
  from: string | undefined;
  replyTo: string | undefined;
  subject: string;
  html: string;
  text: string;
  headers: Readonly<Record<string, string>>;
  category: string;
  idempotencyKey: string;
  correlationId: string | undefined;
}

/**
 * Check a message BEFORE any network call or any database write, so a bad message fails the
 * caller's transaction rather than a worker an hour later. Throws `MailSendError('invalid_message')`
 * whose text names the field and never echoes the value (a subject or a body can be private).
 */
export function validateMessage(message: EmailMessage): ValidatedMessage {
  if (message === null || typeof message !== 'object') invalid('message must be an object');

  const to = list(message.to).map((a, i) => checkAddress(`to[${i}]`, a));
  const cc = list(message.cc).map((a, i) => checkAddress(`cc[${i}]`, a));
  const bcc = list(message.bcc).map((a, i) => checkAddress(`bcc[${i}]`, a));
  if (to.length === 0) invalid('to must contain at least one recipient');
  if (to.length + cc.length + bcc.length > MESSAGE_LIMITS.maxRecipients) {
    invalid(`more than ${MESSAGE_LIMITS.maxRecipients} recipients`);
  }

  const from = message.from === undefined ? undefined : checkAddress('from', message.from);
  const replyTo =
    message.replyTo === undefined ? undefined : checkAddress('replyTo', message.replyTo);

  if (typeof message.subject !== 'string' || message.subject.trim() === '') {
    invalid('subject must be a non-empty string');
  }
  if (message.subject.length > MESSAGE_LIMITS.maxSubjectLength) invalid('subject is too long');
  if (CONTROL.test(message.subject)) invalid('subject contains a control character');

  for (const field of ['html', 'text'] as const) {
    const body = message[field];
    if (typeof body !== 'string' || body === '') invalid(`${field} must be a non-empty string`);
    if (Buffer.byteLength(body, 'utf8') > MESSAGE_LIMITS.maxBodyBytes)
      invalid(`${field} is too large`);
  }

  const headers: Record<string, string> = {};
  const entries = Object.entries(message.headers ?? {});
  if (entries.length > MESSAGE_LIMITS.maxHeaders) invalid('too many headers');
  for (const [name, value] of entries) {
    if (!HEADER_NAME.test(name))
      invalid('header names must start with "x-" and use letters, digits and "-"');
    if (RESERVED_HEADER.test(name)) invalid(`header ${name} is reserved by Exchange`);
    if (
      typeof value !== 'string' ||
      value.length > MESSAGE_LIMITS.maxHeaderValueLength ||
      CONTROL.test(value)
    ) {
      invalid(`header ${name} has an invalid value`);
    }
    headers[name] = value;
  }

  if (
    typeof message.category !== 'string' ||
    message.category.length > MESSAGE_LIMITS.maxCategoryLength ||
    !CATEGORY.test(message.category)
  ) {
    invalid(
      'category must be lower-case words separated by ".", "-" or "_" (at most 64 characters)',
    );
  }

  if (
    typeof message.idempotencyKey !== 'string' ||
    message.idempotencyKey === '' ||
    message.idempotencyKey.length > MESSAGE_LIMITS.maxIdempotencyKeyLength ||
    CONTROL.test(message.idempotencyKey)
  ) {
    invalid('idempotencyKey must be a non-empty string without control characters');
  }

  if (message.correlationId !== undefined && !isCorrelationId(message.correlationId)) {
    invalid('correlationId must be 1-128 characters from [A-Za-z0-9._:-]');
  }

  return {
    to,
    cc,
    bcc,
    from,
    replyTo,
    subject: message.subject,
    html: message.html,
    text: message.text,
    headers,
    category: message.category,
    idempotencyKey: message.idempotencyKey,
    correlationId: message.correlationId,
  };
}

/**
 * A message can only be sent from the transport's own mailbox: another one is spoofing at best
 * and, on Graph, a 403 from Exchange RBAC at worst. Checked before anything is sent, by every
 * transport, so the behaviour does not depend on which one is configured.
 */
export function assertFromIsMailbox(message: ValidatedMessage, mailbox: string): void {
  if (message.from !== undefined && message.from.toLowerCase() !== mailbox.toLowerCase()) {
    throw new MailSendError(
      'invalid_message',
      'Invalid email message: from must be the configured sender mailbox or omitted.',
    );
  }
}
