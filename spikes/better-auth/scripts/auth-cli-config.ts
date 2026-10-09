/**
 * Configuration file for `auth generate` (Better Auth CLI). It builds the same instance
 * `createIdentity` builds, with every preset, against an empty stand-in database: the generator
 * only reads the options to decide which tables and columns exist.
 */
import { CacheService } from '@quynhonsemiconductor/platform-cache';
import { createIdentity } from '../src/identity/create-identity';

export const auth = createIdentity({
  product: 'spike',
  db: {},
  schema: {},
  cache: new CacheService({ mode: 'optional' }),
  baseURL: 'http://localhost:3000',
  secret: 'x'.repeat(32),
  trustedOrigins: ['http://localhost:3000'],
  presets: ['public', 'staff', 'organizations'],
  email: { sendVerification: async () => undefined, sendPasswordReset: async () => undefined },
  microsoft: { clientId: 'x', clientSecret: 'x', tenantId: 'x' },
});
