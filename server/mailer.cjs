'use strict';
const nodemailer = require('nodemailer');

function createMailer(env = process.env) {
  const provider = env.MAIL_PROVIDER || 'smtp';
  const from = env.MAIL_FROM || env.SMTP_USER;
  const message = code => ({
    subject: 'Your AYUDA CEBU password reset code',
    text: `Your AYUDA CEBU verification code is ${code}.\n\nThis code expires in 10 minutes and can be used once to reset your password.\nIf you did not request this, you can ignore this email.`,
    html: `<div style="font-family:Arial,sans-serif;color:#14223f"><h2>Reset your AYUDA CEBU password</h2><p>Your verification code:</p><p style="font-size:32px;font-weight:bold;letter-spacing:6px">${code}</p><p>This code expires in 10 minutes and can be used once.</p><p>If you did not request this, you can ignore this email.</p></div>`
  });
  if (provider === 'resend') {
    return {
      configured: Boolean(env.RESEND_API_KEY && from),
      async sendRecoveryCode({ email, code }) {
        const response = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from, to: [email], ...message(code) }),
          signal: AbortSignal.timeout(30000)
        });
        if (!response.ok) throw new Error('Email provider rejected the message');
      },
      close() {}
    };
  }
  if (provider !== 'smtp') throw new Error('MAIL_PROVIDER must be smtp or resend.');
  const configured = Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS && from);
  const transport = configured ? nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT || 465),
    secure: env.SMTP_SECURE !== 'false',
    requireTLS: env.SMTP_SECURE === 'false',
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 30000,
    tls: { minVersion: 'TLSv1.2' },
    disableFileAccess: true,
    disableUrlAccess: true
  }) : null;
  return {
    configured,
    async sendRecoveryCode({ email, code }) {
      if (!transport) throw new Error('Email is not configured');
      await transport.sendMail({ from, to: email, ...message(code) });
    },
    close() { transport?.close(); }
  };
}

module.exports = { createMailer };
