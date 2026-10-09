import { describe, expect, it } from 'vitest';
import { domainIn, emailDomain, emailInDomains, parseDomains } from './domains';

describe('domains', () => {
  it('matches exactly and by sub-domain, never by look-alike suffix', () => {
    expect(domainIn('uni.test', 'uni.test')).toBe(true);
    expect(domainIn('cs.uni.test', 'uni.test')).toBe(true);
    expect(domainIn('miuni.test', 'uni.test')).toBe(false);
    expect(domainIn('uni.test.evil.example', 'uni.test')).toBe(false);
    expect(domainIn('', 'uni.test')).toBe(false);
  });
  it('accepts comma-separated lists and ignores case and spaces', () => {
    expect(parseDomains(' A.test, b.test ,')).toEqual(['a.test', 'b.test']);
    expect(emailInDomains('X@B.TEST', 'a.test,b.test')).toBe(true);
    expect(emailDomain('no-at-sign')).toBe('');
  });
});
