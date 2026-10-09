export { IdentityModule, type IdentityModuleAsyncOptions } from './identity.module';
export {
  AUTH,
  CurrentSession,
  CurrentUser,
  Public,
  SessionGuard,
  type RequestWithSession,
} from './session.guard';
export { AuthApiErrorFilter, toDomainException } from './errors';
export { registerAuthHandler } from './fastify-mount';
export { checkIdentityReady } from './readiness';
export { identityLoggerFrom, observabilitySecurityEvents } from './observability';
