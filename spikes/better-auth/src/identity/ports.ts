import type { User } from 'better-auth';

/**
 * The mail port of identity v8 (identity plan §5.2 `ports.ts`). `platform-mail` satisfies the
 * transport; this port is the two events Better Auth raises. Content (templates) is the product's.
 */
export interface AuthEmailPort {
  sendVerification(input: { user: User; url: string; token: string }): Promise<void>;
  sendPasswordReset(input: { user: User; url: string; token: string }): Promise<void>;
}
