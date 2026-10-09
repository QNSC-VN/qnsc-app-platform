/**
 * Side-effect module: importing it throws when `NODE_ENV=production`. `smtp.ts` imports it
 * FIRST — compiled CommonJS runs imports in order — so the refusal happens before
 * `nodemailer` is even required.
 */
if (process.env['NODE_ENV'] === 'production') {
  throw new Error(
    '@quynhonsemiconductor/platform-mail: the smtp transport must not be loaded when NODE_ENV=production. ' +
      'Use MAIL_TRANSPORT=graph.',
  );
}
