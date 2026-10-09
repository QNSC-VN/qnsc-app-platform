import { hash, verify } from '@node-rs/argon2';

import { DEFAULTS } from './defaults';

/** `@node-rs/argon2` `Algorithm.Argon2id` is 2; the enum is a `const enum` and cannot be imported under isolatedModules. */
const ARGON2ID = 2;

export const argon2Password = {
  hash: (password: string): Promise<string> =>
    hash(password, { ...DEFAULTS.password.argon2, algorithm: ARGON2ID }),
  /**
   * PHC strings carry their own parameters, so this verifies a hash minted with ANY argon2
   * parameters (solodesk's `argon2` defaults m=65536,t=3,p=4 included). A malformed or non-argon2
   * hash (for example Better Auth's own `salt:key` scrypt format) is "no match", never a throw.
   */
  verify: async ({
    hash: stored,
    password,
  }: {
    hash: string;
    password: string;
  }): Promise<boolean> => {
    try {
      return await verify(stored, password);
    } catch {
      return false;
    }
  },
};
