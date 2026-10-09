// Values `global-setup.ts` provides to every test file through `inject()`.
export {};

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUri: string;
    pgHost: string;
    pgPort: number;
    pgUser: string;
    pgPassword: string;
    valkeyUrl: string;
    valkeyHost: string;
    valkeyPort: number;
  }
}
