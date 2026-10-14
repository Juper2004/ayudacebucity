'use strict';
const express = require('express');
const path = require('node:path');
const { randomBytes, randomInt, randomUUID } = require('node:crypto');
const { openDatabase } = require('./database.cjs');
const { createGeocoder, GeocodingError, validCoordinates } = require('./geocoding.cjs');
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
  const geocoder = createGeocoder({ appOrigin, ...options.geocoding });
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
    const selectedCookie = req.sessionCookieName;
    const item = (req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith(selectedCookie + '='));
    const token = item?.slice(selectedCookie.length + 1);
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
  function notifyUser(userId, notification) {
    if (!userId) return;
    db.prepare('INSERT INTO notifications (id, user_id, type, title, body, target_type, target_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('NTF-' + randomUUID(), userId, notification.type, notification.title, notification.body, notification.targetType, notification.targetId, new Date(now()).toISOString());
  }
  function notifyApprovedRole(role, notification, barangay = null) {
    const rows = db.prepare("SELECT id, profile FROM users WHERE json_extract(profile, '$.role') = ?").all(role);
    for (const row of rows) {
      const user = profile(row);
      if (user.status === 'APPROVED' && (!barangay || user.barangay === barangay)) notifyUser(row.id, notification);
    }
  }
  function notifyRequestDonors(requestId, notification) {
    const donors = db.prepare('SELECT DISTINCT donor_id FROM donations WHERE request_id = ?').all(requestId);
    for (const donor of donors) notifyUser(donor.donor_id, notification);
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
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://tile.openstreetmap.org; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
    });
    next();
  });
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const tabId = req.get('X-Ayuda-Tab');
    if (tabId !== undefined && !/^[a-f0-9]{32}$/.test(tabId)) return fail(res, 400, 'Invalid browser tab identifier. Reload this tab and try again.');
    // A selector chooses a cookie name, never an identity. Authentication still
    // requires its random HttpOnly token and an unexpired server-side session.
    req.sessionCookieName = tabId === undefined ? cookieName : `${cookieName}_${tabId}`;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (req.get('Sec-Fetch-Site') === 'cross-site' || req.get('Origin') && req.get('Origin') !== appOrigin) return fail(res, 403, 'This request must come from the AYUDA website.');
      if (!req.is('application/json')) return fail(res, 415, 'Send requests as application/json.');
    }
    next();
  });
  app.use('/api', express.json({ limit: '5mb' }));
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
  app.get('/api/notifications', signedIn, (req, res) => {
    const rows = db.prepare('SELECT id, type, title, body, target_type AS targetType, target_id AS targetId, created_at AS createdAt, read_at AS readAt FROM notifications WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 40').all(req.actor.id);
    const unreadCount = db.prepare('SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND read_at IS NULL').get(req.actor.id).count;
    res.json({ notifications: rows, unreadCount });
  });
  app.post('/api/notifications/read-all', signedIn, (req, res) => {
    const timestamp = new Date(now()).toISOString();
    const result = db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(timestamp, req.actor.id);
    res.json({ updated: result.changes });
  });
  app.post('/api/notifications/:id/read', signedIn, (req, res) => {
    const timestamp = new Date(now()).toISOString();
    const result = db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL').run(timestamp, req.params.id, req.actor.id);
    const exists = result.changes || db.prepare('SELECT 1 FROM notifications WHERE id = ? AND user_id = ?').get(req.params.id, req.actor.id);
    if (!exists) return fail(res, 404, 'This notification is not available.');
    res.json({ updated: result.changes > 0 });
  });
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
    res.cookie(req.sessionCookieName, token, { ...cookieOptions, maxAge: duration }).json({ user });
  });
  app.post('/api/auth/logout', (req, res) => {
    if (req.sessionHash) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(req.sessionHash);
    res.clearCookie(req.sessionCookieName, cookieOptions).json({ message: 'You have been logged out.' });
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
    res.clearCookie(req.sessionCookieName, cookieOptions).json({ message: 'Password updated. Please log in with your new password.' });
  });

  app.post('/api/location/reverse', signedIn, async (req, res) => {
    if (req.actor.role !== 'HOUSEHOLD' || req.actor.status !== 'APPROVED') return fail(res, 403, 'An approved household account is required to look up an address.');
    const { latitude, longitude } = req.body;
    if (!validCoordinates(latitude, longitude)) return fail(res, 400, 'Enter valid latitude and longitude coordinates.');
    const wait = rate('location-reverse:' + req.actor.id, 20, 10 * MINUTE);
    if (wait) return limit(res, wait);
    try {
      res.json({ address: await geocoder.reverse(latitude, longitude) });
    } catch (error) {
      if (!(error instanceof GeocodingError)) throw error;
      if (error.retryAfter) res.set('Retry-After', String(error.retryAfter));
      fail(res, error.status, error.message);
    }
  });

  function normalizeRequest(row) {
    if (!row) return null;
    return {
      id: row.id,
      householdId: row.household_id,
      household: row.household,
      barangay: row.barangay,
      contact: row.contact || '',
      category: row.category,
      disaster: row.disaster,
      urgency: row.urgency,
      description: row.description,
      location: row.location || 'Not provided',
      gps: row.gps || 'Not provided',
      gpsAccuracy: row.gps_accuracy ?? null,
      gpsCapturedAt: row.gps_captured_at || null,
      status: row.status,
      photos: (() => {
        try { return JSON.parse(row.photos || '[]'); } catch { return []; }
      })(),
      rejectionReason: row.rejection_reason || null,
      approvedAt: row.approved_at || null,
      approvedBy: row.approved_by || null,
      reviewedBy: row.reviewed_by || null,
      pledgedAt: row.pledged_at || null,
      pledgedBy: row.pledged_by || null,
      fulfilledAt: row.fulfilled_at || null,
      fulfilledById: row.fulfilled_by_id || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function normalizeDonation(row) {
    if (!row) return null;
    return {
      id: row.id,
      donorId: row.donor_id,
      requestId: row.request_id,
      donor: row.donor,
      barangay: row.barangay,
      type: row.type,
      amount: row.amount,
      status: row.status,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      reviewedBy: row.reviewed_by,
      reviewedById: row.reviewed_by_id,
      approvedAt: row.approved_at,
      rejectedAt: row.rejected_at,
      rejectionReason: row.rejection_reason,
      completedAt: row.completed_at,
      cancelledAt: row.cancelled_at,
      expiredAt: row.expired_at,
    };
  }

  function expireServerPledges() {
    const timestamp = new Date(now()).toISOString();
    db.prepare("UPDATE donations SET status = 'Expired', expired_at = ? WHERE status = 'Reserved' AND request_id IS NOT NULL AND expires_at <= ?")
      .run(timestamp, timestamp);
    const pledged = db.prepare("SELECT id FROM requests WHERE status = 'Pledged'").all();
    const activeDonations = db.prepare("SELECT created_at, donor FROM donations WHERE request_id = ? AND status = 'Reserved' AND expires_at > ? ORDER BY created_at, id");
    const updateRequest = db.prepare("UPDATE requests SET status = 'Approved', pledged_at = NULL, pledged_by = NULL, updated_at = ? WHERE id = ? AND status = 'Pledged'");
    const refreshPledge = db.prepare("UPDATE requests SET pledged_at = ?, pledged_by = ?, updated_at = ? WHERE id = ? AND status = 'Pledged'");
    for (const request of pledged) {
      const active = activeDonations.all(request.id, timestamp);
      if (!active.length) updateRequest.run(timestamp, request.id);
      else refreshPledge.run(active[0].created_at, active[0].donor, timestamp, request.id);
    }
  }

  function requestInput(body, actor) {
    const category = typeof body.category === 'string' ? body.category.trim() : '';
    const disaster = typeof body.disaster === 'string' ? body.disaster.trim() : '';
    const urgency = typeof body.urgency === 'string' ? body.urgency.trim() : '';
    const description = typeof body.description === 'string' ? body.description.trim() : '';
    const contact = typeof body.contact === 'string' ? body.contact.trim() : '';
    const location = typeof body.location === 'string' ? body.location.trim().slice(0, 500) : '';
    const gps = typeof body.gps === 'string' ? body.gps.trim().slice(0, 200) : '';
    const gpsAccuracy = typeof body.gpsAccuracy === 'number' && Number.isFinite(body.gpsAccuracy) ? Number(body.gpsAccuracy) : null;
    const gpsCapturedAt = typeof body.gpsCapturedAt === 'string' ? body.gpsCapturedAt : null;
    const photos = Array.isArray(body.photos) ? body.photos : [];
    if (actor.role !== 'HOUSEHOLD' || actor.status !== 'APPROVED') return { error: 'Only approved household accounts can submit requests.' };
    if (!barangays.includes(actor.barangay)) return { error: 'Your household needs a valid barangay.' };
    if (!['Food', 'Water', 'Medical', 'Shelter', 'Utility'].includes(category)) return { error: 'Select a valid assistance category.' };
    if (!['Typhoon', 'Flood', 'Fire', 'Landslide', 'Earthquake', 'Other'].includes(disaster)) return { error: 'Select a valid incident type.' };
    if (!['Low', 'Medium', 'Urgent'].includes(urgency)) return { error: 'Select a valid urgency.' };
    if (!contact || contact.length > 60 || !description || description.length > 2000) return { error: 'Enter a valid contact number and description.' };
    if (location.length > 500) return { error: 'Keep the location to 500 characters or fewer.' };
    if (photos.length > 3 || photos.some(value => typeof value !== 'string' || !/^data:image\/(?:jpeg|png|webp);base64,/.test(value) || value.length > 1400000)) return { error: 'Attach up to 3 images, each under 1 MB.' };
    const createdAt = new Date(now()).toISOString();
    return {
      request: {
        id: 'REQ-' + randomUUID(),
        householdId: actor.id,
        household: actor.name,
        barangay: actor.barangay,
        contact,
        category,
        disaster,
        urgency,
        description,
        status: 'Under Verification',
        location: location || 'Not provided',
        gps: gps || 'Not provided',
        gpsAccuracy,
        gpsCapturedAt,
        photos,
        createdAt,
        updatedAt: createdAt,
      }
    };
  }

  app.get('/api/requests', signedIn, (req, res) => {
    expireServerPledges();
    const actor = req.actor;
    let rows;
    if (actor.role === 'HOUSEHOLD') {
      rows = db.prepare('SELECT * FROM requests WHERE household_id = ? ORDER BY created_at DESC').all(actor.id);
    } else if (actor.role === 'BARANGAY_OFFICIAL') {
      rows = db.prepare('SELECT * FROM requests WHERE barangay = ? ORDER BY created_at DESC').all(actor.barangay);
    } else if (actor.role === 'DONOR') {
      rows = db.prepare("SELECT * FROM requests WHERE status IN ('Approved', 'Under Verification') OR id IN (SELECT request_id FROM donations WHERE donor_id = ?) ORDER BY created_at DESC").all(actor.id);
    } else if (actor.role === 'DSWS_ADMIN') {
      rows = db.prepare('SELECT * FROM requests ORDER BY created_at DESC').all();
    } else {
      rows = [];
    }
    res.json({ requests: rows.map(normalizeRequest) });
  });

  app.post('/api/requests', signedIn, (req, res) => {
    const actor = req.actor;
    const input = requestInput(req.body, actor);
    if (input.error) return fail(res, 400, input.error);
    const request = input.request;
    db.prepare('INSERT INTO requests (id, household_id, household, barangay, contact, category, disaster, urgency, description, status, location, gps, gps_accuracy, gps_captured_at, photos, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        request.id,
        request.householdId,
        request.household,
        request.barangay,
        request.contact,
        request.category,
        request.disaster,
        request.urgency,
        request.description,
        request.status,
        request.location,
        request.gps,
        request.gpsAccuracy,
        request.gpsCapturedAt,
        JSON.stringify(request.photos),
        request.createdAt,
        request.updatedAt
      );
    const requestNotification = {
      type: 'request_created', title: 'New household request',
      body: `${request.household} submitted a ${request.category.toLowerCase()} request in ${request.barangay}.`,
      targetType: 'request', targetId: request.id,
    };
    notifyApprovedRole('BARANGAY_OFFICIAL', requestNotification, request.barangay);
    notifyApprovedRole('DSWS_ADMIN', requestNotification);
    res.status(201).json({ request: normalizeRequest(db.prepare('SELECT * FROM requests WHERE id = ?').get(request.id)) });
  });

  app.post('/api/requests/:id/approve', signedIn, (req, res) => {
    const actor = req.actor;
    if (actor.role !== 'BARANGAY_OFFICIAL' || actor.status !== 'APPROVED') return fail(res, 403, 'Only approved barangay officials can approve requests.');
    expireServerPledges();
    const request = db.prepare('SELECT * FROM requests WHERE id = ? AND barangay = ?').get(req.params.id, actor.barangay);
    if (!request || request.status !== 'Under Verification') return fail(res, 409, 'This request is no longer available for approval.');
    const active = db.prepare("SELECT created_at, donor FROM donations WHERE request_id = ? AND status = 'Reserved' AND expires_at > ? ORDER BY created_at, id").get(request.id, new Date(now()).toISOString());
    const timestamp = new Date(now()).toISOString();
    db.prepare('UPDATE requests SET status = ?, approved_at = ?, approved_by = ?, rejection_reason = NULL, pledged_at = ?, pledged_by = ?, updated_at = ? WHERE id = ?')
      .run(active ? 'Pledged' : 'Approved', timestamp, actor.name, active?.created_at || null, active?.donor || null, timestamp, request.id);
    const statusNotification = {
      type: 'request_status', title: 'Request approved',
      body: `Your ${request.category.toLowerCase()} request in ${request.barangay} was approved${active ? ' and has donor support' : ''}.`,
      targetType: 'request', targetId: request.id,
    };
    notifyUser(request.household_id, statusNotification);
    notifyRequestDonors(request.id, { ...statusNotification, title: 'Request verification updated', body: `A request you supported in ${request.barangay} was approved.` });
    notifyApprovedRole('DSWS_ADMIN', { ...statusNotification, title: 'Request approved citywide', body: `${request.category} assistance in ${request.barangay} was approved.` });
    res.json({ request: normalizeRequest(db.prepare('SELECT * FROM requests WHERE id = ?').get(request.id)) });
  });

  app.post('/api/requests/:id/reject', signedIn, (req, res) => {
    const actor = req.actor;
    if (actor.role !== 'BARANGAY_OFFICIAL' || actor.status !== 'APPROVED') return fail(res, 403, 'Only approved barangay officials can reject requests.');
    const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
    if (!reason || reason.length > 2000) return fail(res, 400, 'Enter a rejection reason with 1 to 2000 characters.');
    const request = db.prepare('SELECT * FROM requests WHERE id = ? AND barangay = ?').get(req.params.id, actor.barangay);
    if (!request || request.status !== 'Under Verification') return fail(res, 409, 'This request is no longer available for rejection.');
    const timestamp = new Date(now()).toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare("UPDATE requests SET status = 'Rejected', rejection_reason = ?, reviewed_by = ?, pledged_at = NULL, pledged_by = NULL, updated_at = ? WHERE id = ?")
        .run(reason, actor.name, timestamp, request.id);
      db.prepare("UPDATE donations SET status = 'Cancelled', cancelled_at = ? WHERE request_id = ? AND status = 'Reserved'")
        .run(timestamp, request.id);
      notifyUser(request.household_id, {
        type: 'request_status', title: 'Request rejected',
        body: `Your ${request.category.toLowerCase()} request in ${request.barangay} was rejected. Open it to see the reason.`,
        targetType: 'request', targetId: request.id,
      });
      notifyRequestDonors(request.id, { type: 'request_status', title: 'Supported request rejected', body: `A request you supported in ${request.barangay} was rejected.`, targetType: 'request', targetId: request.id });
      notifyApprovedRole('DSWS_ADMIN', { type: 'request_status', title: 'Request rejected citywide', body: `${request.category} assistance in ${request.barangay} was rejected.`, targetType: 'request', targetId: request.id });
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    res.json({ request: normalizeRequest(db.prepare('SELECT * FROM requests WHERE id = ?').get(request.id)) });
  });

  app.post('/api/requests/:id/fulfill', signedIn, (req, res) => {
    const actor = req.actor;
    if (actor.role !== 'BARANGAY_OFFICIAL' || actor.status !== 'APPROVED') return fail(res, 403, 'Only approved barangay officials can fulfil requests.');
    expireServerPledges();
    const request = db.prepare('SELECT * FROM requests WHERE id = ? AND barangay = ?').get(req.params.id, actor.barangay);
    const timestamp = new Date(now()).toISOString();
    if (!request || request.status !== 'Pledged') return fail(res, 409, 'Only a pledged request in your barangay can be fulfilled.');
    const active = db.prepare("SELECT id FROM donations WHERE request_id = ? AND status = 'Reserved' AND expires_at > ?").all(request.id, timestamp);
    if (!active.length) return fail(res, 409, 'This request has no active pledge to fulfil.');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare("UPDATE requests SET status = 'Fulfilled', fulfilled_at = ?, fulfilled_by_id = ?, updated_at = ? WHERE id = ?").run(timestamp, actor.id, timestamp, request.id);
      db.prepare("UPDATE donations SET status = 'Completed', completed_at = ? WHERE request_id = ? AND status = 'Reserved'").run(timestamp, request.id);
      notifyUser(request.household_id, {
        type: 'request_status', title: 'Request fulfilled',
        body: `Your ${request.category.toLowerCase()} request in ${request.barangay} was marked fulfilled.`,
        targetType: 'request', targetId: request.id,
      });
      notifyRequestDonors(request.id, { type: 'request_status', title: 'Donation delivered', body: `The request you supported in ${request.barangay} was marked fulfilled.`, targetType: 'request', targetId: request.id });
      notifyApprovedRole('DSWS_ADMIN', { type: 'request_status', title: 'Request fulfilled citywide', body: `${request.category} assistance in ${request.barangay} was marked fulfilled.`, targetType: 'request', targetId: request.id });
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    res.json({ request: normalizeRequest(db.prepare('SELECT * FROM requests WHERE id = ?').get(request.id)) });
  });

  function requestChatAccess(actor, requestId) {
    if (actor.status !== 'APPROVED' || !['HOUSEHOLD', 'BARANGAY_OFFICIAL'].includes(actor.role)) return null;
    expireServerPledges();
    const request = db.prepare('SELECT * FROM requests WHERE id = ?').get(requestId);
    if (!request || !['Approved', 'Pledged', 'Fulfilled'].includes(request.status)) return null;
    const householdAccess = actor.role === 'HOUSEHOLD' && actor.id === request.household_id;
    const officialAccess = actor.role === 'BARANGAY_OFFICIAL' && actor.barangay === request.barangay;
    return householdAccess || officialAccess ? request : null;
  }

  app.get('/api/requests/:id/messages', signedIn, (req, res) => {
    const request = requestChatAccess(req.actor, req.params.id);
    if (!request) return fail(res, 404, 'This request conversation is not available. Chat opens after barangay approval.');
    const messages = db.prepare('SELECT id, request_id AS requestId, sender_id AS senderId, sender_name AS senderName, sender_role AS senderRole, message, created_at AS createdAt FROM request_messages WHERE request_id = ? ORDER BY created_at, rowid').all(request.id);
    res.json({ messages, request: normalizeRequest(request) });
  });

  app.post('/api/requests/:id/messages', signedIn, (req, res) => {
    const request = requestChatAccess(req.actor, req.params.id);
    if (!request) return fail(res, 404, 'This request conversation is not available. Chat opens after barangay approval.');
    const message = typeof req.body.message === 'string' ? req.body.message.trim() : '';
    if (!message || message.length > 2000) return fail(res, 400, 'Enter a message with 1 to 2,000 characters.');
    const wait = rate(`request-chat:${req.actor.id}:${request.id}`, 30, MINUTE);
    if (wait) return limit(res, wait);
    const record = {
      id: 'MSG-' + randomUUID(),
      requestId: request.id,
      senderId: req.actor.id,
      senderName: req.actor.name,
      senderRole: req.actor.role,
      message,
      createdAt: new Date(now()).toISOString(),
    };
    const notification = {
      type: 'request_message', title: 'New relief request message',
      body: `${record.senderName} sent a message about your ${request.category.toLowerCase()} request in ${request.barangay}.`,
      targetType: 'request_chat', targetId: request.id,
    };
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT INTO request_messages (id, request_id, sender_id, sender_name, sender_role, message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(record.id, record.requestId, record.senderId, record.senderName, record.senderRole, record.message, record.createdAt);
      if (req.actor.role === 'HOUSEHOLD') notifyApprovedRole('BARANGAY_OFFICIAL', notification, request.barangay);
      else notifyUser(request.household_id, notification);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    res.status(201).json({ message: record, request: normalizeRequest(request) });
  });

  app.get('/api/donations', signedIn, (req, res) => {
    expireServerPledges();
    const actor = req.actor;
    let rows = [];
    if (actor.role === 'DONOR' && actor.status === 'APPROVED') {
      rows = db.prepare('SELECT * FROM donations WHERE donor_id = ? ORDER BY created_at DESC').all(actor.id);
    } else if (actor.role === 'BARANGAY_OFFICIAL' && actor.status === 'APPROVED') {
      rows = db.prepare('SELECT * FROM donations WHERE barangay = ? ORDER BY created_at DESC').all(actor.barangay);
    } else if (actor.role === 'DSWS_ADMIN' && actor.status === 'APPROVED') {
      rows = db.prepare('SELECT * FROM donations ORDER BY created_at DESC').all();
    } else if (actor.role === 'HOUSEHOLD') {
      rows = db.prepare('SELECT donations.* FROM donations JOIN requests ON requests.id = donations.request_id WHERE requests.household_id = ? ORDER BY donations.created_at DESC').all(actor.id);
    }
    res.json({ donations: rows.map(normalizeDonation) });
  });

  app.post('/api/donations', signedIn, (req, res) => {
    const actor = req.actor;
    if (actor.role !== 'DONOR' || actor.status !== 'APPROVED') return fail(res, 403, 'Only approved donors can submit donations.');
    const type = typeof req.body.type === 'string' ? req.body.type.trim() : '';
    const amount = typeof req.body.amount === 'string' ? req.body.amount.trim() : '';
    const requestId = typeof req.body.requestId === 'string' && req.body.requestId ? req.body.requestId : null;
    const requestedBarangay = typeof req.body.barangay === 'string' ? req.body.barangay : '';
    if (!['Items', 'Water', 'Food', 'Medical', 'Shelter', 'Other'].includes(type) || !amount || amount.length > 2000) return fail(res, 400, 'Select a valid donation type and enter details of up to 2,000 characters.');
    let request = null;
    if (requestId) {
      expireServerPledges();
      request = db.prepare('SELECT * FROM requests WHERE id = ?').get(requestId);
      if (!request || !['Approved', 'Under Verification'].includes(request.status)) return fail(res, 409, 'This request is no longer available.');
      const existing = db.prepare("SELECT id FROM donations WHERE donor_id = ? AND request_id = ? AND status = 'Reserved' AND expires_at > ?").get(actor.id, requestId, new Date(now()).toISOString());
      if (existing) return fail(res, 409, 'You already have an active pledge for this request.');
    } else if (!barangays.includes(requestedBarangay)) {
      return fail(res, 400, 'Select a valid barangay for the donation review.');
    }
    const timestamp = new Date(now()).toISOString();
    const donation = {
      id: 'DON-' + randomUUID(), donorId: actor.id, requestId, donor: actor.name,
      barangay: request?.barangay || requestedBarangay, type, amount,
      status: requestId ? 'Reserved' : 'Pending Approval', createdAt: timestamp,
      expiresAt: requestId ? new Date(now() + 48 * 3600000).toISOString() : null,
    };
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT INTO donations (id, donor_id, request_id, donor, barangay, type, amount, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(donation.id, donation.donorId, donation.requestId, donation.donor, donation.barangay, donation.type, donation.amount, donation.status, donation.createdAt, donation.expiresAt);
      if (requestId && request.status === 'Approved') {
        db.prepare("UPDATE requests SET status = 'Pledged', pledged_at = ?, pledged_by = ?, updated_at = ? WHERE id = ? AND status = 'Approved'")
          .run(timestamp, actor.name, timestamp, requestId);
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    notifyUser(actor.id, {
      type: 'donation_submitted', title: requestId ? 'Pledge submitted' : 'General donation submitted',
      body: requestId ? `Your pledge for ${request.barangay} was recorded.` : `Your ${type.toLowerCase()} donation for ${donation.barangay} is waiting for barangay review.`,
      targetType: requestId ? 'request' : 'donation', targetId: requestId || donation.id,
    });
    const donationNotification = {
      type: 'donation_received', title: requestId ? 'New request pledge' : 'New general donation',
      body: `${donation.donor} submitted ${type.toLowerCase()} support for ${donation.barangay}.`,
      targetType: requestId ? 'request' : 'donation', targetId: requestId || donation.id,
    };
    notifyApprovedRole('BARANGAY_OFFICIAL', donationNotification, donation.barangay);
    notifyApprovedRole('DSWS_ADMIN', donationNotification);
    if (requestId) {
      const household = db.prepare('SELECT household_id FROM requests WHERE id = ?').get(requestId);
      notifyUser(household?.household_id, {
        type: 'donation_received', title: 'Your request received donor support',
        body: `A donor pledged ${type.toLowerCase()} support for your request in ${donation.barangay}.`,
        targetType: 'request', targetId: requestId,
      });
    }
    res.status(201).json({ donation: normalizeDonation(db.prepare('SELECT * FROM donations WHERE id = ?').get(donation.id)) });
  });

  for (const action of ['approve', 'reject']) {
    app.post(`/api/donations/:id/${action}`, signedIn, (req, res) => {
      const actor = req.actor;
      if (actor.role !== 'BARANGAY_OFFICIAL' || actor.status !== 'APPROVED') return fail(res, 403, 'Only approved barangay officials can review general donations.');
      const donation = db.prepare('SELECT * FROM donations WHERE id = ? AND barangay = ? AND request_id IS NULL').get(req.params.id, actor.barangay);
      if (!donation || donation.status !== 'Pending Approval') return fail(res, 409, 'This donation is no longer available for review.');
      const timestamp = new Date(now()).toISOString();
      if (action === 'reject') {
        const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
        if (!reason || reason.length > 2000) return fail(res, 400, 'Enter a rejection reason with 1 to 2000 characters.');
        db.prepare("UPDATE donations SET status = 'Rejected', rejection_reason = ?, reviewed_by = ?, reviewed_by_id = ?, rejected_at = ? WHERE id = ?")
          .run(reason, actor.name, actor.id, timestamp, donation.id);
      } else {
        db.prepare("UPDATE donations SET status = 'Approved', rejection_reason = NULL, reviewed_by = ?, reviewed_by_id = ?, approved_at = ? WHERE id = ?")
          .run(actor.name, actor.id, timestamp, donation.id);
      }
      notifyUser(donation.donor_id, {
        type: 'donation_status',
        title: action === 'approve' ? 'General donation approved' : 'General donation rejected',
        body: action === 'approve'
          ? `Your ${donation.type.toLowerCase()} donation for ${donation.barangay} was approved.`
          : `Your ${donation.type.toLowerCase()} donation for ${donation.barangay} was rejected. Open its details for the reason.`,
        targetType: 'donation', targetId: donation.id,
      });
      notifyApprovedRole('DSWS_ADMIN', {
        type: 'donation_status',
        title: action === 'approve' ? 'General donation approved citywide' : 'General donation rejected citywide',
        body: `${donation.type} donation for ${donation.barangay} was ${action === 'approve' ? 'approved' : 'rejected'}.`,
        targetType: 'donation', targetId: donation.id,
      });
      res.json({ donation: normalizeDonation(db.prepare('SELECT * FROM donations WHERE id = ?').get(donation.id)) });
    });
  }

  function donationChatAccess(actor, donationId) {
    const donation = db.prepare('SELECT * FROM donations WHERE id = ?').get(donationId);
    if (!donation) return null;
    const donorAccess = actor.role === 'DONOR' && actor.status === 'APPROVED' && actor.id === donation.donor_id;
    const officialAccess = actor.role === 'BARANGAY_OFFICIAL' && actor.status === 'APPROVED' && actor.barangay === donation.barangay;
    return donorAccess || officialAccess ? donation : null;
  }

  app.get('/api/donations/:id/messages', signedIn, (req, res) => {
    const donation = donationChatAccess(req.actor, req.params.id);
    if (!donation) return fail(res, 404, 'This donation conversation is not available.');
    const messages = db.prepare('SELECT id, donation_id AS donationId, sender_id AS senderId, sender_name AS senderName, sender_role AS senderRole, message, created_at AS createdAt FROM donation_messages WHERE donation_id = ? ORDER BY created_at, rowid').all(donation.id);
    res.json({ messages });
  });

  app.post('/api/donations/:id/messages', signedIn, (req, res) => {
    const donation = donationChatAccess(req.actor, req.params.id);
    if (!donation) return fail(res, 404, 'This donation conversation is not available.');
    const message = typeof req.body.message === 'string' ? req.body.message.trim() : '';
    if (!message || message.length > 2000) return fail(res, 400, 'Enter a message with 1 to 2,000 characters.');
    const wait = rate(`donation-chat:${req.actor.id}:${donation.id}`, 30, MINUTE);
    if (wait) return limit(res, wait);
    const record = {
      id: 'MSG-' + randomUUID(),
      donationId: donation.id,
      senderId: req.actor.id,
      senderName: req.actor.name,
      senderRole: req.actor.role,
      message,
      createdAt: new Date(now()).toISOString(),
    };
    db.prepare('INSERT INTO donation_messages (id, donation_id, sender_id, sender_name, sender_role, message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(record.id, record.donationId, record.senderId, record.senderName, record.senderRole, record.message, record.createdAt);
    const subject = donation.request_id ? `pledge ${donation.id} for request ${donation.request_id}` : `donation ${donation.id}`;
    const notification = {
      type: 'donation_message', title: 'New donation message',
      body: `${record.senderName} sent a message about ${subject}.`,
      targetType: 'chat', targetId: donation.id,
    };
    if (req.actor.role === 'DONOR') notifyApprovedRole('BARANGAY_OFFICIAL', notification, donation.barangay);
    else notifyUser(donation.donor_id, notification);
    res.status(201).json({ message: record });
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
  const assets = ['index.html', 'script.js', 'report-pdf.js', 'report-worker.js', 'styles.css', 'auth.css', 'auth-cebu-waterfront.png', 'banner.png', 'cebu-skyline.png', 'final-icon.png', 'main-logo-circle.png', 'hero.png'];
  app.get('/', (req, res) => res.sendFile(path.join(root, 'index.html')));
  for (const asset of assets) app.get('/' + asset, (req, res) => res.sendFile(path.join(root, asset)));
  app.get('/vendor/jspdf.umd.min.js', (req, res) => res.sendFile(path.join(root, 'node_modules/jspdf/dist/jspdf.umd.min.js')));
  app.get('/vendor/jspdf.plugin.autotable.min.js', (req, res) => res.sendFile(path.join(root, 'node_modules/jspdf-autotable/dist/jspdf.plugin.autotable.min.js')));
  app.get('/vendor/leaflet/leaflet.js', (req, res) => res.sendFile(path.join(root, 'node_modules/leaflet/dist/leaflet.js')));
  app.get('/vendor/leaflet/leaflet.css', (req, res) => res.sendFile(path.join(root, 'node_modules/leaflet/dist/leaflet.css')));
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
  return { app, db, async close() { clearInterval(cleanup); geocoder.close(); await Promise.allSettled([...jobs]); mailer.close?.(); db.close(); } };
}

module.exports = { createApp };
