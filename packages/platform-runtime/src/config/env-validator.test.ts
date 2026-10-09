import { describe, expect, it } from 'vitest';
import { createEnvValidator, type EnvSchemaLike } from './env-validator';

function schema<T>(
  result:
    | { success: true; data: T }
    | { success: false; issues: Array<{ path: string[]; message: string }> },
): EnvSchemaLike<T> {
  return {
    safeParse: () =>
      result.success
        ? { success: true, data: result.data }
        : { success: false, error: { issues: result.issues } },
  };
}

describe('createEnvValidator', () => {
  /**
   * The value of this function is entirely in the failure path. A validator that
   * stops at the first bad key costs a deploy cycle per missing variable, which is
   * exactly the situation someone is in when they are reading this error at all.
   */
  it('reports every offending key, not just the first', () => {
    const validate = createEnvValidator(
      schema({
        success: false,
        issues: [
          { path: ['DATABASE_URL'], message: 'Required' },
          { path: ['REDIS_URL'], message: 'Required' },
          { path: ['JWT_PUBLIC_KEY'], message: 'Required' },
        ],
      }),
    );

    expect(() => validate({})).toThrowError(/DATABASE_URL/);
    expect(() => validate({})).toThrowError(/REDIS_URL/);
    expect(() => validate({})).toThrowError(/JWT_PUBLIC_KEY/);
  });

  it('renders a nested path as a dotted key', () => {
    const validate = createEnvValidator(
      schema({ success: false, issues: [{ path: ['DB', 'PORT'], message: 'Expected number' }] }),
    );
    expect(() => validate({})).toThrowError(/DB\.PORT: Expected number/);
  });

  /**
   * The parsed value, never the input. A schema that coerces — `z.coerce.number()`
   * on a port, a defaulted flag — is doing work that has to reach `ConfigService`.
   * Returning the raw input would report success while silently discarding it, and
   * every consumer would then read a string where the type says number.
   */
  it('returns the parsed value so coercions and defaults survive', () => {
    const validate = createEnvValidator(schema({ success: true, data: { PORT: 3000 } }));
    expect(validate({ PORT: '3000' })).toEqual({ PORT: 3000 });
  });
});
