// Legacy-resolution entry point for `@qnsc-vn/observability/otel`.
//
// The `exports` map in package.json handles modern resolvers, but TypeScript's
// node10 resolution (module: commonjs with no explicit moduleResolution — what the
// product backends use today) ignores `exports` entirely and looks for a real file
// at this path. Without these two stubs the subpath import fails with TS2307 in
// every consumer, so they are published deliberately.
module.exports = require('./dist/otel.bootstrap.js');
