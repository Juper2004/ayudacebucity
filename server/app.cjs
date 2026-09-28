'use strict';
const express = require('express');
const path = require('node:path');
const { randomBytes, randomInt, randomUUID } = require('node:crypto');
const { openDatabase } = require('./database.cjs');
const { hashPassword, verifyPassword, digest, codeDigest, equalDigest, validEmail, validPassword } = require('./security.cjs');
const barangays = require('./barangays.json');

const MINUTE = 60000;
const RESET_MESSAGE = 'If an account exists for this email, a verification code will be sent. Check your inbox and spam folder.';
const INVALID_CODE = 'That verification code is invalid or expired. Request a new code if needed.';

async function createApp(options = {}) {
  const db = openDatabase(options.databasePath || ':memory:');
  const now = options.clock || Date.now;
  const mailer = options.mailer || { configured: false };
  const secret = options.otpSecret || randomBytes(32).toString('hex');
  const appOrigin = new URL(options.appOrigin || 'http://localhost:3000').origin;
  const secureCookies = Boolean(options.secureCookies);
  const root = path.resolve(__dirname, '..');
  const jobs = new Set();
  const dummyPassword = await hashPassword(randomBytes(32).toString('hex'));
  const app = express();
  const cookieName = secureCookies ? '__Host-ayudaSession' : 'ayudaSession';
  const cookieOptions = { httpOnly: true, secure: secureCookies, sameSite: 'lax', path: '/' };
  app.disable('x-powered-by');

  function profile(row) { return row ? JSON.parse(row.profile) : null; }
  function userByEmail(email) { return db.prepare('SELECT * FROM users WHERE email = ?').get(email); }
  function publicUser(id) { return profile(db.prepare('SELECT profile FROM users WHERE id = ?').get(id)); }
  function cleanEmail(value) { return typeof value === 'string' ? value.trim().toLowerCase() : ''; }
  function fail(res, status, message) { return res.status(status).json({ message }); }
  function rate(key, maximum, duration) {
    const keyHash = digest(key);
    const record = db.prepare('SELECT * FROM rate_limits WHERE key = ?').get(keyHash);
    if (!record || record.expires_at <= now()) {
      db.prepare('INSERT OR REPLACE INTO rate_limits (key, count, expires_at) VALUES (?, 1, ?)').run(keyHash, now() + duration);
      return 0;
    }
    if (record.count >= maximum) return Math.max(1, Math.ceil((record.expires_at - now()) / 1000));
    db.prepare('UPDATE rate_limits SET count = count + 1 WHERE key = ?').run(keyHash);
    return 0;
  }
  function limit(res, seconds) {
    res.set('Retry-After', String(seconds));
    return fail(res, 429, 'Too many attempts. Please wait before trying again.');
  }
  function requestToken(req) {
    const item = (req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith(cookieName + '='));
    const token = item?.slice(cookieName.length + 1);
    return token && /^[a-f0-9]{64}$/.test(token) ? token : null;
  }
  function signedIn(req, res, next) {
    if (!req.actor) return fail(res, 401, 'Please log in to continue.');
    next();
  }
  function canReview(actor, account) {
    return actor?.status === 'APPROVED' && account && (
      actor.role === 'DSWS_ADMIN' && ['HOUSEHOLD', 'BARANGAY_OFFICIAL'].includes(account.role) ||
      actor.role === 'BARANGAY_OFFICIAL' && account.role === 'HOUSEHOLD' && account.barangay === actor.barangay
    );
  }
  function accountInput(body, forcedRole) {
    const role = forcedRole || body.role;
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const email = cleanEmail(body.email);
    const contact = typeof body.contact === 'string' ? body.contact.trim() : '';
    const barangay = body.barangay;
    if (!['HOUSEHOLD', 'DONOR', 'BARANGAY_OFFICIAL'].includes(role)) return { error: 'Select a valid account role.' };
    if (!name || name.length > 160 || !validEmail(email)) return { error: 'Enter a valid name and email address.' };
    if (!validPassword(body.password)) return { error: 'Use a password with 8 to 128 characters.' };
    if (role !== 'DONOR' && (!barangays.includes(barangay) || !contact || contact.length > 60)) return { error: 'Enter a valid barangay and contact number.' };
    return { user: {
      id: 'ACC-' + randomUUID(), name, email, role,
      barangay: role === 'DONOR' ? null : barangay,
      contact: role === 'DONOR' ? null : contact,
      status: role === 'DONOR' || forcedRole ? 'APPROVED' : 'PENDING',
      createdAt: new Date(now()).toISOString()
    } };
  }
  async function insertAccount(user, password) {
    const hash = await hashPassword(password);
    // Recheck after the asynchronous hash to handle simultaneous registrations.
    if (userByEmail(user.email)) return false;
    db.prepare('INSERT INTO users (id, email, password_hash, profile) VALUES (?, ?, ?, ?)').run(user.id, user.email, hash, JSON.stringify(user));
    return true;
  }

  if (options.admin && !db.prepare("SELECT id FROM users WHERE json_extract(profile, '$.role') = 'DSWS_ADMIN'").get()) {
    const email = cleanEmail(options.admin.email);
    if (!validEmail(email) || !validPassword(options.admin.password)) throw new Error('Set a valid ADMIN_EMAIL and ADMIN_PASSWORD (8 to 128 characters).');
    const user = { id: 'ACC-' + randomUUID(), email, name: options.admin.name || 'DSWS Administrator', role: 'DSWS_ADMIN', status: 'APPROVED', createdAt: new Date(now()).toISOString() };
    if (!await insertAccount(user, options.admin.password)) throw new Error('The bootstrap admin email already belongs to another account. Choose a different ADMIN_EMAIL.');
  }

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
    });
    next();
  });
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (req.get('Sec-Fetch-Site') === 'cross-site' || req.get('Origin') && req.get('Origin') !== appOrigin) return fail(res, 403, 'This request must come from the AYUDA website.');
      if (!req.is('application/json')) return fail(res, 415, 'Send requests as application/json.');
    }
    next();
  });
  app.use('/api', express.json({ limit: '16kb' }));
  app.use('/api', (req, res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))) return fail(res, 400, 'Send a JSON object.');
    const token = requestToken(req);
    req.sessionHash = token ? digest(token) : null;
    if (req.sessionHash) {
      const record = db.prepare('SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?').get(req.sessionHash, now());
      req.actor = record ? publicUser(record.user_id) : null;
    }
    next();
  });

  app.get('/api/auth/session', (req, res) => res.json({ user: req.actor || null }));
  app.post('/api/auth/register', async (req, res) => {
    const wait = rate('register:' + req.ip, 10, 60 * MINUTE);
    if (wait) return limit(res, wait);
    const input = accountInput(req.body);
    if (input.error) return fail(res, 400, input.error);
    if (!await insertAccount(input.user, req.body.password)) return fail(res, 409, 'An account with this email already exists.');
    res.status(201).json({ user: input.user, message: input.user.status === 'PENDING' ? 'Account created. Your account is waiting for approval.' : 'Account created. You can now log in.' });
  });
  app.post('/api/auth/login', async (req, res) => {
    const email = cleanEmail(req.body.email);
    const password = req.body.password;
    if (!validEmail(email) || typeof password !== 'string' || password.length > 128) return fail(res, 400, 'Enter a valid email and password.');
    const wait = rate('login-ip:' + req.ip, 30, 15 * MINUTE) || rate('login-email:' + email, 10, 15 * MINUTE);
    if (wait) return limit(res, wait);
    const row = userByEmail(email);
    const verified = await verifyPassword(password, row?.password_hash || dummyPassword);
    if (!row || !verified || userByEmail(email)?.password_hash !== row.password_hash) return fail(res, 401, 'Invalid email or password.');
    const user = publicUser(row.id);
    if (user.role !== 'HOUSEHOLD' && user.status !== 'APPROVED') return fail(res, 403, user.status === 'REJECTED' ? 'Your account was not approved. Contact DSWS for assistance.' : 'Your account is waiting for approval.');
    const token = randomBytes(32).toString('hex');
    const duration = 8 * 60 * MINUTE;
    if (req.sessionHash) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(req.sessionHash);
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(digest(token), user.id, now() + duration);
    res.cookie(cookieName, token, { ...cookieOptions, maxAge: duration }).json({ user });
  });
  app.post('/api/auth/logout', (req, res) => {
    if (req.sessionHash) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(req.sessionHash);
    res.clearCookie(cookieName, cookieOptions).json({ message: 'You have been logged out.' });
  });
  app.post('/api/auth/change-password', signedIn, async (req, res) => {
    const wait = rate('change-password:' + req.actor.id, 10, 15 * MINUTE);
    if (wait) return limit(res, wait);
    const record = userByEmail(req.actor.email);
    if (!record) return fail(res, 401, 'Your account session is no longer valid.');
    const currentPassword = req.body.currentPassword;
    const newPassword = req.body.newPassword;
    if (typeof currentPassword !== 'string' || currentPassword.length > 128 || typeof newPassword !== 'string') return fail(res, 400, 'Enter your current password and a new password.');
    if (!validPassword(newPassword)) return fail(res, 400, 'Use a password with 8 to 128 characters.');
    const validCurrent = await verifyPassword(currentPassword, record.password_hash);
    if (!validCurrent) return fail(res, 400, 'Your current password is incorrect.');
    const nextHash = await hashPassword(newPassword);
    db.exec('BEGIN IMMEDIATE');
    try {
      // A reset may have revoked this session while the password was being hashed.
      const activeSession = db.prepare('SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?').get(req.sessionHash, now());
      if (!activeSession || activeSession.user_id !== record.id || userByEmail(req.actor.email)?.password_hash !== record.password_hash) {
        db.exec('ROLLBACK');
        return fail(res, 409, 'Your account changed during this request. Please log in again.');
      }
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(nextHash, record.id);
      db.prepare('DELETE FROM password_resets WHERE email = ?').run(record.email);
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(record.id, req.sessionHash);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    res.json({ message: 'Password changed successfully.' });
  });
  app.post('/api/auth/forgot-password', (req, res) => {
    const email = cleanEmail(req.body.email);
    if (!validEmail(email)) return fail(res, 400, 'Enter a valid email address.');
    if (!mailer.configured) return fail(res, 503, 'Email delivery is not configured yet. Please contact the site administrator.');
    const wait = rate('forgot-ip:' + req.ip, 20, 60 * MINUTE)
      || rate('forgot-cooldown:' + email, 1, MINUTE)
      || rate('forgot-email:' + email, 5, 60 * MINUTE);
    if (wait) return limit(res, wait);
    // Respond before looking up the account or contacting the provider, so delivery
    // time and provider errors do not reveal whether an email is registered.
    res.status(202).json({ message: RESET_MESSAGE });
    let job;
    job = new Promise(resolve => setImmediate(resolve)).then(async () => {
      if (!userByEmail(email)) return;
      const code = randomInt(0, 1000000).toString().padStart(6, '0');
      const challengeId = randomUUID();
      db.prepare('INSERT OR REPLACE INTO password_resets (email, challenge_id, code_hash, expires_at, attempts, created_at) VALUES (?, ?, ?, ?, 0, ?)')
        .run(email, challengeId, codeDigest(secret, email, challengeId, code), now() + 10 * MINUTE, now());
      try {
        await mailer.sendRecoveryCode({ email, code });
      } catch {
        // Never log codes, passwords, mail credentials, or provider response bodies.
        db.prepare('DELETE FROM password_resets WHERE email = ? AND challenge_id = ?').run(email, challengeId);
        (options.logger || console).error('Password recovery email could not be delivered. Check the server email configuration.');
      }
    }).catch(() => (options.logger || console).error('Password recovery could not be completed.')).finally(() => jobs.delete(job));
    jobs.add(job);
  });
  app.post('/api/auth/reset-password', async (req, res) => {
    const email = cleanEmail(req.body.email);
    const { code, password } = req.body;
    if (!validEmail(email) || typeof code !== 'string' || !/^\d{6}$/.test(code)) return fail(res, 400, INVALID_CODE);
    if (!validPassword(password)) return fail(res, 400, 'Use a password with 8 to 128 characters.');
    const wait = rate('reset-ip:' + req.ip, 30, 15 * MINUTE);
    if (wait) return limit(res, wait);
    const challenge = db.prepare('SELECT * FROM password_resets WHERE email = ?').get(email);
    if (!challenge || challenge.expires_at <= now() || challenge.attempts >= 5) return fail(res, 400, INVALID_CODE);
    db.prepare('UPDATE password_resets SET attempts = attempts + 1 WHERE email = ?').run(email);
    if (!equalDigest(challenge.code_hash, codeDigest(secret, email, challenge.challenge_id, code))) return fail(res, 400, INVALID_CODE);
    const passwordHash = await hashPassword(password);
    // A transaction ensures that simultaneous reset submissions cannot reuse a code.
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = db.prepare('SELECT * FROM password_resets WHERE email = ?').get(email);
      if (!current || current.challenge_id !== challenge.challenge_id || current.expires_at <= now() || current.attempts > 5) {
        db.exec('ROLLBACK');
        return fail(res, 400, INVALID_CODE);
      }
      const user = userByEmail(email);
      if (!user) { db.exec('ROLLBACK'); return fail(res, 400, INVALID_CODE); }
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, user.id);
      db.prepare('DELETE FROM password_resets WHERE email = ?').run(email);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    res.clearCookie(cookieName, cookieOptions).json({ message: 'Password updated. Please log in with your new password.' });
  });

  app.get('/api/accounts', signedIn, (req, res) => {
    const actor = req.actor;
    let users;
    if (actor.role === 'DSWS_ADMIN' && actor.status === 'APPROVED') {
      users = db.prepare('SELECT profile FROM users ORDER BY rowid').all().map(profile);
    } else if (actor.role === 'BARANGAY_OFFICIAL' && actor.status === 'APPROVED') {
      users = db.prepare("SELECT profile FROM users WHERE id = ? OR (json_extract(profile, '$.role') = 'HOUSEHOLD' AND json_extract(profile, '$.barangay') = ?) ORDER BY rowid").all(actor.id, actor.barangay).map(profile);
    } else users = [actor];
    res.json({ users });
  });
  app.post('/api/accounts/officials', signedIn, async (req, res) => {
    if (req.actor.role !== 'DSWS_ADMIN' || req.actor.status !== 'APPROVED') return fail(res, 403, 'Only DSWS administrators can create official accounts.');
    const wait = rate('official-create:' + req.actor.id, 30, 60 * MINUTE);
    if (wait) return limit(res, wait);
    const input = accountInput(req.body, 'BARANGAY_OFFICIAL');
    if (input.error) return fail(res, 400, input.error);
    input.user.approvedAt = new Date(now()).toISOString();
    input.user.approvedBy = req.actor.email;
    if (!await insertAccount(input.user, req.body.password)) return fail(res, 409, 'An account with this email already exists.');
    res.status(201).json({ user: input.user });
  });
  for (const action of ['approve', 'reject']) {
    app.post(`/api/accounts/:id/${action}`, signedIn, (req, res) => {
      const user = publicUser(req.params.id);
      if (!canReview(req.actor, user)) return fail(res, 403, 'You cannot review this account.');
      if (user.status !== 'PENDING') return fail(res, 409, 'This account has already been reviewed.');
      const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
      if (action === 'reject' && (!reason || reason.length > 2000)) return fail(res, 400, 'Enter a rejection reason with 1 to 2000 characters.');
      user.status = action === 'approve' ? 'APPROVED' : 'REJECTED';
      if (action === 'approve') {
        user.approvedAt = new Date(now()).toISOString();
        user.approvedBy = req.actor.email;
      } else {
        user.rejectionReason = reason;
        user.reviewedAt = new Date(now()).toISOString();
        user.reviewedBy = req.actor.email;
      }
      db.prepare('UPDATE users SET profile = ? WHERE id = ?').run(JSON.stringify(user), user.id);
      res.json({ user });
    });
  }
  app.use('/api', (req, res) => fail(res, 404, 'API endpoint not found.'));

  // Serve only public application assets, never the project directory or secrets.
  const assets = ['index.html', 'script.js', 'report-pdf.js', 'report-worker.js', 'styles.css', 'auth.css', 'auth-cebu-waterfront.png', 'banner.png', 'cebu-skyline.png', 'final-icon.png', 'hero.png'];
  app.get('/', (req, res) => res.sendFile(path.join(root, 'index.html')));
  for (const asset of assets) app.get('/' + asset, (req, res) => res.sendFile(path.join(root, asset)));
  app.get('/vendor/jspdf.umd.min.js', (req, res) => res.sendFile(path.join(root, 'node_modules/jspdf/dist/jspdf.umd.min.js')));
  app.get('/vendor/jspdf.plugin.autotable.min.js', (req, res) => res.sendFile(path.join(root, 'node_modules/jspdf-autotable/dist/jspdf.plugin.autotable.min.js')));
  app.use((req, res) => fail(res, 404, 'Page not found.'));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.type === 'entity.too.large') return fail(res, 413, 'Request is too large.');
    if (error.type === 'entity.parse.failed') return fail(res, 400, 'Invalid JSON request.');
    (options.logger || console).error('An AYUDA server request failed.');
    fail(res, 500, 'The server could not complete this request. Please try again.');
  });
  const cleanup = setInterval(() => {
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now());
    db.prepare('DELETE FROM password_resets WHERE expires_at <= ?').run(now());
    db.prepare('DELETE FROM rate_limits WHERE expires_at <= ?').run(now());
  }, 30 * MINUTE);
  cleanup.unref();
  return { app, db, async close() { clearInterval(cleanup); await Promise.allSettled([...jobs]); mailer.close?.(); db.close(); } };
}

module.exports = { createApp };
