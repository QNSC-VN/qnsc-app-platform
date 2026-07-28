/**
 * `@qnsc-vn/identity/testing` — typed in-memory ports plus the conformance suites
 * a product runs against its own adapters.
 *
 * Kept on a separate entrypoint so nothing here reaches production bundles by
 * accident, and so the main entrypoint stays free of test helpers.
 */
export * from './in-memory-ports';
export * from './port-conformance';
