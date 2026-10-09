/**
 * `@quynhonsemiconductor/identity/testing` — the conformance kit and the pieces it is built from.
 *
 * Kept on a separate entry point so nothing here reaches a production bundle by accident.
 */
export { runIdentityConformance } from './conformance';
export {
  startStack,
  type ConformanceInfra,
  type Stack,
  type StackOptions,
  APP_ORIGIN,
  API,
} from './harness';
export { TestClient, type Reply } from './client';
export { TEST_JOBS_DDL, TestJobs } from './jobs';
export { startMockIdp, type IdpIdentity, type MockIdp } from './mock-idp';
export { REFERENCE_DDL } from './reference-ddl';
export * as referenceSchema from './reference-schema';
export type { TestApi } from './support';
