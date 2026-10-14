const assert = require('node:assert/strict');
const { once } = require('node:events');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { basename, dirname, join, resolve } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const test = require('node:test');
const { createApp } = require('../server/app.cjs');
const { hashPassword } = require('../server/security.cjs');

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

// Browsers send every matching cookie on the same origin, even across tabs.
function sharedBrowser(app) {
  const cookies = new Map();
  async function request(tabId, path, options = {}) {
    const response = await app.request(path, {
      ...options,
      cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; '),
      headers: { ...(tabId === undefined ? {} : { 'X-Ayuda-Tab': tabId }), ...options.headers },
    });
    for (const setCookie of response.headers.getSetCookie()) {
      const pair = setCookie.split(';')[0];
      const separator = pair.indexOf('=');
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      if (!value || /Max-Age=0(?:;|$)/i.test(setCookie)) cookies.delete(name);
      else cookies.set(name, value);
    }
    return response;
  }
  return {
    cookies, request,
    async login(tabId, email, password = PASSWORD) {
      const response = await request(tabId, '/api/auth/login', { method: 'POST', body: { email, password } });
      assert.equal(response.status, 200, response.text);
      return response;
    },
    async user(tabId) {
      const response = await request(tabId, '/api/auth/session');
      assert.equal(response.status, 200, response.text);
      return response.data.user;
    },
  };
}

async function multiRoleFixture(t, options = {}) {
  const admin = { name: 'Test Administrator', email: 'admin@example.com', password: PASSWORD };
  const app = await fixture(t, { admin, ...options });
  const browser = sharedBrowser(app);
  const tabs = { admin: 'a'.repeat(32), official: 'b'.repeat(32), household: 'c'.repeat(32), other: 'd'.repeat(32) };
  const official = await app.register({ email: 'official@example.com', role: 'BARANGAY_OFFICIAL' });
  const household = await app.register({ role: 'HOUSEHOLD' });
  const adminLogin = await browser.login(tabs.admin, admin.email);
  const approval = await browser.request(tabs.admin, `/api/accounts/${official.id}/approve`, { method: 'POST', body: {} });
  assert.equal(approval.status, 200, approval.text);
  await browser.login(tabs.official, official.email);
  await browser.login(tabs.household, household.email);
  return { app, browser, tabs, admin: adminLogin.data.user, official, household };
}

test('one browser can keep DSWS, barangay, household and legacy sessions independent', async t => {
  const { app, browser, tabs, admin, official, household } = await multiRoleFixture(t);
  const donor = await app.register({ email: 'donor@example.com' });
  await browser.login(undefined, donor.email);
  assert.equal(browser.cookies.size, 4, 'all four sessions share the same browser cookie jar');
  for (const [tabId, expected] of [[tabs.admin, admin], [tabs.official, official], [tabs.household, household], [undefined, donor]]) {
    assert.equal((await browser.user(tabId)).id, expected.id);
  }
  const accounts = async tabId => {
    const response = await browser.request(tabId, '/api/accounts');
    assert.equal(response.status, 200, response.text);
    return response.data.users.map(user => user.id).sort();
  };
  assert.deepEqual(await accounts(tabs.admin), [admin.id, official.id, household.id, donor.id].sort());
  assert.deepEqual(await accounts(tabs.official), [official.id, household.id].sort());
  assert.deepEqual(await accounts(tabs.household), [household.id]);
  assert.deepEqual(await accounts(undefined), [donor.id]);
  const forbidden = await browser.request(tabs.household, '/api/accounts/officials', { method: 'POST', body: {} });
  assert.equal(forbidden.status, 403, 'another tab\'s admin cookie grants no privileges');

  const adminCookieName = `ayudaSession_${tabs.admin}`;
  const originalToken = browser.cookies.get(adminCookieName);
  await browser.login(tabs.admin, household.email);
  assert.notEqual(browser.cookies.get(adminCookieName), originalToken, 'switching accounts rotates the selected session');
  const stale = await app.request('/api/auth/session', {
    headers: { 'X-Ayuda-Tab': tabs.admin }, cookie: `${adminCookieName}=${originalToken}`,
  });
  assert.equal(stale.data.user, null, 'the previous token for this tab is revoked');
  assert.deepEqual(await accounts(tabs.admin), [household.id]);
  assert.equal((await browser.user(tabs.official)).id, official.id);
  assert.equal((await browser.user(tabs.household)).id, household.id);
  assert.equal((await browser.user(undefined)).id, donor.id);

  const logout = await browser.request(tabs.household, '/api/auth/logout', { method: 'POST', body: {} });
  assert.equal(logout.status, 200, logout.text);
  assert.equal(browser.cookies.has(`ayudaSession_${tabs.household}`), false);
  assert.equal(await browser.user(tabs.household), null);
  assert.equal((await browser.user(tabs.admin)).id, household.id, 'logout preserves other sessions of the same account');
  assert.equal((await browser.user(tabs.official)).id, official.id);
  assert.equal((await browser.user(undefined)).id, donor.id);
  await browser.request(undefined, '/api/auth/logout', { method: 'POST', body: {} });
  assert.equal(await browser.user(undefined), null);
  assert.equal((await browser.user(tabs.official)).id, official.id, 'legacy logout preserves tab sessions');
});

test('tab selectors reject malformed headers and never fall back to another cookie', async t => {
  const app = await fixture(t);
  const user = await app.register();
  const browser = sharedBrowser(app);
  const tabId = 'a'.repeat(32);
  await browser.login(undefined, user.email);
  await browser.login(tabId, user.email);
  assert.equal(await browser.user('b'.repeat(32)), null, 'a missing selected cookie ignores valid cookies for other tabs and legacy clients');
  for (const value of ['', 'short', 'A'.repeat(32), 'g'.repeat(32), 'a'.repeat(31), 'a'.repeat(33), `${tabId}, ${tabId}`]) {
    for (const [path, options] of [
      ['/api/auth/session', {}], ['/api/accounts', {}],
      ['/api/auth/logout', { method: 'POST', body: {} }], ['/api/unknown', {}],
    ]) {
      const response = await browser.request(value, path, options);
      assert.equal(response.status, 400, `${JSON.stringify(value)} ${path}: ${response.text}`);
      assert.equal(response.headers.get('set-cookie'), null);
    }
  }
  const selectedName = `ayudaSession_${tabId}`;
  const token = browser.cookies.get(selectedName);
  for (const value of ['', 'invalid', '0'.repeat(64)]) {
    browser.cookies.set(selectedName, value);
    assert.equal(await browser.user(tabId), null, 'an invalid selected token cannot borrow the legacy identity');
    assert.equal((await browser.request(tabId, '/api/accounts')).status, 401);
    assert.equal((await browser.user(undefined)).id, user.id);
  }
  browser.cookies.set(selectedName, token);
  browser.cookies.delete('ayudaSession');
  assert.equal(await browser.user(undefined), null, 'headerless clients cannot borrow a tab cookie');
  assert.equal((await browser.user(tabId)).id, user.id);
  const crossSite = await browser.request(tabId, '/api/auth/logout', {
    method: 'POST', body: {}, headers: { Origin: 'https://untrusted.example' },
  });
  assert.equal(crossSite.status, 403);
  const plainText = await browser.request(tabId, '/api/auth/logout', {
    method: 'POST', body: '{}', headers: { 'Content-Type': 'text/plain' },
  });
  assert.equal(plainText.status, 415);
  assert.equal((await browser.user(tabId)).id, user.id);
});

test('tab sessions retain secure cookie attributes and expire after eight hours', async t => {
  const app = await fixture(t, { secureCookies: true });
  const user = await app.register();
  const browser = sharedBrowser(app);
  const tabId = '1'.repeat(32);
  const login = await browser.login(tabId, user.email);
  const setCookie = login.headers.get('set-cookie');
  assert.ok(setCookie.startsWith(`__Host-ayudaSession_${tabId}=`));
  assert.match(setCookie, /; HttpOnly(?:;|$)/i);
  assert.match(setCookie, /; Secure(?:;|$)/i);
  assert.match(setCookie, /; SameSite=Lax(?:;|$)/i);
  assert.match(setCookie, /; Path=\/(?:;|$)/i);
  assert.match(setCookie, /; Max-Age=28800(?:;|$)/i);
  assert.doesNotMatch(setCookie, /; Domain=/i);
  app.advance(8 * 60 * 60 * 1000 - 1);
  assert.equal((await browser.user(tabId)).id, user.id);
  app.advance(1);
  assert.equal(await browser.user(tabId), null, 'the server rejects an expired token even if the client sends it');
  const logout = await browser.request(tabId, '/api/auth/logout', { method: 'POST', body: {} });
  assert.ok(logout.cookie.startsWith(`__Host-ayudaSession_${tabId}=`));
  assert.match(logout.headers.get('set-cookie'), /; HttpOnly(?:;|$)/i);
  assert.match(logout.headers.get('set-cookie'), /; Secure(?:;|$)/i);
});

test('password change and recovery revoke only the affected account across tab and legacy sessions', async t => {
  const { app, browser, tabs, admin, official, household } = await multiRoleFixture(t);
  await browser.login(tabs.other, household.email);
  await browser.login(undefined, household.email);
  const changed = await browser.request(tabs.household, '/api/auth/change-password', {
    method: 'POST', body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
  });
  assert.equal(changed.status, 200, changed.text);
  assert.equal((await browser.user(tabs.household)).id, household.id);
  assert.equal(await browser.user(tabs.other), null);
  assert.equal(await browser.user(undefined), null);
  assert.equal((await browser.user(tabs.admin)).id, admin.id);
  assert.equal((await browser.user(tabs.official)).id, official.id);

  await browser.login(tabs.other, household.email, NEW_PASSWORD);
  await browser.login(undefined, household.email, NEW_PASSWORD);
  const code = await app.sendCode(household.email);
  const reset = await browser.request(tabs.household, '/api/auth/reset-password', {
    method: 'POST', body: { email: household.email, code, password: PASSWORD },
  });
  assert.equal(reset.status, 200, reset.text);
  assert.equal(reset.cookie, `ayudaSession_${tabs.household}=`);
  assert.equal(await browser.user(tabs.household), null);
  assert.equal(await browser.user(tabs.other), null);
  assert.equal(await browser.user(undefined), null);
  assert.equal((await browser.user(tabs.admin)).id, admin.id);
  assert.equal((await browser.user(tabs.official)).id, official.id);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?').get(household.id).count, 0);
});

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

test('household requests persist on the server and appear to the same barangay', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ayuda-request-test-'));
  const databasePath = join(directory, 'requests.sqlite');
  const first = await fixture(t, { databasePath });

  const household = await first.register({
    name: 'Maria Santos',
    email: 'maria@example.com',
    role: 'HOUSEHOLD',
    barangay: 'Lahug',
    contact: '09171234567',
  });
  first.db.prepare("UPDATE users SET profile = json_set(profile, '$.status', 'APPROVED') WHERE id = ?").run(household.id);

  const householdLogin = await first.login('maria@example.com', PASSWORD);
  const createRequest = await first.request('/api/requests', {
    method: 'POST',
    body: {
      category: 'Food',
      disaster: 'Flood',
      urgency: 'Urgent',
      contact: '09171234567',
      description: 'We need rice and canned food.',
      location: 'Lahug, Cebu City',
      photos: [],
    },
    cookie: householdLogin.cookie,
  });
  assert.equal(createRequest.status, 201, createRequest.text);
  assert.match(createRequest.data.request.id, /^REQ-/);
  assert.equal(createRequest.data.request.householdId, household.id);

  const listRequest = await first.request('/api/requests', { cookie: householdLogin.cookie });
  assert.equal(listRequest.status, 200, listRequest.text);
  assert.equal(listRequest.data.requests.length, 1);
  assert.equal(listRequest.data.requests[0].householdId, household.id);

  const second = await fixture(t, { databasePath });
  const official = {
    id: 'OFFICIAL-1',
    email: 'official@example.com',
    name: 'Barangay Clerk',
    role: 'BARANGAY_OFFICIAL',
    barangay: 'Lahug',
    contact: '09999999999',
    status: 'APPROVED',
    createdAt: new Date(Date.UTC(2026, 8, 22, 11, 0, 0)).toISOString(),
  };
  second.db.prepare('INSERT INTO users (id, email, password_hash, profile) VALUES (?, ?, ?, ?)')
    .run(official.id, official.email, await hashPassword(PASSWORD), JSON.stringify(official));
  const officialLogin = await second.login('official@example.com', PASSWORD);
  const sharedList = await second.request('/api/requests', { cookie: officialLogin.cookie });
  assert.equal(sharedList.status, 200, sharedList.text);
  assert.equal(sharedList.data.requests.length, 1);
  assert.equal(sharedList.data.requests[0].barangay, 'Lahug');
});

test('empty dashboard data starts at zero and requests and donations persist through their workflows', async t => {
  const app = await fixture(t, { admin: { email: 'admin@example.com', password: PASSWORD, name: 'DSWS Admin' } });
  const donor = await app.register({ name: 'Community Donor', email: 'donor@example.com', role: 'DONOR' });
  const otherDonor = await app.register({ name: 'Other Donor', email: 'other-donor@example.com', role: 'DONOR' });
  const household = await app.register({ name: 'Lahug Household', email: 'household@example.com', role: 'HOUSEHOLD', barangay: 'Lahug' });
  app.db.prepare("UPDATE users SET profile = json_set(profile, '$.status', 'APPROVED') WHERE id = ?").run(household.id);
  const official = {
    id: 'OFFICIAL-LAHUG', email: 'official@example.com', name: 'Lahug Official', role: 'BARANGAY_OFFICIAL',
    barangay: 'Lahug', contact: '09171234567', status: 'APPROVED', createdAt: new Date().toISOString(),
  };
  app.db.prepare('INSERT INTO users (id, email, password_hash, profile) VALUES (?, ?, ?, ?)')
    .run(official.id, official.email, await hashPassword(PASSWORD), JSON.stringify(official));
  const otherOfficial = {
    id: 'OFFICIAL-APAS', email: 'apas-official@example.com', name: 'Apas Official', role: 'BARANGAY_OFFICIAL',
    barangay: 'Apas', contact: '09171234568', status: 'APPROVED', createdAt: new Date().toISOString(),
  };
  app.db.prepare('INSERT INTO users (id, email, password_hash, profile) VALUES (?, ?, ?, ?)')
    .run(otherOfficial.id, otherOfficial.email, await hashPassword(PASSWORD), JSON.stringify(otherOfficial));

  const donorLogin = await app.login(donor.email);
  const otherDonorLogin = await app.login(otherDonor.email);
  const officialLogin = await app.login(official.email);
  const otherOfficialLogin = await app.login(otherOfficial.email);
  const householdLogin = await app.login(household.email);
  const adminLogin = await app.login('admin@example.com');
  for (const login of [donorLogin, otherDonorLogin, officialLogin, otherOfficialLogin, householdLogin, adminLogin]) {
    const emptyRequests = await app.request('/api/requests', { cookie: login.cookie });
    const emptyDonations = await app.request('/api/donations', { cookie: login.cookie });
    const emptyNotifications = await app.request('/api/notifications', { cookie: login.cookie });
    assert.deepEqual(emptyRequests.data.requests, []);
    assert.deepEqual(emptyDonations.data.donations, []);
    assert.deepEqual(emptyNotifications.data.notifications, []);
    assert.equal(emptyNotifications.data.unreadCount, 0);
  }

  const unsupportedDonationType = await app.request('/api/donations', {
    method: 'POST', cookie: donorLogin.cookie,
    body: { type: 'Financial', amount: '1000', barangay: 'Lahug' },
  });
  assert.equal(unsupportedDonationType.status, 400);
  const generalDonation = await app.request('/api/donations', {
    method: 'POST', cookie: donorLogin.cookie,
    body: { type: 'Medical', amount: 'First-aid kits', barangay: 'Lahug' },
  });
  assert.equal(generalDonation.status, 201, generalDonation.text);
  assert.equal(generalDonation.data.donation.status, 'Pending Approval');
  const donationId = generalDonation.data.donation.id;
  const donorSubmittedInbox = await app.request('/api/notifications', { cookie: donorLogin.cookie });
  assert.equal(donorSubmittedInbox.data.notifications[0].type, 'donation_submitted');
  const officialDonationInbox = await app.request('/api/notifications', { cookie: officialLogin.cookie });
  assert.equal(officialDonationInbox.data.notifications[0].type, 'donation_received');
  const otherOfficialInbox = await app.request('/api/notifications', { cookie: otherOfficialLogin.cookie });
  assert.deepEqual(otherOfficialInbox.data.notifications, []);
  const adminDonationInbox = await app.request('/api/notifications', { cookie: adminLogin.cookie });
  assert.equal(adminDonationInbox.data.notifications[0].targetId, donationId);
  const emptyChat = await app.request(`/api/donations/${donationId}/messages`, { cookie: donorLogin.cookie });
  assert.equal(emptyChat.status, 200, emptyChat.text);
  assert.deepEqual(emptyChat.data.messages, []);
  const deniedDonorChat = await app.request(`/api/donations/${donationId}/messages`, { cookie: otherDonorLogin.cookie });
  const deniedOfficialChat = await app.request(`/api/donations/${donationId}/messages`, { cookie: otherOfficialLogin.cookie });
  assert.equal(deniedDonorChat.status, 404);
  assert.equal(deniedOfficialChat.status, 404);
  const emptyMessage = await app.request(`/api/donations/${donationId}/messages`, {
    method: 'POST', body: { message: '   ' }, cookie: donorLogin.cookie,
  });
  assert.equal(emptyMessage.status, 400);
  const donorMessage = await app.request(`/api/donations/${donationId}/messages`, {
    method: 'POST', body: { message: 'Can we coordinate delivery to the barangay hall?' }, cookie: donorLogin.cookie,
  });
  assert.equal(donorMessage.status, 201, donorMessage.text);
  const officialThread = await app.request(`/api/donations/${donationId}/messages`, { cookie: officialLogin.cookie });
  assert.equal(officialThread.data.messages.length, 1);
  assert.equal(officialThread.data.messages[0].senderName, donor.name);
  const officialMessage = await app.request(`/api/donations/${donationId}/messages`, {
    method: 'POST', body: { message: 'Please deliver to the Apas barangay hall.' }, cookie: officialLogin.cookie,
  });
  assert.equal(officialMessage.status, 201, officialMessage.text);
  const donorThread = await app.request(`/api/donations/${donationId}/messages`, { cookie: donorLogin.cookie });
  assert.equal(donorThread.data.messages.length, 2);
  assert.equal(donorThread.data.messages[1].senderName, official.name);
  const donorChatInbox = await app.request('/api/notifications', { cookie: donorLogin.cookie });
  const chatNotification = donorChatInbox.data.notifications.find(item => item.type === 'donation_message');
  assert.ok(chatNotification);
  const deniedNotificationRead = await app.request(`/api/notifications/${chatNotification.id}/read`, {
    method: 'POST', body: {}, cookie: otherDonorLogin.cookie,
  });
  assert.equal(deniedNotificationRead.status, 404);
  const markChatRead = await app.request(`/api/notifications/${chatNotification.id}/read`, {
    method: 'POST', body: {}, cookie: donorLogin.cookie,
  });
  assert.equal(markChatRead.status, 200, markChatRead.text);
  const pendingDonations = await app.request('/api/donations', { cookie: officialLogin.cookie });
  assert.equal(pendingDonations.data.donations.length, 1);
  assert.equal(pendingDonations.data.donations[0].id, generalDonation.data.donation.id);
  const approveDonation = await app.request(`/api/donations/${generalDonation.data.donation.id}/approve`, {
    method: 'POST', body: {}, cookie: officialLogin.cookie,
  });
  assert.equal(approveDonation.status, 200, approveDonation.text);
  assert.equal(approveDonation.data.donation.status, 'Approved');
  const reviewedThread = await app.request(`/api/donations/${donationId}/messages`, { cookie: officialLogin.cookie });
  assert.equal(reviewedThread.data.messages.length, 2);

  const createdRequest = await app.request('/api/requests', {
    method: 'POST', cookie: householdLogin.cookie,
    body: { category: 'Food', disaster: 'Flood', urgency: 'Urgent', contact: '09171234567', description: 'Food assistance needed.', photos: ['data:image/jpeg;base64,' + 'a'.repeat(20000)] },
  });
  assert.equal(createdRequest.status, 201, createdRequest.text);
  assert.equal(createdRequest.data.request.photos.length, 1);
  const requestId = createdRequest.data.request.id;
  const officialRequestInbox = await app.request('/api/notifications', { cookie: officialLogin.cookie });
  assert.ok(officialRequestInbox.data.notifications.some(item => item.type === 'request_created' && item.targetId === requestId));
  const pledge = await app.request('/api/donations', {
    method: 'POST', cookie: donorLogin.cookie,
    body: { requestId, type: 'Items', amount: 'Food supplies' },
  });
  assert.equal(pledge.status, 201, pledge.text);
  assert.equal(pledge.data.donation.status, 'Reserved');

  const approval = await app.request(`/api/requests/${requestId}/approve`, {
    method: 'POST', body: {}, cookie: officialLogin.cookie,
  });
  assert.equal(approval.status, 200, approval.text);
  assert.equal(approval.data.request.status, 'Pledged');
  const householdStatusInbox = await app.request('/api/notifications', { cookie: householdLogin.cookie });
  assert.ok(householdStatusInbox.data.notifications.some(item => item.title === 'Request approved' && item.targetId === requestId));
  const fulfilled = await app.request(`/api/requests/${requestId}/fulfill`, {
    method: 'POST', body: {}, cookie: officialLogin.cookie,
  });
  assert.equal(fulfilled.status, 200, fulfilled.text);
  assert.equal(fulfilled.data.request.status, 'Fulfilled');

  const householdRequests = await app.request('/api/requests', { cookie: householdLogin.cookie });
  const donorDonations = await app.request('/api/donations', { cookie: donorLogin.cookie });
  assert.equal(householdRequests.data.requests[0].status, 'Fulfilled');
  assert.deepEqual(donorDonations.data.donations.map(item => item.status).sort(), ['Approved', 'Completed']);
  const clearDonorInbox = await app.request('/api/notifications/read-all', {
    method: 'POST', body: {}, cookie: donorLogin.cookie,
  });
  assert.equal(clearDonorInbox.status, 200, clearDonorInbox.text);
  const clearedDonorInbox = await app.request('/api/notifications', { cookie: donorLogin.cookie });
  assert.equal(clearedDonorInbox.data.unreadCount, 0);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM requests').get().count, 1);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM donations').get().count, 2);
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
  assert.match(index.headers.get('content-security-policy'), /(?:^|;)\s*worker-src 'self'(?:;|$)/);
  for (const path of ['/script.js', '/report-pdf.js', '/report-worker.js', '/styles.css', '/auth.css', '/vendor/jspdf.umd.min.js', '/vendor/jspdf.plugin.autotable.min.js']) {
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
