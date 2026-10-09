/**
 * Injection tokens, as `Symbol.for(...)` and not `Symbol(...)`.
 *
 * `platform-runtime` finds the pool by token without importing this package (it is an
 * OPTIONAL peer there), and a pnpm tree can easily hold two copies of this one. A
 * registry symbol is the same token in both, where a module-local one would make
 * `@Optional()` quietly resolve to nothing and a readiness check vanish.
 */
export const DATABASE_POOL_TOKEN = Symbol.for('@quynhonsemiconductor/platform-db:pool');
export const DATABASE_READ_POOL_TOKEN = Symbol.for('@quynhonsemiconductor/platform-db:read-pool');
export const DATABASE_TOKEN = Symbol.for('@quynhonsemiconductor/platform-db:database');
