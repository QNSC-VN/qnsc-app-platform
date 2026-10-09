import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { simpleParser, type ParsedMail } from 'mailparser';

export interface ReceivedMail {
  mailFrom: string;
  rcptTo: string[];
  raw: string;
  parsed: ParsedMail;
}

/**
 * A tiny SMTP server for tests — a stand-in for Mailpit with the same plain, unauthenticated
 * behaviour. It speaks just enough (EHLO, MAIL, RCPT, DATA, QUIT) for nodemailer, keeps what it
 * receives, and can be told to refuse the next message with a 4xx or 5xx reply.
 */
export class FakeSmtpServer {
  readonly received: ReceivedMail[] = [];
  private server: Server | undefined;
  private readonly sockets = new Set<Socket>();
  private nextReply: string | undefined;
  port = 0;

  /** The next DATA is answered with this line (e.g. `451 try again` or `550 no`). */
  rejectNext(reply: string): void {
    this.nextReply = reply;
  }

  async start(): Promise<void> {
    this.server = createServer((socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
      this.session(socket);
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  private session(socket: Socket): void {
    let mailFrom = '';
    let rcptTo: string[] = [];
    let inData = false;
    let data = '';
    let buffer = '';
    socket.write('220 fake-smtp ready\r\n');

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) return;
          data += buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          const reply = this.nextReply;
          this.nextReply = undefined;
          if (reply) {
            socket.write(`${reply}\r\n`);
            continue;
          }
          const raw = data.replace(/\r\n\.\./g, '\r\n.');
          const snapshot = { mailFrom, rcptTo: [...rcptTo], raw };
          void simpleParser(raw).then((parsed) => {
            this.received.push({ ...snapshot, parsed });
            socket.write('250 2.0.0 queued\r\n');
          });
          data = '';
          continue;
        }
        const lineEnd = buffer.indexOf('\r\n');
        if (lineEnd === -1) return;
        const line = buffer.slice(0, lineEnd);
        buffer = buffer.slice(lineEnd + 2);
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO' || verb === 'HELO') socket.write('250 fake-smtp\r\n');
        else if (verb === 'MAIL') {
          mailFrom = /<([^>]*)>/.exec(line)?.[1] ?? '';
          rcptTo = [];
          socket.write('250 ok\r\n');
        } else if (verb === 'RCPT') {
          rcptTo.push(/<([^>]*)>/.exec(line)?.[1] ?? '');
          socket.write('250 ok\r\n');
        } else if (verb === 'DATA') {
          inData = true;
          data = '';
          socket.write('354 go ahead\r\n');
        } else if (verb === 'QUIT') {
          socket.write('221 bye\r\n');
          socket.end();
        } else if (verb === 'RSET' || verb === 'NOOP') socket.write('250 ok\r\n');
        else socket.write('502 not implemented\r\n');
      }
    });
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }
}
