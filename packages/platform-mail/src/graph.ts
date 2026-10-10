import { randomUUID } from 'node:crypto';
import { MailSendError, type MailErrorCode } from './errors';
import {
  assertFromIsMailbox,
  validateMessage,
  type EmailMessage,
  type EmailSender,
  type SendOptions,
  type SendResult,
  type ValidatedMessage,
} from './message';

export const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
export const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';

/** The part of an `@azure/identity` credential this transport uses (`TokenCredential`). */
export interface TokenProvider {
  /** `abortSignal` is the caller's: a send that is cancelled must not wait on the authority. */
  getToken(
    scope: string,
    options?: { abortSignal?: AbortSignal },
  ): Promise<{ token: string } | null>;
}

export interface GraphSenderOptions {
  /** The product's shared mailbox: `POST /users/{sender}/sendMail`. */
  sender: string;
  credential: TokenProvider;
  /** Test seam; defaults to the global `fetch` (TLS verified by Node). */
  fetch?: typeof fetch;
  /** Test seam; defaults to the public Graph endpoint. */
  baseUrl?: string;
  /** Attempts per `send()`, counting the first. Default 3. */
  maxAttempts?: number;
  /** Per HTTP request. Default 15 s. */
  requestTimeoutMs?: number;
  /**
   * The longest `Retry-After` honoured inside one `send()`. A longer one is not waited out: the
   * error carries `retryAfterSeconds` and is thrown. The caller decides: the `mail.send`
   * handler records a mailbox-wide cooldown from it (every send waits it out) and the job's own
   * retry backoff applies; nothing reschedules the job for `retryAfterSeconds`. Default 30 s.
   */
  maxRetryAfterSeconds?: number;
  /** Test seam. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Test seam for backoff jitter. */
  random?: () => number;
}

/** Statuses where Graph did not accept the message, so sending it again cannot duplicate it. */
const RETRY_IN_PLACE: ReadonlySet<number> = new Set([429, 502, 503, 504]);

const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8_000;

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** `Retry-After` is delta-seconds or an HTTP date. Returns seconds, or `undefined` if absent/garbage. */
export function parseRetryAfter(
  header: string | null,
  now: number = Date.now(),
): number | undefined {
  if (header === null) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.ceil((date - now) / 1000));
}

function toRecipients(addresses: readonly string[]): { emailAddress: { address: string } }[] {
  return addresses.map((address) => ({ emailAddress: { address } }));
}

/**
 * The JSON body of `sendMail`. Exported for the tests.
 *
 * Graph's JSON body carries ONE body part: HTML or text, not both. The HTML part is sent and
 * the plain-text alternative is not (sending MIME instead would carry both, and is the
 * documented way if a product ever needs it). `saveToSentItems: false` keeps a `noreply`
 * mailbox from filling up with a copy of every message.
 */
export function buildGraphPayload(message: ValidatedMessage): unknown {
  const headers = Object.entries(message.headers).map(([name, value]) => ({ name, value }));
  return {
    message: {
      subject: message.subject,
      body: { contentType: 'HTML', content: message.html },
      toRecipients: toRecipients(message.to),
      ...(message.cc.length > 0 ? { ccRecipients: toRecipients(message.cc) } : {}),
      ...(message.bcc.length > 0 ? { bccRecipients: toRecipients(message.bcc) } : {}),
      ...(message.replyTo === undefined ? {} : { replyTo: toRecipients([message.replyTo]) }),
      ...(headers.length > 0 ? { internetMessageHeaders: headers } : {}),
    },
    saveToSentItems: false,
  };
}

const STATUS_CODE: Readonly<Record<number, MailErrorCode>> = {
  400: 'invalid_message',
  401: 'unauthenticated',
  403: 'forbidden',
  404: 'mailbox_not_found',
  413: 'too_large',
  429: 'throttled',
};

function codeForStatus(status: number): MailErrorCode {
  return STATUS_CODE[status] ?? (status >= 500 ? 'unavailable' : 'invalid_message');
}

/** Graph's machine-readable error code (`ErrorAccessDenied`), bounded; never its free-text message. */
async function providerErrorCode(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { error?: { code?: unknown } };
    const code = body?.error?.code;
    return typeof code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

class GraphSender implements EmailSender {
  readonly mailbox: string;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly maxAttempts: number;
  private readonly requestTimeoutMs: number;
  private readonly maxRetryAfterSeconds: number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly random: () => number;

  constructor(private readonly options: GraphSenderOptions) {
    this.mailbox = options.sender;
    this.fetchImpl = options.fetch ?? fetch;
    this.baseUrl = (options.baseUrl ?? GRAPH_BASE_URL).replace(/\/+$/, '');
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.maxRetryAfterSeconds = options.maxRetryAfterSeconds ?? 30;
    this.sleep = options.sleep ?? abortableSleep;
    this.random = options.random ?? Math.random;
  }

  async send(message: EmailMessage, sendOptions: SendOptions = {}): Promise<SendResult> {
    const validated = validateMessage(message);
    assertFromIsMailbox(validated, this.mailbox);

    const payload = JSON.stringify(buildGraphPayload(validated));
    // One id for every attempt of this send, so Microsoft support can correlate them.
    const clientRequestId = randomUUID();
    const url = `${this.baseUrl}/users/${encodeURIComponent(this.mailbox)}/sendMail`;
    const { signal } = sendOptions;

    for (let attempt = 1; ; attempt += 1) {
      const token = await this.token(signal);
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            'client-request-id': clientRequestId,
            'return-client-request-id': 'true',
          },
          body: payload,
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(this.requestTimeoutMs)])
            : AbortSignal.timeout(this.requestTimeoutMs),
        });
      } catch (err) {
        throw this.transportError(err, signal);
      }

      if (response.status === 202) {
        return {
          id: response.headers.get('request-id') ?? clientRequestId,
          transport: 'graph',
        };
      }

      const providerCode = await providerErrorCode(response);
      const requestId = response.headers.get('request-id') ?? clientRequestId;
      const retryAfterSeconds = parseRetryAfter(response.headers.get('retry-after'));
      const code = codeForStatus(response.status);
      const failure = new MailSendError(
        code,
        `Graph sendMail failed: HTTP ${response.status}${providerCode ? ` ${providerCode}` : ''} (request ${requestId})`,
        { status: response.status, retryAfterSeconds, requestId },
      );

      const canRetry =
        RETRY_IN_PLACE.has(response.status) &&
        attempt < this.maxAttempts &&
        (retryAfterSeconds === undefined || retryAfterSeconds <= this.maxRetryAfterSeconds);
      if (!canRetry) throw failure;

      const delayMs =
        retryAfterSeconds !== undefined
          ? retryAfterSeconds * 1000
          : this.random() * Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (attempt - 1));
      if (response.status === 429 && sendOptions.onThrottled) {
        // BEFORE waiting: the other workers must stop now, not when this one gives up or succeeds.
        try {
          await sendOptions.onThrottled(Math.max(1, Math.ceil(delayMs / 1000)));
        } catch {
          // Telling the others is best effort; this worker still waits.
        }
      }
      try {
        await this.sleep(delayMs, signal);
      } catch (err) {
        throw this.transportError(err, signal);
      }
    }
  }

  private async token(signal: AbortSignal | undefined): Promise<string> {
    try {
      const { credential } = this.options;
      const accessToken = await (signal
        ? credential.getToken(GRAPH_SCOPE, { abortSignal: signal })
        : credential.getToken(GRAPH_SCOPE));
      if (accessToken?.token) return accessToken.token;
      throw new Error('credential returned no token');
    } catch (err) {
      if (signal?.aborted) throw new MailSendError('timeout', 'Send aborted by the caller.');
      // The credential's message can quote the authority's response; its NAME is enough to act on.
      const name = err instanceof Error ? err.name : 'Error';
      throw new MailSendError('unauthenticated', `Could not obtain a Graph token (${name}).`);
    }
  }

  private transportError(err: unknown, signal: AbortSignal | undefined): MailSendError {
    if (signal?.aborted) {
      return new MailSendError('timeout', 'Send aborted by the caller.');
    }
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      return new MailSendError(
        'timeout',
        `Graph sendMail timed out after ${this.requestTimeoutMs} ms.`,
      );
    }
    const name = err instanceof Error ? err.name : 'Error';
    return new MailSendError('network', `Graph sendMail could not reach the service (${name}).`);
  }
}

/**
 * The `graph` transport: Microsoft Graph `POST /users/{mailbox}/sendMail` with an app-only
 * token. The mailbox is the product's own; the Entra app is authorised for that mailbox alone
 * through Exchange Online RBAC for Applications, so a message from any other mailbox is a 403
 * (`forbidden`), not something this code has to prevent.
 *
 * Retries inside one `send()`: 429, 502, 503 and 504 — responses on which Graph did not
 * accept the message — honouring `Retry-After` up to `maxRetryAfterSeconds`, else exponential
 * backoff with jitter. A timeout or a dropped connection is NOT retried here: the message may
 * have been accepted, so the decision (and the duplicate risk) belongs to the caller; the job
 * queue's idempotency check is the guard.
 */
export function createGraphSender(options: GraphSenderOptions): EmailSender {
  return new GraphSender(options);
}
