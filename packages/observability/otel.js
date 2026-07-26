/* eslint-disable @typescript-eslint/no-require-imports --
 * This file is a published CommonJS shim, not source. It exists so
 * `@qnsc-vn/observability/otel` resolves under TypeScript's node10 algorithm,
 * which every product backend uses (module: commonjs, no explicit
 * moduleResolution) and which ignores the `exports` map in package.json. A real
 * file has to sit at this path, and re-exporting dist requires `require()`.
 */
module.exports = require('./dist/otel.bootstrap.js');
