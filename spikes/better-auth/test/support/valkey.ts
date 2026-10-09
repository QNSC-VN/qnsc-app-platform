import Redis from 'ioredis';
import { inject } from 'vitest';

/** A raw, UN-prefixed client: sees the keys exactly as Valkey stores them. */
export function rawValkey(): Redis {
  return new Redis(inject('valkeyUrl'));
}

export async function keysWithPrefix(redis: Redis, prefix: string): Promise<string[]> {
  const out: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 500);
    out.push(...batch);
    cursor = next;
  } while (cursor !== '0');
  return out;
}
