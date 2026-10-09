import { describe, expect, it } from 'vitest';
import { isEntraGuest } from './providers';

describe('isEntraGuest', () => {
  it('treats acct=1, a foreign idp claim and #EXT# as guest', () => {
    expect(isEntraGuest({ acct: 1 })).toBe(true);
    expect(
      isEntraGuest({
        idp: 'https://sts.windows.net/other/',
        iss: 'https://login.microsoftonline.com/t/v2.0',
      }),
    ).toBe(true);
    expect(isEntraGuest({ upn: 'vendor_x.com#EXT#@qnsc.onmicrosoft.com' })).toBe(true);
  });
  it('treats a plain member as not a guest', () => {
    expect(isEntraGuest({ acct: 0, iss: 'a', idp: 'a', upn: 'a@qnsc.vn' })).toBe(false);
    expect(isEntraGuest({})).toBe(false);
  });
});
