import { hash, verify } from '@node-rs/argon2';

/**
 * argon2id, OWASP baseline (identity plan §5.4): m = 19 MiB, t = 2, p = 1.
 * `@node-rs/argon2`'s `Algorithm.Argon2id` is its default; stated anyway for the reader.
 */
export const ARGON2_PARAMS = {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
  algorithm: 2,
} as const;

export const argon2Password = {
  hash: (password: string): Promise<string> => hash(password, ARGON2_PARAMS),
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
