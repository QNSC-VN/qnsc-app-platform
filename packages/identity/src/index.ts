/**
 * `@quynhonsemiconductor/identity` v8
 *
 * One authentication system for every QNSC product, on Better Auth. This entry point is
 * framework-agnostic; NestJS lives at `/nest`, test helpers and the conformance kit at `/testing`.
 * Mechanism in the package, policy in the product: roles, permissions, UI, email text, cookie names
 * and the auth tables stay with the product (docs/ADMISSION-TEST.md).
 */
export {
  AUTH_BASE_PATH,
  createIdentity,
  purgeUnverifiedAccounts,
  revokeAllSessions,
  type Identity,
  type IdentityOptions,
} from './create-identity';
export { DEFAULTS, type Preset } from './defaults';
export {
  AUTH_MAIL_PRIORITY,
  MAIL_QUEUE,
  type AuthEmailTemplates,
  type EmailMessage,
  type EmailSender,
  type JobEnqueue,
  type JobRegistry,
  type JobSendOptions,
  type RenderedEmail,
} from './ports';
export { mailIdempotencyKey } from './mail-port';
export { registerIdentityJobs } from './jobs';
export { isEntraGuest, type GoogleOptions, type StaffOptions } from './providers';
export type { SsoHooks } from './sso';
export {
  noopSink,
  type IdentityLogger,
  type SecurityEvent,
  type SecurityEventName,
  type SecurityEventSink,
} from './events';
export { EncryptionKeyError, sealSsoClientSecret } from './sso-crypto';
export { SsrfError } from './ssrf';
export { TestLoginRefusedError } from './test-login';
export { currentAuthTransaction } from './tx-context';
