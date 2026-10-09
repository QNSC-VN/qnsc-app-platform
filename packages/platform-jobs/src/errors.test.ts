import { describe, expect, it } from 'vitest';
import { isPermanent, PermanentJobError } from './errors';

describe('PermanentJobError', () => {
  it('is an Error with a name, a message and a cause', () => {
    const cause = new Error('root');
    const error = new PermanentJobError('user gone', { cause });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('PermanentJobError');
    expect(error.message).toBe('user gone');
    expect(error.cause).toBe(cause);
  });

  it('is recognised, including a subclass', () => {
    class NoSuchUser extends PermanentJobError {}
    expect(isPermanent(new PermanentJobError('x'))).toBe(true);
    expect(isPermanent(new NoSuchUser('x'))).toBe(true);
  });

  it('is recognised by marker, so a second copy of this package in the tree agrees', () => {
    const fromAnotherCopy = Object.assign(new Error('x'), {
      [Symbol.for('@quynhonsemiconductor/platform-jobs:permanent')]: true,
    });
    expect(isPermanent(fromAnotherCopy)).toBe(true);
  });

  it.each([
    new Error('plain'),
    new TypeError('type'),
    'text',
    null,
    undefined,
    { permanent: true },
  ])('does not treat %j as permanent', (value) => {
    expect(isPermanent(value)).toBe(false);
  });
});
