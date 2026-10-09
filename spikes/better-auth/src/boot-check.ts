/**
 * Run as plain CommonJS (`node dist/boot-check.js`): proves a CJS package can load the ESM-only
 * Better Auth family through `require()` on Node 24 (require(esm)), which is what every
 * app-platform package is today (`module: commonjs`).
 */
import { CacheService } from '@quynhonsemiconductor/platform-cache';
import { createIdentity } from './identity/create-identity';

const auth = createIdentity({
  product: 'spike',
  db: {},
  schema: {},
  cache: new CacheService({ mode: 'optional' }),
  baseURL: 'http://127.0.0.1',
  secret: 'x'.repeat(32),
  trustedOrigins: ['http://127.0.0.1'],
  presets: ['public', 'staff', 'organizations'],
  email: { sendVerification: async () => undefined, sendPasswordReset: async () => undefined },
  microsoft: { clientId: 'x', clientSecret: 'x', tenantId: 'x' },
});
console.log(
  JSON.stringify({
    module: typeof module !== 'undefined' && typeof require === 'function' ? 'commonjs' : 'esm',
    node: process.version,
    plugins: auth.options.plugins?.map((p) => p.id),
    hasHandler: typeof auth.handler === 'function',
  }),
);
