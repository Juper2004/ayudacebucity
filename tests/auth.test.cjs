const assert = require('node:assert/strict');
const { once } = require('node:events');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { basename, dirname, join, resolve } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const test = require('node:test');
const { createApp } = require('../server/app.cjs');

const PASSWORD = 'Testing-password-938!';
const NEW_PASSWORD = 'Changed-password-174!';
const ORIGIN = 'http://127.0.0.1:3000';

function assertPublicUser(user) {
  assert.ok(user && user.id && user.email, 'a public user has an id and email');
  assert.doesNotMatch(JSON.stringify(user), /password|token_hash|code_hash|scrypt/i);
}

async function fixture(t, options = {}) {
  let now = Date.UTC(2026, 8, 22, 10, 0, 0);
  const sent = [];
  const backend = await createApp({
    databasePath: ':memory:',
    clock: () => now,
    appOrigin: ORIGIN,
    secureCookies: false,
    otpSecret: 'test-only-secret-0123456789abcdef0123456789abcdef',
    mailer: {
      configured: true,
      async sendRecoveryCode(message) { sent.push(message); },
    },
    ...options,
  });
  const server = backend.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections?.();
    });
    await backend.close();
  }
  t.after(stop);

  async function request(path, { method = 'GET', body, cookie, headers = {} } = {}) {
    const requestHeaders = { ...headers };
    if (cookie) requestHeaders.Cookie = cookie;
    if (body !== undefined && !Object.keys(requestHeaders).some(key => key.toLowerCase() === 'content-type')) {
      requestHeaders['Content-Type'] = 'application/json';
    }
    const response = await fetch(`${base}${path}`, {
      method,
      headers: requestHeaders,
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      redirect: 'manual',
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = null; }
    return {
      status: response.status,
      headers: response.headers,
      cookie: response.headers.get('set-cookie')?.split(';')[0],
      text,
      data,
    };
  }

  async function register(overrides = {}) {
    const body = {
      name: 'Test Resident', email: 'resident@example.com', password: PASSWORD,
      role: 'DONOR', barangay: 'Guadalupe', contact: '09171234567', ...overrides,
    };
    const response = await request('/api/auth/register', { method: 'POST', body });
    assert.equal(response.status, 201, response.text);
    assertPublicUser(response.data.user);
    return response.data.user;
  }

  async function login(email = 'resident@example.com', password = PASSWORD) {
    const response = await request('/api/auth/login', { method: 'POST', body: { email, password } });
    assert.equal(response.status, 200, response.text);
    assert.ok(response.cookie, 'login sets a session cookie');
    assertPublicUser(response.data.user);
    return response;
  }

  async function waitForMail(count) {
    for (let attempts = 0; attempts < 100 && sent.length < count; attempts++) await delay(10);
    assert.equal(sent.length, count, 'email was handed to the injected mailer');
    return sent[count - 1];
  }

  async function sendCode(email = 'resident@example.com') {
    const count = sent.length + 1;
    const response = await request('/api/auth/forgot-password', { method: 'POST', body: { email } });
    assert.equal(response.status, 202, response.text);
    const mail = await waitForMail(count);
    assert.match(mail.code, /^\d{6}$/);
    assert.equal(mail.email, email);
    assert.ok(!response.text.includes(mail.code), 'code never appears in the HTTP response');
    return mail.code;
  }

  return {
    ...backend, request, register, login, sendCode, waitForMail, sent, stop,
    advance(milliseconds) { now += milliseconds; },
  };
}

test('registration, persisted sessions, secure cookie attributes and logout', async t => {
  const app = await fixture(t);
  assert.deepEqual((await app.request('/api/auth/session')).data, { user: null });
  const user = await app.register({ email: ' Resident@Example.com ' });
  assert.equal(user.email, 'resident@example.com');
  assert.equal(user.role, 'DONOR');
  assert.equal(user.status, 'APPROVED');

  const login = await app.login();
  const setCookie = login.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=(Lax|Strict)/i);
  assert.match(setCookie, /Path=\//i);
  const session = await app.request('/api/auth/session', { cookie: login.cookie });
  assert.equal(session.data.user.id, user.id);
  assertPublicUser(session.data.user);

  const storedUser = app.db.prepare('SELECT password_hash, profile FROM users WHERE email = ?').get(user.email);
  assert.notEqual(storedUser.password_hash, PASSWORD);
  assert.ok(storedUser.password_hash.length > 40);
  assert.ok(!storedUser.profile.includes(PASSWORD));
  const storedSession = app.db.prepare('SELECT token_hash FROM sessions WHERE user_id = ?').get(user.id);
  assert.ok(storedSession && storedSession.token_hash);
  assert.ok(!login.cookie.includes(storedSession.token_hash), 'only a digest is saved for the session token');

  const logout = await app.request('/api/auth/logout', { method: 'POST', body: {}, cookie: login.cookie });
  assert.equal(logout.status, 200, logout.text);
  assert.deepEqual((await app.request('/api/auth/session', { cookie: login.cookie })).data, { user: null });
});

test('email recovery hides account existence and replaces password while revoking every session', async t => {
  const app = await fixture(t);
  await app.register();
  const first = await app.login();
  const second = await app.login();
  const known = await app.request('/api/auth/forgot-password', {
    method: 'POST', body: { email: 'resident@example.com' },
  });
  const unknown = await app.request('/api/auth/forgot-password', {
    method: 'POST', body: { email: 'missing@example.com' },
  });
  assert.equal(known.status, 202);
  assert.equal(unknown.status, 202);
  assert.deepEqual(known.data, unknown.data);
  const { code } = await app.waitForMail(1);
  assert.match(code, /^\d{6}$/);
  assert.ok(!known.text.includes(code));
  assert.equal(Object.hasOwn(known.data, 'code'), false);
  const stored = app.db.prepare('SELECT code_hash FROM password_resets WHERE email = ?').get('resident@example.com');
  assert.ok(stored.code_hash && stored.code_hash !== code);
  assert.ok(stored.code_hash.length > 20);

  const reset = await app.request('/api/auth/reset-password', {
    method: 'POST', body: { email: 'resident@example.com', code, password: NEW_PASSWORD },
  });
  assert.equal(reset.status, 200, reset.text);
  assert.deepEqual((await app.request('/api/auth/session', { cookie: first.cookie })).data, { user: null });
  assert.deepEqual((await app.request('/api/auth/session', { cookie: second.cookie })).data, { user: null });
  const oldLogin = await app.request('/api/auth/login', {
    method: 'POST', body: { email: 'resident@example.com', password: PASSWORD },
  });
  assert.equal(oldLogin.status, 401);
  await app.login('resident@example.com', NEW_PASSWORD);

  const reuse = await app.request('/api/auth/reset-password', {
    method: 'POST', body: { email: 'resident@example.com', code, password: PASSWORD },
  });
  assert.ok(reuse.status >= 400 && reuse.status < 500, reuse.text);
  await app.login('resident@example.com', NEW_PASSWORD);
});

test('accounts, sessions, recovery challenges and resend limits survive a server restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ayuda-auth-test-'));
  const databasePath = join(directory, 'test.sqlite');
  const backends = [];
  t.after(async () => {
    for (const backend of backends) await backend.stop();
    const cleanupTarget = resolve(directory);
    assert.equal(dirname(cleanupTarget), resolve(tmpdir()), 'cleanup remains inside the temporary directory');
    assert.ok(basename(cleanupTarget).startsWith('ayuda-auth-test-'));
    await rm(cleanupTarget, { recursive: true, force: true });
  });
  const first = await fixture(t, { databasePath });
  backends.push(first);
  const user = await first.register();
  const login = await first.login();
  const code = await first.sendCode();
  await first.stop();

  const restarted = await fixture(t, { databasePath });
  backends.push(restarted);
  const session = await restarted.request('/api/auth/session', { cookie: login.cookie });
  assert.equal(session.data.user.id, user.id);
  const resend = await restarted.request('/api/auth/forgot-password', {
    method: 'POST', body: { email: user.email },
  });
  assert.ok([202, 429].includes(resend.status), resend.text);
  await delay(30);
  assert.equal(restarted.sent.length, 0, 'restarting does not reset the resend limit');
  const reset = await restarted.request('/api/auth/reset-password', {
    method: 'POST', body: { email: user.email, code, password: NEW_PASSWORD },
  });
  assert.equal(reset.status, 200, reset.text);
  assert.deepEqual((await restarted.request('/api/auth/session', { cookie: login.cookie })).data, { user: null });
  await restarted.login(user.email, NEW_PASSWORD);
});

test('expired recovery codes cannot change a password', async t => {
  const app = await fixture(t);
  await app.register();
  const code = await app.sendCode();
  app.advance(10 * 60 * 1000 + 1);
  const response = await app.request('/api/auth/reset-password', {
    method: 'POST', body: { email: 'resident@example.com', code, password: NEW_PASSWORD },
  });
  assert.ok(response.status >= 400 && response.status < 500, response.text);
  await app.login();
});

test('concurrent requests can consume a recovery code only once', async t => {
  const app = await fixture(t);
  await app.register();
  const code = await app.sendCode();
  const outcomes = await Promise.all([
    app.request('/api/auth/reset-password', {
      method: 'POST', body: { email: 'resident@example.com', code, password: NEW_PASSWORD },
    }),
    app.request('/api/auth/reset-password', {
      method: 'POST', body: { email: 'resident@example.com', code, password: 'Another-password-458!' },
    }),
  ]);
  assert.equal(outcomes.filter(response => response.status === 200).length, 1);
  assert.equal(outcomes.filter(response => response.status >= 400 && response.status < 500).length, 1);
  const winningPassword = outcomes[0].status === 200 ? NEW_PASSWORD : 'Another-password-458!';
  await app.login('resident@example.com', winningPassword);
});

test('five wrong guesses exhaust a recovery code, and a later resend replaces it', async t => {
  const app = await fixture(t);
  await app.register();
  const code = await app.sendCode();
  const wrongCode = String((Number(code) + 1) % 1000000).padStart(6, '0');
  for (let attempt = 0; attempt < 5; attempt++) {
    const wrong = await app.request('/api/auth/reset-password', {
      method: 'POST', body: { email: 'resident@example.com', code: wrongCode, password: NEW_PASSWORD },
    });
    assert.ok(wrong.status >= 400 && wrong.status < 500, wrong.text);
  }
  const exhausted = await app.request('/api/auth/reset-password', {
    method: 'POST', body: { email: 'resident@example.com', code, password: NEW_PASSWORD },
  });
  assert.ok(exhausted.status >= 400 && exhausted.status < 500, exhausted.text);
  await app.login();
  app.advance(60001);
  const replacement = await app.sendCode();
  const reset = await app.request('/api/auth/reset-password', {
    method: 'POST', body: { email: 'resident@example.com', code: replacement, password: NEW_PASSWORD },
  });
  assert.equal(reset.status, 200, reset.text);
  await app.login('resident@example.com', NEW_PASSWORD);
});

test('email delivery is limited by resend cooldown and hourly allowance', async t => {
  const app = await fixture(t);
  await app.register();
  await app.sendCode();
  const immediate = await app.request('/api/auth/forgot-password', {
    method: 'POST', body: { email: 'resident@example.com' },
  });
  assert.ok([202, 429].includes(immediate.status), immediate.text);
  await delay(30);
  assert.equal(app.sent.length, 1, 'resend cooldown prevents a second delivery');
  for (let delivery = 2; delivery <= 5; delivery++) {
    app.advance(60001);
    await app.sendCode();
  }
  app.advance(60001);
  const sixth = await app.request('/api/auth/forgot-password', {
    method: 'POST', body: { email: 'resident@example.com' },
  });
  assert.ok([202, 429].includes(sixth.status), sixth.text);
  await delay(30);
  assert.equal(app.sent.length, 5, 'hourly cap prevents a sixth delivery');
  app.advance(60 * 60 * 1000);
  await app.sendCode();
});

test('public registration cannot assign administrator privileges or approve itself', async t => {
  const app = await fixture(t);
  const spoof = await app.request('/api/auth/register', {
    method: 'POST',
    body: { name: 'Spoofed Admin', email: 'spoof@example.com', password: PASSWORD, role: 'DSWS_ADMIN' },
  });
  assert.ok(spoof.status >= 400 && spoof.status < 500, spoof.text);
  const household = await app.register({ role: 'HOUSEHOLD', status: 'APPROVED', approvedBy: 'admin' });
  assert.equal(household.status, 'PENDING');
  assert.equal(household.role, 'HOUSEHOLD');
  const official = await app.register({ email: 'official@example.com', role: 'BARANGAY_OFFICIAL', status: 'APPROVED' });
  assert.equal(official.status, 'PENDING');
  const blocked = await app.request('/api/auth/login', {
    method: 'POST', body: { email: official.email, password: PASSWORD },
  });
  assert.equal(blocked.status, 403, blocked.text);
  const residentLogin = await app.login();
  const scoped = await app.request('/api/accounts', { cookie: residentLogin.cookie });
  assert.equal(scoped.status, 200, scoped.text);
  assert.deepEqual(scoped.data.users.map(user => user.id), [household.id], 'households can retrieve only their own account');
  const forbidden = await app.request(`/api/accounts/${encodeURIComponent(official.id)}/approve`, {
    method: 'POST', body: {}, cookie: residentLogin.cookie,
  });
  assert.equal(forbidden.status, 403, forbidden.text);
});

test('account approval is scoped to administrators and the official\'s own barangay', async t => {
  const admin = { name: 'Test Administrator', email: 'admin@example.com', password: PASSWORD };
  const app = await fixture(t, { admin });
  const official = await app.register({ email: 'official@example.com', role: 'BARANGAY_OFFICIAL' });
  const local = await app.register({ email: 'local@example.com', role: 'HOUSEHOLD' });
  const other = await app.register({ email: 'other@example.com', role: 'HOUSEHOLD', barangay: 'Lahug' });
  const adminLogin = await app.login(admin.email);
  const approved = await app.request(`/api/accounts/${encodeURIComponent(official.id)}/approve`, {
    method: 'POST', body: {}, cookie: adminLogin.cookie,
  });
  assert.equal(approved.status, 200, approved.text);
  const officialLogin = await app.login(official.email);
  const list = await app.request('/api/accounts', { cookie: officialLogin.cookie });
  assert.equal(list.status, 200, list.text);
  const users = list.data.users;
  assert.ok(Array.isArray(users));
  assert.ok(users.some(user => user.id === local.id));
  assert.ok(!users.some(user => user.id === other.id));
  for (const user of users) assertPublicUser(user);
  const crossBarangay = await app.request(`/api/accounts/${encodeURIComponent(other.id)}/approve`, {
    method: 'POST', body: {}, cookie: officialLogin.cookie,
  });
  assert.ok([403, 404].includes(crossBarangay.status), crossBarangay.text);
  const localApproved = await app.request(`/api/accounts/${encodeURIComponent(local.id)}/approve`, {
    method: 'POST', body: {}, cookie: officialLogin.cookie,
  });
  assert.equal(localApproved.status, 200, localApproved.text);
  const localLogin = await app.login(local.email);
  assert.equal(localLogin.data.user.status, 'APPROVED');
  const createOfficial = await app.request('/api/accounts/officials', {
    method: 'POST', cookie: officialLogin.cookie,
    body: { name: 'Unauthorized Official', email: 'unauthorized@example.com', password: PASSWORD, barangay: 'Lahug', contact: '09171234567' },
  });
  assert.equal(createOfficial.status, 403, createOfficial.text);

  const adminCreate = await app.request('/api/accounts/officials', {
    method: 'POST', cookie: adminLogin.cookie,
    body: { name: 'New Official', email: 'new-official@example.com', password: PASSWORD, barangay: 'Lahug', contact: '09171234567', role: 'DSWS_ADMIN' },
  });
  assert.equal(adminCreate.status, 201, adminCreate.text);
  assertPublicUser(adminCreate.data.user);
  assert.equal(adminCreate.data.user.role, 'BARANGAY_OFFICIAL');
  assert.equal(adminCreate.data.user.status, 'APPROVED');
  await app.login('new-official@example.com');

  const adminReject = await app.request(`/api/accounts/${encodeURIComponent(other.id)}/reject`, {
    method: 'POST', cookie: adminLogin.cookie, body: { reason: 'Please provide your complete household information.' },
  });
  assert.equal(adminReject.status, 200, adminReject.text);
  const rejectedLogin = await app.login(other.email);
  assert.equal(rejectedLogin.data.user.status, 'REJECTED');
});

test('JSON and origin checks reject cross-site mutations and malformed requests', async t => {
  const app = await fixture(t);
  const crossSite = await app.request('/api/auth/forgot-password', {
    method: 'POST', headers: { Origin: 'https://untrusted.example' }, body: { email: 'resident@example.com' },
  });
  assert.equal(crossSite.status, 403, crossSite.text);
  const plainText = await app.request('/api/auth/forgot-password', {
    method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"email":"resident@example.com"}',
  });
  assert.equal(plainText.status, 415, plainText.text);
  const malformed = await app.request('/api/auth/forgot-password', {
    method: 'POST', body: '{"email":',
  });
  assert.equal(malformed.status, 400, malformed.text);
  const sameOrigin = await app.request('/api/auth/forgot-password', {
    method: 'POST', headers: { Origin: ORIGIN }, body: { email: 'missing@example.com' },
  });
  assert.equal(sameOrigin.status, 202, sameOrigin.text);
});

test('static serving exposes frontend assets without exposing server, secrets or test artifacts', async t => {
  const app = await fixture(t);
  const index = await app.request('/');
  assert.equal(index.status, 200);
  assert.match(index.text, /<!doctype html>/i);
  for (const path of ['/script.js', '/report-pdf.js', '/styles.css', '/auth.css', '/vendor/jspdf.umd.min.js', '/vendor/jspdf.plugin.autotable.min.js']) {
    assert.equal((await app.request(path)).status, 200, path);
  }
  for (const path of ['/.env', '/.env.example', '/server/app.cjs', '/data/ayuda.sqlite', '/tests/auth.test.cjs', '/output/dashboard-browser-results.json', '/package.json', '/.git/config', '/node_modules/jspdf/package.json', '/vendor/package.json']) {
    const response = await app.request(path);
    assert.ok([403, 404].includes(response.status), `${path}: ${response.status}`);
    assert.ok(!response.text.includes('test-only-secret-0123456789abcdef'));
  }
});

test('logged-in users can change their password without invalidating their current session', async t => {
  const app = await fixture(t);
  await app.register();
  const login = await app.login();
  const otherSession = await app.login();
  const previousResetCode = await app.sendCode();
  const wrong = await app.request('/api/auth/change-password', {
    method: 'POST',
    body: { currentPassword: 'wrong-password', newPassword: NEW_PASSWORD },
    cookie: login.cookie,
  });
  assert.equal(wrong.status, 400, wrong.text);

  const changed = await app.request('/api/auth/change-password', {
    method: 'POST',
    body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    cookie: login.cookie,
  });
  assert.equal(changed.status, 200, changed.text);
  assert.deepEqual(changed.data.message, 'Password changed successfully.');

  assert.equal((await app.request('/api/auth/session', { cookie: otherSession.cookie })).data.user, null);
  const oldReset = await app.request('/api/auth/reset-password', {
    method: 'POST', body: { email: 'resident@example.com', code: previousResetCode, password: PASSWORD },
  });
  assert.equal(oldReset.status, 400, 'password change invalidates earlier recovery codes');

  const oldLogin = await app.request('/api/auth/login', {
    method: 'POST', body: { email: 'resident@example.com', password: PASSWORD },
  });
  assert.equal(oldLogin.status, 401, oldLogin.text);

  const newLogin = await app.request('/api/auth/login', {
    method: 'POST', body: { email: 'resident@example.com', password: NEW_PASSWORD },
  });
  assert.equal(newLogin.status, 200, newLogin.text);
  assert.equal(newLogin.data.user.email, 'resident@example.com');

  const currentSession = await app.request('/api/auth/session', { cookie: login.cookie });
  assert.equal(currentSession.data.user.email, 'resident@example.com');
});

test('missing email configuration reports an actionable error without account disclosure', async t => {
  const app = await fixture(t, { mailer: { configured: false, async sendRecoveryCode() { throw new Error('must not send'); } } });
  await app.register();
  const known = await app.request('/api/auth/forgot-password', {
    method: 'POST', body: { email: 'resident@example.com' },
  });
  const unknown = await app.request('/api/auth/forgot-password', {
    method: 'POST', body: { email: 'missing@example.com' },
  });
  assert.equal(known.status, 503, known.text);
  assert.equal(unknown.status, 503, unknown.text);
  assert.deepEqual(known.data, unknown.data);
});
