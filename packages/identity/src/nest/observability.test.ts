import { describe, expect, it } from 'vitest';
import { identityLoggerFrom, observabilitySecurityEvents } from './observability';

describe('observability wiring', () => {
  it('writes one structured line per event and never an email address or token', () => {
    const lines: Array<{ object: Record<string, unknown>; message: string }> = [];
    const sink = observabilitySecurityEvents({
      info: (object, message) => void lines.push({ object, message }),
    });
    sink.emit({
      name: 'account.locked',
      userId: 'u1',
      ip: '203.0.113.9',
      detail: { method: 'social' },
    });
    expect(lines).toEqual([
      {
        object: { event: 'account.locked', userId: 'u1', ip: '203.0.113.9', method: 'social' },
        message: 'security event: account.locked',
      },
    ]);
  });

  it('adapts a pino-style logger to the two methods Better Auth output needs', () => {
    const seen: string[] = [];
    const logger = identityLoggerFrom({
      warn: (o, m) => void seen.push(`warn:${String(o['source'])}:${m}`),
      error: (o, m) => void seen.push(`error:${String(o['source'])}:${m}`),
    });
    logger.warn('Invalid password');
    logger.error('boom');
    expect(seen).toEqual(['warn:better-auth:Invalid password', 'error:better-auth:boom']);
  });
});
