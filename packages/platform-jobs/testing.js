/* eslint-disable @typescript-eslint/no-require-imports --
 * Published CommonJS shim, not source. It lets
 * `@quynhonsemiconductor/platform-jobs/testing` resolve under TypeScript's node10 algorithm, which
 * every product backend uses (module: commonjs, no explicit moduleResolution) and which ignores
 * the `exports` map in package.json.
 */
module.exports = require('./dist/testing');
