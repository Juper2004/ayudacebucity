'use strict';
const path = require('node:path');
const { createApp } = require('./app.cjs');
const { createMailer } = require('./mailer.cjs');

async function main() {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  const origin = process.env.APP_ORIGIN || `http://localhost:${port}`;
  const secret = process.env.OTP_SECRET;
  if (!secret || secret.length < 32) throw new Error('Set OTP_SECRET to a random secret of at least 32 characters in .env. See .env.example.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
  const secureCookies = process.env.COOKIE_SECURE === 'true';
  if (process.env.NODE_ENV === 'production' && (!secureCookies || !origin.startsWith('https://'))) throw new Error('Production requires an HTTPS APP_ORIGIN and COOKIE_SECURE=true.');
  if (new URL(origin).pathname !== '/' || new URL(origin).search || new URL(origin).hash) throw new Error('APP_ORIGIN must be an origin such as http://localhost:3000, without a path.');
  const mailer = createMailer();
  const runtime = await createApp({
    databasePath: path.resolve(process.env.DATABASE_PATH || './data/ayuda.sqlite'),
    appOrigin: origin,
    secureCookies,
    otpSecret: secret,
    mailer,
    admin: process.env.ADMIN_EMAIL || process.env.ADMIN_PASSWORD ? {
      name: process.env.ADMIN_NAME,
      email: process.env.ADMIN_EMAIL,
      password: process.env.ADMIN_PASSWORD
    } : undefined
  });
  if (!mailer.configured) console.warn('Email delivery is not configured. Complete the Gmail SMTP settings in .env to enable password recovery.');
  if (!runtime.db.prepare("SELECT id FROM users WHERE json_extract(profile, '$.role') = 'DSWS_ADMIN'").get()) console.warn('No DSWS administrator exists. Set ADMIN_EMAIL and ADMIN_PASSWORD in .env, then restart.');
  const server = runtime.app.listen(port, host, () => console.log(`AYUDA CEBU is running at ${origin}`));
  server.on('error', async () => { console.error('Could not start AYUDA. Check HOST/PORT and whether another server is running.'); await runtime.close(); process.exitCode = 1; });
  let closing = false;
  function shutdown() {
    if (closing) return;
    closing = true;
    server.close(async () => { await runtime.close(); });
    server.closeIdleConnections();
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
