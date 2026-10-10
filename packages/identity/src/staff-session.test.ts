import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { staffClassifier } from './staff-session';

/**
 * The per-process memo of "is this user staff?" (30 s, bounded). Its correctness is what lets a
 * public user's session cost one `account` lookup per 30 s instead of one per request, so the three
 * things that could silently break it are pinned here: it expires, it is per user, and the free
 * staff-domain test never consults it.
 */
const policy = { staffDomains: ['staff.example.test'], getContext: async () => ({}) as never };

const adapterWith = (microsoft: ReadonlySet<string>) => {
  const lookups: string[] = [];
  return {
    lookups,
    findAccounts: async (userId: string) => {
      lookups.push(userId);
      return microsoft.has(userId) ? [{ providerId: 'microsoft' }] : [{ providerId: 'credential' }];
    },
  };
};

describe('staffClassifier memo', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-10T12:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('remembers an answer for 30 s and asks again after that', async () => {
    const adapter = adapterWith(new Set());
    const { classify } = staffClassifier(policy);
    const user = { id: 'u1', email: 'a@users.example.test' };
    expect(await classify(adapter, user)).toBe(false);
    await vi.advanceTimersByTimeAsync(29_900);
    expect(await classify(adapter, user)).toBe(false);
    expect(adapter.lookups).toEqual(['u1']); // still the first answer
    await vi.advanceTimersByTimeAsync(200); // 30.1 s
    expect(await classify(adapter, user)).toBe(false);
    expect(adapter.lookups).toEqual(['u1', 'u1']); // asked again
  });

  it('a changed answer is picked up once the memo has expired, not before', async () => {
    const microsoft = new Set<string>();
    const adapter = adapterWith(microsoft);
    const { classify } = staffClassifier(policy);
    const user = { id: 'u1', email: 'a@users.example.test' };
    expect(await classify(adapter, user)).toBe(false);
    microsoft.add('u1'); // becomes staff
    expect(await classify(adapter, user)).toBe(false); // within the 30 s: the remembered answer
    await vi.advanceTimersByTimeAsync(30_001);
    expect(await classify(adapter, user)).toBe(true);
  });

  it('is per user: one user’s answer is never given for another', async () => {
    const adapter = adapterWith(new Set(['staff-user']));
    const { classify } = staffClassifier(policy);
    const staff = { id: 'staff-user', email: 'ms@users.example.test' };
    const visitor = { id: 'visitor', email: 'v@users.example.test' };
    expect(await classify(adapter, staff)).toBe(true);
    expect(await classify(adapter, visitor)).toBe(false); // not the staff user's `true`
    expect(await classify(adapter, staff)).toBe(true); // nor the visitor's `false`
    expect(await classify(adapter, visitor)).toBe(false);
    expect(adapter.lookups).toEqual(['staff-user', 'visitor']); // one lookup each, then memo
  });

  it('a staff-domain email is staff without a lookup, whatever is remembered for that id', async () => {
    const adapter = adapterWith(new Set());
    const { classify, remember } = staffClassifier(policy);
    remember('u1', false);
    expect(await classify(adapter, { id: 'u1', email: 'x@staff.example.test' })).toBe(true);
    expect(await classify(adapter, { id: 'u1', email: 'x@STAFF.example.test' })).toBe(true);
    expect(adapter.lookups).toEqual([]);
  });

  it('remember(id, true) takes effect at once (a user who has just become staff)', async () => {
    const adapter = adapterWith(new Set());
    const { classify, remember } = staffClassifier(policy);
    const user = { id: 'u1', email: 'a@users.example.test' };
    expect(await classify(adapter, user)).toBe(false);
    remember('u1', true);
    expect(await classify(adapter, user)).toBe(true);
    expect(adapter.lookups).toEqual(['u1']);
  });

  it('is bounded: past 10 000 users the oldest answer is forgotten', async () => {
    const adapter = adapterWith(new Set());
    const { classify } = staffClassifier(policy);
    for (let i = 0; i <= 10_000; i += 1) {
      await classify(adapter, { id: `u${i}`, email: `${i}@users.example.test` });
    }
    expect(adapter.lookups).toHaveLength(10_001);
    await classify(adapter, { id: 'u1', email: '1@users.example.test' }); // still remembered
    expect(adapter.lookups).toHaveLength(10_001);
    await classify(adapter, { id: 'u0', email: '0@users.example.test' }); // evicted: asked again
    expect(adapter.lookups).toHaveLength(10_002);
  });

  it('a user without an id is not staff by account and never reaches the lookup', async () => {
    const adapter = adapterWith(new Set());
    const { classify } = staffClassifier(policy);
    expect(await classify(adapter, { email: 'a@users.example.test' })).toBe(false);
    expect(adapter.lookups).toEqual([]);
  });
});
