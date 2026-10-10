import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphServer, graphError } from './__helpers__/graph-server';
import { MailSendError } from './errors';
import { buildGraphPayload, createGraphSender, parseRetryAfter, GRAPH_SCOPE } from './graph';
import { validateMessage, type EmailMessage } from './message';
import {
  describeEmailSenderConformance,
  sampleMessage,
  type DeliveredMessage,
} from './testing/conformance';

const SENDER = 'noreply-academy@qnsc.vn';

/** A credential that hands out a fixed token and remembers what scope was asked. */
function credential(token = 'test-token-not-a-secret') {
  const getToken = vi.fn(async (_scope: string) => ({ token }));
  return { getToken };
}

let server: GraphServer;
const sleeps: number[] = [];
const instantSleep = async (ms: number): Promise<void> => {
  sleeps.push(ms);
};

beforeEach(async () => {
  server = new GraphServer();
  await server.start();
  sleeps.length = 0;
});
afterEach(async () => {
  await server.stop();
});

function sender(overrides: Partial<Parameters<typeof createGraphSender>[0]> = {}) {
  return createGraphSender({
    sender: SENDER,
    credential: credential(),
    baseUrl: server.baseUrl,
    sleep: instantSleep,
    random: () => 1,
    ...overrides,
  });
}

// ── The conformance suite, against recorded HTTP including 429 Retry-After ─────────────────────
describeEmailSenderConformance({
  name: 'graph (local HTTP server)',
  create: async () => {
    const own = new GraphServer();
    await own.start();
    const graph = createGraphSender({
      sender: SENDER,
      credential: credential(),
      baseUrl: own.baseUrl,
      sleep: async () => {},
      random: () => 1,
    });
    return {
      sender: graph,
      delivered: async (): Promise<DeliveredMessage[]> =>
        own.accepted.map((request) => {
          const { message } = request.body as {
            message: {
              subject: string;
              body: { content: string };
              toRecipients: { emailAddress: { address: string } }[];
              ccRecipients?: { emailAddress: { address: string } }[];
              bccRecipients?: { emailAddress: { address: string } }[];
              replyTo?: { emailAddress: { address: string } }[];
              internetMessageHeaders?: { name: string; value: string }[];
            };
          };
          const addresses = (list?: { emailAddress: { address: string } }[]) =>
            (list ?? []).map((r) => r.emailAddress.address);
          return {
            to: addresses(message.toRecipients),
            cc: addresses(message.ccRecipients),
            bcc: addresses(message.bccRecipients),
            replyTo: addresses(message.replyTo)[0],
            subject: message.subject,
            html: message.body.content,
            headers: Object.fromEntries(
              (message.internetMessageHeaders ?? []).map((h) => [h.name, h.value]),
            ),
          };
        }),
      failNext: (fault) => {
        if (fault.kind === 'throttled') {
          own.reply({
            status: 429,
            headers: { 'retry-after': String(fault.retryAfterSeconds) },
            body: graphError('ApplicationThrottled'),
          });
        } else if (fault.kind === 'forbidden') {
          own.reply({ status: 403, body: graphError('ErrorAccessDenied') });
        } else {
          own.reply({ status: 503, body: graphError('ServiceUnavailable') });
        }
      },
      cleanup: () => own.stop(),
    };
  },
});

describe('GraphSender: the request', () => {
  it('POSTs to /users/{mailbox}/sendMail with a bearer token from the app-only scope', async () => {
    const creds = credential('abc-test-token');
    await sender({ credential: creds }).send(sampleMessage());

    expect(creds.getToken).toHaveBeenCalledWith(GRAPH_SCOPE);
    const [request] = server.requests;
    expect(request?.method).toBe('POST');
    expect(request?.url).toBe(`/v1.0/users/${encodeURIComponent(SENDER)}/sendMail`);
    expect(request?.headers['authorization']).toBe('Bearer abc-test-token');
    expect(request?.headers['content-type']).toBe('application/json');
  });

  it('sends HTML as the body, never saves to Sent Items, and sets a client-request-id', async () => {
    await sender().send(sampleMessage({ html: '<p>x</p>' }));
    const [request] = server.requests;
    const body = request?.body as { message: { body: unknown }; saveToSentItems: unknown };

    expect(body.message.body).toEqual({ contentType: 'HTML', content: '<p>x</p>' });
    expect(body.saveToSentItems).toBe(false);
    expect(String(request?.headers['client-request-id'])).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('resolves the request-id Graph returned as the result id', async () => {
    server.reply({ status: 202, headers: { 'request-id': 'graph-req-42' } });
    const result = await sender().send(sampleMessage());

    expect(result).toEqual({ id: 'graph-req-42', transport: 'graph' });
  });

  it('falls back to its own client-request-id when Graph returns none', async () => {
    server.reply({ status: 202 });
    const result = await sender().send(sampleMessage());

    expect(result.id).toBe(String(server.requests[0]?.headers['client-request-id']));
  });

  it('sends no from: the mailbox in the URL is the sender', async () => {
    await sender().send(sampleMessage({ from: SENDER }));
    expect((server.requests[0]?.body as { message: object }).message).not.toHaveProperty('from');
  });

  it('refuses a from that is another mailbox, before any network call', async () => {
    await expect(
      sender().send(sampleMessage({ from: 'noreply-rova@qnsc.vn' })),
    ).rejects.toMatchObject({ code: 'invalid_message' });
    expect(server.requests).toHaveLength(0);
  });

  it('accepts the configured mailbox case-insensitively', async () => {
    await expect(
      sender().send(sampleMessage({ from: SENDER.toUpperCase() })),
    ).resolves.toBeDefined();
  });

  it('percent-encodes the mailbox in the path', async () => {
    await sender({ sender: 'a+b@qnsc.vn' }).send(sampleMessage());
    expect(server.requests[0]?.url).toBe('/v1.0/users/a%2Bb%40qnsc.vn/sendMail');
  });

  it('builds recipients, reply-to and x- headers', () => {
    const payload = buildGraphPayload(
      validateMessage(
        sampleMessage({
          to: ['a@example.test'],
          cc: ['b@example.test'],
          bcc: ['c@example.test'],
          replyTo: 'r@example.test',
          headers: { 'x-one': '1' },
        }),
      ),
    ) as { message: Record<string, unknown> };

    expect(payload.message['toRecipients']).toEqual([
      { emailAddress: { address: 'a@example.test' } },
    ]);
    expect(payload.message['ccRecipients']).toEqual([
      { emailAddress: { address: 'b@example.test' } },
    ]);
    expect(payload.message['bccRecipients']).toEqual([
      { emailAddress: { address: 'c@example.test' } },
    ]);
    expect(payload.message['replyTo']).toEqual([{ emailAddress: { address: 'r@example.test' } }]);
    expect(payload.message['internetMessageHeaders']).toEqual([{ name: 'x-one', value: '1' }]);
  });

  it('omits cc, bcc, reply-to and headers when there are none', () => {
    const { message } = buildGraphPayload(validateMessage(sampleMessage())) as {
      message: Record<string, unknown>;
    };
    for (const key of ['ccRecipients', 'bccRecipients', 'replyTo', 'internetMessageHeaders']) {
      expect(message).not.toHaveProperty(key);
    }
  });
});

describe('GraphSender: 429 and 5xx', () => {
  it('waits the Retry-After and sends again — one email', async () => {
    server.reply({
      status: 429,
      headers: { 'retry-after': '7' },
      body: graphError('ApplicationThrottled'),
    });

    await expect(sender().send(sampleMessage())).resolves.toMatchObject({ transport: 'graph' });

    expect(sleeps).toEqual([7_000]);
    expect(server.requests).toHaveLength(2);
    expect(server.accepted).toHaveLength(1);
  });

  it('keeps one client-request-id across the attempts of one send', async () => {
    server.reply({ status: 429, headers: { 'retry-after': '0' } });
    await sender().send(sampleMessage());

    const ids = server.requests.map((r) => r.headers['client-request-id']);
    expect(ids[0]).toBe(ids[1]);
  });

  it('parses a Retry-After that is an HTTP date', async () => {
    const at = new Date(Date.now() + 5_000).toUTCString();
    server.reply({ status: 429, headers: { 'retry-after': at } });
    await sender().send(sampleMessage());

    expect(sleeps[0]).toBeGreaterThan(2_000);
    expect(sleeps[0]).toBeLessThanOrEqual(5_000);
  });

  it('does not wait out a Retry-After longer than maxRetryAfterSeconds: it throws with the value', async () => {
    server.reply({ status: 429, headers: { 'retry-after': '120' } });
    const error = (await sender({ maxRetryAfterSeconds: 30 })
      .send(sampleMessage())
      .catch((e: unknown) => e)) as MailSendError;

    expect(error).toBeInstanceOf(MailSendError);
    expect(error.code).toBe('throttled');
    expect(error.retryable).toBe(true);
    expect(error.retryAfterSeconds).toBe(120);
    expect(error.status).toBe(429);
    expect(sleeps).toEqual([]);
    expect(server.requests).toHaveLength(1);
  });

  it('backs off exponentially with jitter when there is no Retry-After', async () => {
    server.reply({ status: 503 }, { status: 503 });
    await sender({ maxAttempts: 3, random: () => 1 }).send(sampleMessage());

    expect(sleeps).toEqual([500, 1_000]);
  });

  it('applies the random jitter to the backoff', async () => {
    server.reply({ status: 503 });
    await sender({ random: () => 0.5 }).send(sampleMessage());

    expect(sleeps).toEqual([250]);
  });

  it('gives up after maxAttempts and reports unavailable, retryable', async () => {
    server.reply(
      { status: 503, body: graphError('ServiceUnavailable') },
      { status: 503 },
      { status: 503 },
    );
    const error = (await sender({ maxAttempts: 3 })
      .send(sampleMessage())
      .catch((e: unknown) => e)) as MailSendError;

    expect(error.code).toBe('unavailable');
    expect(error.retryable).toBe(true);
    expect(server.requests).toHaveLength(3);
    expect(server.accepted).toHaveLength(0);
  });

  it.each([502, 504])('retries %i in place', async (status) => {
    server.reply({ status });
    await expect(sender().send(sampleMessage())).resolves.toBeDefined();
    expect(server.accepted).toHaveLength(1);
  });

  it('does NOT retry a plain 500: Graph may have accepted the message', async () => {
    server.reply({ status: 500 });
    const error = (await sender()
      .send(sampleMessage())
      .catch((e: unknown) => e)) as MailSendError;

    expect(error.code).toBe('unavailable');
    expect(server.requests).toHaveLength(1);
  });

  it('aborts a wait for Retry-After when the caller aborts', async () => {
    server.reply({ status: 429, headers: { 'retry-after': '10' } });
    const controller = new AbortController();
    const hangingSleep = (_ms: number, signal?: AbortSignal): Promise<void> =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        setTimeout(() => controller.abort(), 5);
      });

    const error = (await sender({ sleep: hangingSleep })
      .send(sampleMessage(), { signal: controller.signal })
      .catch((e: unknown) => e)) as MailSendError;

    expect(error.code).toBe('timeout');
    expect(server.accepted).toHaveLength(0);
  });
});

describe('GraphSender: the credential and the caller’s signal (L4)', () => {
  it('hands the caller’s abort signal to getToken, so a cancelled send does not wait on the authority', async () => {
    const getToken = vi.fn(async (_scope: string, _options?: { abortSignal?: AbortSignal }) => ({
      token: 't',
    }));
    const controller = new AbortController();
    await sender({ credential: { getToken } }).send(sampleMessage(), { signal: controller.signal });

    expect(getToken).toHaveBeenCalledWith(GRAPH_SCOPE, { abortSignal: controller.signal });
  });

  it('passes no options when the caller gave no signal', async () => {
    const getToken = vi.fn(async (_scope: string, _options?: { abortSignal?: AbortSignal }) => ({
      token: 't',
    }));
    await sender({ credential: { getToken } }).send(sampleMessage());

    expect(getToken).toHaveBeenCalledWith(GRAPH_SCOPE);
  });

  it('a send aborted while the token is being fetched is a timeout, not an authentication failure', async () => {
    const controller = new AbortController();
    const slow = {
      getToken: (_scope: string, options?: { abortSignal?: AbortSignal }) =>
        new Promise<{ token: string }>((_resolve, reject) => {
          options?.abortSignal?.addEventListener(
            'abort',
            () => reject(new Error('The operation was aborted')),
            { once: true },
          );
          setTimeout(() => controller.abort(), 5);
        }),
    };
    const error = (await sender({ credential: slow })
      .send(sampleMessage(), { signal: controller.signal })
      .catch((e: unknown) => e)) as MailSendError;

    expect(error.code).toBe('timeout');
    expect(server.requests).toHaveLength(0);
  });
});

describe('GraphSender: errors', () => {
  it.each([
    [400, 'invalid_message', false],
    [401, 'unauthenticated', true],
    [403, 'forbidden', false],
    [404, 'mailbox_not_found', false],
    [413, 'too_large', false],
  ] as const)(
    'maps HTTP %i to %s (retryable: %s) without retrying',
    async (status, code, retryable) => {
      server.reply({ status, body: graphError('SomeProviderCode') });
      const error = (await sender()
        .send(sampleMessage())
        .catch((e: unknown) => e)) as MailSendError;

      expect(error.code).toBe(code);
      expect(error.retryable).toBe(retryable);
      expect(error.status).toBe(status);
      expect(server.requests).toHaveLength(1);
    },
  );

  it("names Graph's error code and request id, but never its free-text message", async () => {
    server.reply({
      status: 403,
      headers: { 'request-id': 'rid-9' },
      body: graphError(
        'ErrorAccessDenied',
        'Access to OData is disabled for mailbox noreply-rova@qnsc.vn',
      ),
    });
    const error = (await sender()
      .send(sampleMessage())
      .catch((e: unknown) => e)) as MailSendError;

    expect(error.message).toContain('ErrorAccessDenied');
    expect(error.message).toContain('rid-9');
    expect(error.requestId).toBe('rid-9');
    expect(error.message).not.toContain('noreply-rova');
  });

  it('survives an error body that is not JSON', async () => {
    server.reply({ status: 403, body: undefined });
    const error = (await sender()
      .send(sampleMessage())
      .catch((e: unknown) => e)) as MailSendError;
    expect(error.code).toBe('forbidden');
  });

  it('ignores a provider code that is not a plain identifier', async () => {
    server.reply({ status: 403, body: graphError('<script>alert(1)</script>') });
    const error = (await sender()
      .send(sampleMessage())
      .catch((e: unknown) => e)) as MailSendError;
    expect(error.message).not.toContain('<script>');
  });

  it('reports a credential failure as unauthenticated, naming the error type only', async () => {
    const failing = {
      getToken: async () => {
        const err = new Error('AADSTS7000215: Invalid client secret provided for app 1234');
        err.name = 'AuthenticationError';
        throw err;
      },
    };
    const error = (await sender({ credential: failing })
      .send(sampleMessage())
      .catch((e: unknown) => e)) as MailSendError;

    expect(error.code).toBe('unauthenticated');
    expect(error.message).toContain('AuthenticationError');
    expect(error.message).not.toContain('AADSTS');
    expect(server.requests).toHaveLength(0);
  });

  it('reports a credential that returns nothing as unauthenticated', async () => {
    const error = (await sender({ credential: { getToken: async () => null } })
      .send(sampleMessage())
      .catch((e: unknown) => e)) as MailSendError;
    expect(error.code).toBe('unauthenticated');
  });

  it('never puts the bearer token in an error', async () => {
    server.reply({ status: 401, body: graphError('InvalidAuthenticationToken') });
    const error = (await sender({ credential: credential('very-secret-token-value') })
      .send(sampleMessage())
      .catch((e: unknown) => e)) as MailSendError;
    expect(JSON.stringify({ ...error, text: error.message })).not.toContain(
      'very-secret-token-value',
    );
  });

  it('times out a hung request as timeout, retryable, and does not retry it', async () => {
    server.hang = true;
    const error = (await sender({ requestTimeoutMs: 50 })
      .send(sampleMessage())
      .catch((e: unknown) => e)) as MailSendError;

    expect(error.code).toBe('timeout');
    expect(error.retryable).toBe(true);
    expect(server.requests).toHaveLength(1);
  });

  it('reports an unreachable service as network, retryable', async () => {
    const dead = new GraphServer();
    await dead.start();
    const baseUrl = dead.baseUrl;
    await dead.stop();
    const error = (await sender({ baseUrl })
      .send(sampleMessage())
      .catch((e: unknown) => e)) as MailSendError;

    expect(error.code).toBe('network');
    expect(error.retryable).toBe(true);
  });

  it('validates before calling the credential or the network', async () => {
    const creds = credential();
    const bad: EmailMessage = sampleMessage({ to: [] });

    await expect(sender({ credential: creds }).send(bad)).rejects.toMatchObject({
      code: 'invalid_message',
    });
    expect(creds.getToken).not.toHaveBeenCalled();
    expect(server.requests).toHaveLength(0);
  });
});

describe('parseRetryAfter', () => {
  it.each([
    ['5', 5],
    [' 12 ', 12],
    ['0', 0],
    [null, undefined],
    ['soon', undefined],
  ])('reads %o as %o', (header, expected) => {
    expect(parseRetryAfter(header as string | null)).toBe(expected);
  });

  it('reads an HTTP date relative to now, never negative', () => {
    const now = Date.parse('2026-10-09T10:00:00Z');
    expect(parseRetryAfter('Fri, 09 Oct 2026 10:00:30 GMT', now)).toBe(30);
    expect(parseRetryAfter('Fri, 09 Oct 2026 09:00:00 GMT', now)).toBe(0);
  });
});
