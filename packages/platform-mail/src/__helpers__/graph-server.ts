import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** A scripted reply. */
export interface ScriptedReply {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: unknown;
  /** What the server answered; `undefined` while hung. */
  status?: number;
}

/**
 * A local stand-in for `graph.microsoft.com`: real HTTP over a real socket (so `fetch`,
 * timeouts and aborts behave as in production), answering `202` unless a reply was scripted.
 * It records every request, so a test can assert what was put on the wire — the payload, the
 * path (which mailbox), the `Authorization` header.
 */
export class GraphServer {
  readonly requests: RecordedRequest[] = [];
  private readonly script: ScriptedReply[] = [];
  private server: Server | undefined;
  /** Reply handler override, for tests that need a hung connection. */
  hang = false;

  baseUrl = '';

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const record: RecordedRequest = {
          method: req.method ?? '',
          url: req.url ?? '',
          headers: req.headers,
          body: raw === '' ? undefined : JSON.parse(raw),
        };
        this.requests.push(record);
        if (this.hang) return; // never answer
        const reply = this.script.shift() ?? {
          status: 202,
          headers: { 'request-id': `req-${this.requests.length}` },
        };
        record.status = reply.status;
        res.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers });
        res.end(reply.body === undefined ? '' : JSON.stringify(reply.body));
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/v1.0`;
  }

  /** The next requests get these replies, in order. */
  reply(...replies: ScriptedReply[]): void {
    this.script.push(...replies);
  }

  /** Messages Graph accepted: `sendMail` requests it answered with 202. */
  get accepted(): RecordedRequest[] {
    return this.requests.filter((request) => request.status === 202);
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }
}

/** A graph error body: `{ error: { code, message } }`. */
export function graphError(code: string, message = 'details that must never be logged'): unknown {
  return { error: { code, message } };
}
