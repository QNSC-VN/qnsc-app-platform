import { createHash } from 'node:crypto';
import { DEFAULTS } from './defaults';
import type { MailPurpose } from './mail-port';

export interface CounterStorage {
  increment(key: string, ttlSeconds: number): number | Promise<number>;
}

/**
 * Per-EMAIL cap on reset requests and verification re-sends (identity plan D14), against email
 * bombing of a victim. Over the cap the mail is dropped SILENTLY: the endpoint still answers as
 * usual, so the cap cannot be used to learn whether an address has an account.
 * The counter fails open (a degraded cache returns 0), like every other limiter here.
 */
export function perEmailLimiter(storage: CounterStorage) {
  const { max, windowSeconds } = DEFAULTS.mailPerEmail;
  return async (purpose: MailPurpose, email: string): Promise<boolean> => {
    const key = `mail-limit:${purpose}:${createHash('sha256').update(email.trim().toLowerCase()).digest('hex')}`;
    return (await storage.increment(key, windowSeconds)) <= max;
  };
}
