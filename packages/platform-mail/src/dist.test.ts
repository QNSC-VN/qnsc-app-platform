import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The compiled package, loaded the way a product loads it: CommonJS, in a fresh process, with a
 * real `NODE_ENV`. A TypeScript test runner can import the source, but it cannot prove that the
 * lazy `require('./smtp')` resolves in the build or that the production refusal fires at load
 * time, so these run against `dist/` (the CI test job builds first).
 *
 * Without a build they skip locally; on CI a missing build fails, so they cannot silently not run.
 */
const dist = join(import.meta.dirname, '..', 'dist');
const built = existsSync(join(dist, 'index.js'));

function run(
  script: string,
  env: Record<string, string>,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: join(import.meta.dirname, '..'),
    env: { PATH: process.env['PATH'] ?? '', ...env },
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('compiled package', () => {
  it.runIf(Boolean(process.env['CI']))('is built when running on CI', () => {
    expect(built).toBe(true);
  });

  describe.skipIf(!built)('in a fresh process', () => {
    it('refuses to load the smtp transport when NODE_ENV=production', () => {
      const result = run("require('./dist/smtp')", { NODE_ENV: 'production' });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/smtp transport must not be loaded when NODE_ENV=production/);
    });

    it('refuses MAIL_TRANSPORT=smtp from the factory in production, before loading nodemailer', () => {
      const result = run("require('./dist').createEmailSender()", {
        NODE_ENV: 'production',
        MAIL_TRANSPORT: 'smtp',
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/MAIL_TRANSPORT=smtp is refused when NODE_ENV=production/);
    });

    it('loads the package root in production without touching the smtp module', () => {
      const result = run(
        "const m = require('./dist'); console.log(typeof m.createEmailSender, 'createSmtpSender' in m)",
        { NODE_ENV: 'production' },
      );

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('function false');
    });

    it('builds the smtp sender through the factory outside production (the lazy require resolves)', () => {
      const result = run("console.log(require('./dist').createEmailSender().mailbox)", {
        NODE_ENV: 'development',
        MAIL_TRANSPORT: 'smtp',
      });

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('noreply@localhost.test');
    });

    it('builds the graph sender from the environment with a client secret outside production', () => {
      const result = run("console.log(require('./dist').createEmailSender().mailbox)", {
        NODE_ENV: 'development',
        MAIL_TRANSPORT: 'graph',
        MAIL_GRAPH_SENDER: 'noreply-academy@qnsc.vn',
        AZURE_TENANT_ID: '11111111-1111-1111-1111-111111111111',
        AZURE_CLIENT_ID: '22222222-2222-2222-2222-222222222222',
        AZURE_CLIENT_SECRET: 'generated-for-this-test',
      });

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('noreply-academy@qnsc.vn');
    });

    it('builds the graph sender from a federated token file (workload identity)', () => {
      const result = run("console.log(require('./dist').createEmailSender().mailbox)", {
        NODE_ENV: 'production',
        MAIL_TRANSPORT: 'graph',
        MAIL_GRAPH_SENDER: 'noreply-academy@qnsc.vn',
        AZURE_TENANT_ID: '11111111-1111-1111-1111-111111111111',
        AZURE_CLIENT_ID: '22222222-2222-2222-2222-222222222222',
        AZURE_FEDERATED_TOKEN_FILE: '/var/run/secrets/azure/tokens/azure-identity-token',
      });

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('noreply-academy@qnsc.vn');
    });

    it('exposes /nest and /testing through the legacy-resolution shims', () => {
      const result = run(
        "console.log(typeof require('./nest').MailModule, typeof require('./testing').MemoryEmailSender)",
        { NODE_ENV: 'test' },
      );

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('function function');
    });
  });
});
