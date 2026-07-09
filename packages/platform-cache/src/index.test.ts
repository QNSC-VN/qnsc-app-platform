import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index';

describe('@qnsc/platform-cache', () => {
  it('exposes its package name', () => {
    expect(PACKAGE_NAME).toBe('@qnsc/platform-cache');
  });
});
