/**
 * `@quynhonsemiconductor/platform-mail` — email transport for QNSC product backends.
 *
 * Framework-agnostic core. NestJS lives at `/nest`; the in-memory sender, the in-memory
 * `platform-jobs` stand-in and the conformance suites live at `/testing`.
 *
 * Not exported here on purpose: the `smtp` transport. It refuses to load when
 * `NODE_ENV=production`, so the factory loads it lazily and only for `MAIL_TRANSPORT=smtp`.
 */
export * from './errors';
export * from './message';
export {
  readMailConfig,
  type MailConfig,
  type MailEnv,
  type GraphConfig,
  type SmtpConfig,
} from './config';
export { createEmailSender, type CreateEmailSenderOptions } from './factory';
export {
  createGraphSender,
  buildGraphPayload,
  parseRetryAfter,
  GRAPH_BASE_URL,
  GRAPH_SCOPE,
  type GraphSenderOptions,
  type TokenProvider,
} from './graph';
export {
  createValkeyMailState,
  cooldownKey,
  ledgerKey,
  MAIL_RATE,
  rateKey,
  type ClaimResult,
  type MailState,
  type ValkeyLike,
} from './state';
export {
  MAIL_CLAIM_LEASE_SECONDS,
  MAIL_CLAIM_RENEW_SECONDS,
  MAIL_DEFAULT_COOLDOWN_SECONDS,
  MAIL_HANDLE_OPTIONS,
  MAIL_MAX_COOLDOWN_SECONDS,
  MAIL_MAX_SLOT_WAIT_MS,
  MAIL_PRIORITY,
  MAIL_QUEUE,
  MAIL_QUEUE_CONFIG,
  MAIL_SENT_TTL_SECONDS,
  createMailHandler,
  createMailQueue,
  minRetryWindowSeconds,
  mailCanRedrive,
  priorityFor,
  registerMailJobs,
  type MailHandlerOptions,
  type MailLogger,
  type MailQueue,
  type MailTelemetry,
} from './jobs';
