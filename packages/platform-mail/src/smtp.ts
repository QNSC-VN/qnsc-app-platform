/**
 * The `smtp` transport — non-production only (Mailpit locally, a CI service container).
 *
 * This module REFUSES TO LOAD when `NODE_ENV=production` (see `smtp-guard.ts`): a production
 * image that somehow selects it fails at `require` time with a clear message rather than
 * sending through an unauthenticated relay. It is not re-exported from the package root for
 * the same reason; the factory loads it lazily.
 */
import './smtp-guard';
import nodemailer from 'nodemailer';
import { MailSendError } from './errors';
import {
  assertFromIsMailbox,
  validateMessage,
  type EmailMessage,
  type EmailSender,
  type SendOptions,
  type SendResult,
} from './message';

/**
 * What this transport asks of a nodemailer transport. Declared here, structurally, so that no
 * nodemailer type appears in the published declarations: `nodemailer` is an optional peer, and
 * a consumer that does not install it (everyone on the `graph` transport) must still compile.
 */
export interface SmtpMailOptions {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
  headers: Record<string, string>;
}

export interface SmtpTransportLike {
  sendMail(options: SmtpMailOptions): Promise<{ messageId: string }>;
}

export interface SmtpSenderOptions {
  host: string;
  port: number;
  /** Envelope and header sender. */
  from: string;
  /** Test seam: a pre-built nodemailer transport. */
  transport?: SmtpTransportLike | undefined;
}

class SmtpSender implements EmailSender {
  readonly mailbox: string;
  private readonly transport: SmtpTransportLike;

  constructor(private readonly options: SmtpSenderOptions) {
    this.mailbox = options.from;
    // Plain SMTP, no auth, no STARTTLS: Mailpit's defaults. That is the reason this transport
    // cannot be used in production, and why it is not configurable towards it.
    this.transport =
      options.transport ??
      nodemailer.createTransport({
        host: options.host,
        port: options.port,
        secure: false,
        ignoreTLS: true,
        connectionTimeout: 5_000,
        greetingTimeout: 5_000,
        socketTimeout: 15_000,
      });
  }

  async send(message: EmailMessage, sendOptions: SendOptions = {}): Promise<SendResult> {
    const validated = validateMessage(message);
    assertFromIsMailbox(validated, this.mailbox);
    if (sendOptions.signal?.aborted) {
      throw new MailSendError('timeout', 'Send aborted by the caller.');
    }
    try {
      const info = await this.transport.sendMail({
        from: this.options.from,
        to: [...validated.to],
        cc: [...validated.cc],
        bcc: [...validated.bcc],
        ...(validated.replyTo === undefined ? {} : { replyTo: validated.replyTo }),
        subject: validated.subject,
        html: validated.html,
        text: validated.text,
        headers: { ...validated.headers },
      });
      return { id: String(info.messageId), transport: 'smtp' };
    } catch (err) {
      const name = err instanceof Error ? err.name : 'Error';
      const responseCode = (err as { responseCode?: number }).responseCode;
      // 4xx replies are transient by SMTP's own definition; 5xx are permanent.
      if (typeof responseCode === 'number' && responseCode >= 500) {
        throw new MailSendError(
          'invalid_message',
          `SMTP server rejected the message (${responseCode}).`,
          {
            status: responseCode,
          },
        );
      }
      throw new MailSendError('network', `SMTP send failed (${name}).`);
    }
  }
}

export function createSmtpSender(options: SmtpSenderOptions): EmailSender {
  return new SmtpSender(options);
}
