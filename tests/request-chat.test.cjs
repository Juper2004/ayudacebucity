'use strict';
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { once } = require('node:events');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { basename, dirname, join, resolve } = require('node:path');
const test = require('node:test');
const { createApp } = require('../server/app.cjs');
const { digest } = require('../server/security.cjs');

async function fixture(t, options = {}) {
  let now = Date.UTC(2026, 8, 30, 12);
  const backend = await createApp({ clock: () => now, ...options });
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
  async function request(path, { actor, cookie = actor?.cookie, method = 'GET', body } = {}) {
    const response = await fetch(base + path, {
      method,
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, headers: response.headers, data: await response.json() };
  }
  function account(id, role, overrides = {}) {
    const user = {
      id, role, name: id, email: `${id.toLowerCase()}@example.com`, status: 'APPROVED',
      barangay: 'Lahug', contact: '09171234567', createdAt: new Date(now).toISOString(), ...overrides,
    };
    backend.db.prepare('INSERT INTO users (id, email, password_hash, profile) VALUES (?, ?, ?, ?)')
      .run(id, user.email, 'unused-test-password-hash', JSON.stringify(user));
    const token = randomBytes(32).toString('hex');
    backend.db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .run(digest(token), id, now + 8 * 60 * 60 * 1000);
    return { ...user, cookie: `ayudaSession=${token}` };
  }
  async function createRequest(household, official) {
    const result = await request('/api/requests', {
      method: 'POST', actor: household,
      body: { category: 'Food', disaster: 'Flood', urgency: 'Urgent', contact: household.contact, description: 'Food assistance needed.' },
    });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    if (!official) return result.data.request;
    const approval = await request(`/api/requests/${result.data.request.id}/approve`, { method: 'POST', body: {}, actor: official });
    assert.equal(approval.status, 200, JSON.stringify(approval.data));
    return approval.data.request;
  }
  return { ...backend, request, account, createRequest, stop, advance(milliseconds) { now += milliseconds; } };
}

function participants(app) {
  return {
    household: app.account('HOUSEHOLD', 'HOUSEHOLD'),
    official: app.account('OFFICIAL', 'BARANGAY_OFFICIAL'),
    donor: app.account('DONOR', 'DONOR', { barangay: null }),
  };
}

test('request chat opens on approval, records authenticated authors, and tracks pledged and fulfilled relief', async t => {
  const app = await fixture(t);
  const { household, official, donor } = participants(app);
  const relief = await app.createRequest(household);
  const path = `/api/requests/${relief.id}/messages`;
  for (const actor of [household, official]) {
    assert.equal((await app.request(path, { actor })).status, 404);
    assert.equal((await app.request(path, { actor, method: 'POST', body: { message: 'Too early' } })).status, 404);
  }
  const approval = await app.request(`/api/requests/${relief.id}/approve`, { actor: official, method: 'POST', body: {} });
  assert.equal(approval.status, 200);
  const empty = await app.request(path, { actor: household });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.data.messages, []);
  assert.equal(empty.data.request.status, 'Approved');
  assert.equal(empty.data.request.approvedBy, official.name);

  const sent = await app.request(path, {
    actor: household, method: 'POST',
    body: { message: '  When can we collect the relief?\n ', senderId: donor.id, senderName: 'Impersonated', senderRole: 'BARANGAY_OFFICIAL', requestId: 'OTHER', createdAt: '2000-01-01' },
  });
  assert.equal(sent.status, 201);
  assert.deepEqual(sent.data.message, {
    id: sent.data.message.id, requestId: relief.id, senderId: household.id,
    senderName: household.name, senderRole: 'HOUSEHOLD', message: 'When can we collect the relief?',
    createdAt: '2026-09-30T12:00:00.000Z',
  });
  assert.match(sent.data.message.id, /^MSG-/);
  const reply = await app.request(path, { actor: official, method: 'POST', body: { message: 'We will share the pickup schedule here.' } });
  assert.equal(reply.status, 201);
  assert.equal(reply.data.message.senderRole, 'BARANGAY_OFFICIAL');
  assert.deepEqual((await app.request(path, { actor: household })).data.messages, [sent.data.message, reply.data.message], 'equal timestamps preserve insertion order');
  assert.deepEqual((await app.request(path, { actor: official })).data.messages, [sent.data.message, reply.data.message]);

  const pledge = await app.request('/api/donations', {
    actor: donor, method: 'POST', body: { requestId: relief.id, type: 'Food', amount: 'One food pack' },
  });
  assert.equal(pledge.status, 201);
  const pledged = await app.request(path, { actor: household });
  assert.equal(pledged.data.request.status, 'Pledged');
  assert.equal(pledged.data.request.pledgedBy, donor.name);
  assert.equal((await app.request(path, { actor: household, method: 'POST', body: { message: 'Thank you for the update.' } })).status, 201);
  const fulfillment = await app.request(`/api/requests/${relief.id}/fulfill`, { actor: official, method: 'POST', body: {} });
  assert.equal(fulfillment.status, 200);
  const fulfilled = await app.request(path, { actor: household });
  assert.equal(fulfilled.data.request.status, 'Fulfilled');
  assert.equal(fulfilled.data.request.fulfilledById, official.id);
  assert.equal(fulfilled.data.messages.length, 3);
  const confirmation = await app.request(path, { actor: household, method: 'POST', body: { message: 'Relief received, thank you.' } });
  assert.equal(confirmation.status, 201);
  assert.equal(confirmation.data.request.status, 'Fulfilled');
});

test('request chat isolates households and barangays and denies donors, administrators, and unapproved accounts', async t => {
  const app = await fixture(t);
  const { household, official, donor } = participants(app);
  const relief = await app.createRequest(household, official);
  const path = `/api/requests/${relief.id}/messages`;
  const others = [
    app.account('NEIGHBOR', 'HOUSEHOLD'),
    app.account('OTHER-OFFICIAL', 'BARANGAY_OFFICIAL', { barangay: 'Apas' }),
    app.account('PENDING-OFFICIAL', 'BARANGAY_OFFICIAL', { status: 'PENDING' }),
    app.account('REJECTED-OFFICIAL', 'BARANGAY_OFFICIAL', { status: 'REJECTED' }),
    app.account('ADMIN', 'DSWS_ADMIN'), donor,
  ];
  for (const actor of others) {
    assert.equal((await app.request(path, { actor })).status, 404, `${actor.id} cannot read`);
    assert.equal((await app.request(path, { actor, method: 'POST', body: { message: 'Unauthorized' } })).status, 404, `${actor.id} cannot send`);
  }
  for (const method of ['GET', 'POST']) {
    assert.equal((await app.request(path, { method, ...(method === 'POST' ? { body: { message: 'Anonymous' } } : {}) })).status, 401);
    assert.equal((await app.request('/api/requests/MISSING/messages', { actor: household, method, ...(method === 'POST' ? { body: { message: 'Missing' } } : {}) })).status, 404);
  }
  for (const actor of [household, official]) {
    for (const status of ['PENDING', 'REJECTED']) {
      app.db.prepare("UPDATE users SET profile = json_set(profile, '$.status', ?) WHERE id = ?").run(status, actor.id);
      assert.equal((await app.request(path, { actor })).status, 404, 'an existing session respects approval revocation');
      assert.equal((await app.request(path, { actor, method: 'POST', body: { message: 'Blocked' } })).status, 404);
    }
    app.db.prepare("UPDATE users SET profile = json_set(profile, '$.status', 'APPROVED') WHERE id = ?").run(actor.id);
  }
  assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM request_messages').get().count, 0);
  const ownRequest = await app.createRequest(others[0], official);
  await app.request(`/api/requests/${ownRequest.id}/messages`, { actor: others[0], method: 'POST', body: { message: 'Private neighbor message' } });
  assert.deepEqual((await app.request(path, { actor: household })).data.messages, []);
  assert.equal((await app.request(`/api/requests/${ownRequest.id}/messages`, { actor: household })).status, 404);
});

test('unapproved and rejected requests never allow chat even when donor support exists', async t => {
  const app = await fixture(t);
  const { household, official, donor } = participants(app);
  const relief = await app.createRequest(household);
  const path = `/api/requests/${relief.id}/messages`;
  const pledge = await app.request('/api/donations', { actor: donor, method: 'POST', body: { requestId: relief.id, type: 'Food', amount: 'Food pack' } });
  assert.equal(pledge.status, 201);
  for (const actor of [household, official]) {
    assert.equal((await app.request(path, { actor })).status, 404);
    assert.equal((await app.request(path, { actor, method: 'POST', body: { message: 'Still awaiting approval' } })).status, 404);
  }
  const rejection = await app.request(`/api/requests/${relief.id}/reject`, { actor: official, method: 'POST', body: { reason: 'Duplicate request' } });
  assert.equal(rejection.status, 200);
  for (const actor of [household, official]) {
    assert.equal((await app.request(path, { actor })).status, 404);
    assert.equal((await app.request(path, { actor, method: 'POST', body: { message: 'Rejected request' } })).status, 404);
  }
  assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM request_messages').get().count, 0);
});

test('request chat validates message text and accepts the 2000-character boundary after trimming', async t => {
  const app = await fixture(t);
  const { household, official } = participants(app);
  const relief = await app.createRequest(household, official);
  const path = `/api/requests/${relief.id}/messages`;
  for (const message of [undefined, null, false, 1, {}, [], '', ' \n\t ', 'x'.repeat(2001)]) {
    const result = await app.request(path, { actor: household, method: 'POST', body: { message } });
    assert.equal(result.status, 400, JSON.stringify(message));
  }
  assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM request_messages').get().count, 0);
  const accepted = await app.request(path, { actor: household, method: 'POST', body: { message: `  ${'x'.repeat(2000)}\n` } });
  assert.equal(accepted.status, 201);
  assert.equal(accepted.data.message.message, 'x'.repeat(2000));
});

test('request messages notify only the opposite household or approved officials in the assigned barangay', async t => {
  const app = await fixture(t);
  const { household, official, donor } = participants(app);
  const secondOfficial = app.account('SECOND-OFFICIAL', 'BARANGAY_OFFICIAL');
  const otherOfficial = app.account('OTHER-OFFICIAL', 'BARANGAY_OFFICIAL', { barangay: 'Apas' });
  const pendingOfficial = app.account('PENDING-OFFICIAL', 'BARANGAY_OFFICIAL', { status: 'PENDING' });
  const admin = app.account('ADMIN', 'DSWS_ADMIN');
  const relief = await app.createRequest(household, official);
  app.db.prepare('DELETE FROM notifications').run();
  const path = `/api/requests/${relief.id}/messages`;
  await app.request(path, { actor: household, method: 'POST', body: { message: 'Where can we collect relief?' } });
  const recipients = app.db.prepare('SELECT user_id FROM notifications ORDER BY user_id').all().map(row => row.user_id);
  assert.deepEqual(recipients, [official.id, secondOfficial.id].sort());
  for (const actor of [official, secondOfficial]) {
    const inbox = await app.request('/api/notifications', { actor });
    assert.equal(inbox.data.unreadCount, 1);
    assert.equal(inbox.data.notifications[0].type, 'request_message');
    assert.equal(inbox.data.notifications[0].targetType, 'request_chat');
    assert.equal(inbox.data.notifications[0].targetId, relief.id);
  }
  await app.request(path, { actor: secondOfficial, method: 'POST', body: { message: 'Please come to the barangay hall at 2 PM.' } });
  const householdInbox = await app.request('/api/notifications', { actor: household });
  assert.equal(householdInbox.data.unreadCount, 1);
  assert.equal(householdInbox.data.notifications[0].type, 'request_message');
  assert.equal(householdInbox.data.notifications[0].targetType, 'request_chat');
  for (const actor of [donor, otherOfficial, pendingOfficial, admin]) {
    assert.deepEqual((await app.request('/api/notifications', { actor })).data.notifications, []);
  }
  assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM notifications').get().count, 3);
});

test('request pledge conversations connect only the donor and approved officials in the request barangay', async t => {
  const app = await fixture(t);
  const { household, official, donor } = participants(app);
  const secondOfficial = app.account('SECOND-OFFICIAL', 'BARANGAY_OFFICIAL');
  const otherDonor = app.account('OTHER-DONOR', 'DONOR', { barangay: null });
  const otherOfficial = app.account('OTHER-OFFICIAL', 'BARANGAY_OFFICIAL', { barangay: 'Apas' });
  const pendingOfficial = app.account('PENDING-OFFICIAL', 'BARANGAY_OFFICIAL', { status: 'PENDING' });
  const admin = app.account('ADMIN', 'DSWS_ADMIN');
  const relief = await app.createRequest(household, official);
  const pledge = await app.request('/api/donations', {
    actor: donor, method: 'POST',
    body: { requestId: relief.id, type: 'Food', amount: '400 packs of grocery' },
  });
  assert.equal(pledge.status, 201);
  const path = `/api/donations/${pledge.data.donation.id}/messages`;
  assert.deepEqual((await app.request(path, { actor: donor })).data.messages, []);

  const sent = await app.request(path, { actor: donor, method: 'POST', body: { message: 'The 400 packs are ready for delivery.' } });
  assert.equal(sent.status, 201);
  assert.equal(sent.data.message.senderId, donor.id);
  assert.equal((await app.request(path, { actor: official })).data.messages[0].message, 'The 400 packs are ready for delivery.');
  assert.equal((await app.request(path, { actor: secondOfficial })).status, 200);

  const reply = await app.request(path, { actor: official, method: 'POST', body: { message: 'Please deliver them to the barangay hall tomorrow.' } });
  assert.equal(reply.status, 201);
  assert.deepEqual((await app.request(path, { actor: donor })).data.messages.map(message => message.message), [
    'The 400 packs are ready for delivery.',
    'Please deliver them to the barangay hall tomorrow.',
  ]);

  for (const actor of [household, otherDonor, otherOfficial, pendingOfficial, admin]) {
    assert.equal((await app.request(path, { actor })).status, 404, `${actor.id} cannot read`);
    assert.equal((await app.request(path, { actor, method: 'POST', body: { message: 'Unauthorized' } })).status, 404, `${actor.id} cannot send`);
  }
  const donorNotifications = await app.request('/api/notifications', { actor: donor });
  const donorChatNotification = donorNotifications.data.notifications.find(item => item.targetType === 'chat');
  assert.equal(donorChatNotification?.targetId, pledge.data.donation.id);
  const officialNotifications = await app.request('/api/notifications', { actor: official });
  const officialChatNotification = officialNotifications.data.notifications.find(item => item.targetType === 'chat');
  assert.equal(officialChatNotification?.targetId, pledge.data.donation.id);
});

test('chat refreshes an expired pledge status while preserving its conversation', async t => {
  const app = await fixture(t);
  const { household, official, donor } = participants(app);
  const relief = await app.createRequest(household, official);
  const path = `/api/requests/${relief.id}/messages`;
  await app.request(path, { actor: household, method: 'POST', body: { message: 'Waiting for relief.' } });
  const pledge = await app.request('/api/donations', { actor: donor, method: 'POST', body: { requestId: relief.id, type: 'Food', amount: 'One food pack' } });
  assert.equal(pledge.status, 201);
  app.db.prepare('UPDATE donations SET expires_at = ? WHERE id = ?').run('2026-09-30T11:00:00.000Z', pledge.data.donation.id);
  const thread = await app.request(path, { actor: household });
  assert.equal(thread.status, 200);
  assert.equal(thread.data.request.status, 'Approved');
  assert.equal(thread.data.request.pledgedAt, null);
  assert.equal(thread.data.messages.length, 1);
});

test('request conversations, notifications, and per-sender rate limits survive a server restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ayuda-request-chat-test-'));
  const databasePath = join(directory, 'test.sqlite');
  const instances = [];
  t.after(async () => {
    for (const instance of instances) await instance.stop();
    const cleanupTarget = resolve(directory);
    assert.equal(dirname(cleanupTarget), resolve(tmpdir()), 'cleanup stays inside the temporary directory');
    assert.ok(basename(cleanupTarget).startsWith('ayuda-request-chat-test-'));
    await rm(cleanupTarget, { recursive: true, force: true });
  });
  const first = await fixture(t, { databasePath });
  instances.push(first);
  const { household, official } = participants(first);
  const relief = await first.createRequest(household, official);
  const path = `/api/requests/${relief.id}/messages`;
  for (let index = 0; index < 30; index++) {
    assert.equal((await first.request(path, { actor: household, method: 'POST', body: { message: `Message ${index}` } })).status, 201);
  }
  const limited = await first.request(path, { actor: household, method: 'POST', body: { message: 'Too many' } });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
  await first.stop();
  const restarted = await fixture(t, { databasePath });
  instances.push(restarted);
  const restored = await restarted.request(path, { actor: official });
  assert.equal(restored.status, 200);
  assert.deepEqual(restored.data.messages.map(message => message.message), Array.from({ length: 30 }, (_, index) => `Message ${index}`));
  const notifications = await restarted.request('/api/notifications', { actor: official });
  assert.equal(notifications.data.notifications.filter(notification => notification.type === 'request_message').length, 30);
  assert.equal((await restarted.request(path, { actor: household, method: 'POST', body: { message: 'Still limited' } })).status, 429);
  assert.equal((await restarted.request(path, { actor: official, method: 'POST', body: { message: 'Official can still reply' } })).status, 201);
  const separate = await restarted.createRequest(household, official);
  assert.equal((await restarted.request(`/api/requests/${separate.id}/messages`, { actor: household, method: 'POST', body: { message: 'Separate request' } })).status, 201);
  restarted.advance(60000);
  assert.equal((await restarted.request(path, { actor: household, method: 'POST', body: { message: 'Allowed after the rate window' } })).status, 201);
  assert.equal((await restarted.request(path, { actor: household })).data.messages.length, 32);
});
