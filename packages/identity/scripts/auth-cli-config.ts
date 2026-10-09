/**
 * Configuration file for `auth generate` (Better Auth CLI). It builds the instance the package builds,
 * with every preset, against an empty stand-in database: the generator only reads the options to
 * decide which tables and columns exist. A product does the same with its own `createIdentity` call.
 */
import { randomBytes } from 'node:crypto';
import { CacheService } from '@quynhonsemiconductor/platform-cache';
import { createIdentity } from '../src/create-identity';

export const auth = createIdentity({
  product: 'identity',
  db: {},
  schema: {},
  cache: new CacheService({ mode: 'optional' }),
  baseURL: 'https://auth.example.test',
  trustedOrigins: ['https://auth.example.test'],
  presets: ['public', 'staff', 'organizations'],
  mail: {
    jobs: { send: async () => null },
    templates: {
      verifyEmail: () => ({ subject: '', html: '', text: '' }),
      resetPassword: () => ({ subject: '', html: '', text: '' }),
    },
  },
  staff: { tenantId: 'x', clientId: 'x', clientSecret: 'x', domains: ['staff.example.test'] },
  env: {
    BETTER_AUTH_SECRET: randomBytes(32).toString('hex'),
    IDENTITY_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  },
});
