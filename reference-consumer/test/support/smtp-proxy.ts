import net from 'node:net';

/**
 * A TCP proxy in front of the SMTP sink, so a test can make a send SLOW and know when one is in flight.
 *
 * - `chunkDelayMs`: every chunk, in both directions, is held this long. One SMTP session is a handful of
 *   round trips, so a session lasts several multiples of it.
 * - `ackDelayMs`: after the client has sent the end of the message (`<CRLF>.<CRLF>`) the server's reply
 *   is held this long. The sink has ALREADY stored the message by then, so a client that gives up during
 *   this window has delivered a message and not been told: the case no queue can make exactly-once.
 */
export class SmtpProxy {
  chunkDelayMs = 0;
  ackDelayMs = 0;
  /** Sessions currently open. */
  active = 0;
  /** Sessions ever opened. */
  opened = 0;
  private readonly server: net.Server;
  private readonly sockets = new Set<net.Socket>();

  constructor(private readonly target: { host: string; port: number }) {
    this.server = net.createServer((client) => this.handle(client));
  }

  async listen(): Promise<number> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    return (this.server.address() as net.AddressInfo).port;
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private handle(client: net.Socket): void {
    const upstream = net.connect(this.target.port, this.target.host);
    this.sockets.add(client).add(upstream);
    this.active += 1;
    this.opened += 1;
    let inData = false;
    let tail = '';
    let holdServer = false;

    const later = (ms: number, fn: () => void) => (ms > 0 ? setTimeout(fn, ms) : fn());

    client.on('data', (chunk) => {
      tail = (tail + chunk.toString('latin1')).slice(-8);
      if (inData && tail.includes('\r\n.\r\n')) holdServer = true;
      if (!inData && /\bDATA\r\n/i.test(tail)) inData = true;
      later(this.chunkDelayMs, () => upstream.writable && upstream.write(chunk));
    });
    upstream.on('data', (chunk) => {
      const ms = this.chunkDelayMs + (holdServer ? this.ackDelayMs : 0);
      holdServer = false;
      later(ms, () => client.writable && client.write(chunk));
    });

    const done = () => {
      if (!this.sockets.delete(client)) return;
      this.sockets.delete(upstream);
      this.active -= 1;
      client.destroy();
      upstream.destroy();
    };
    client.on('close', done);
    client.on('error', done);
    upstream.on('close', done);
    upstream.on('error', done);
  }
}
