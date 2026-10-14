'use strict';
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { once } = require('node:events');
const test = require('node:test');
const { createApp } = require('../server/app.cjs');
const { digest } = require('../server/security.cjs');
const { createGeocoder, validCoordinates } = require('../server/geocoding.cjs');

const COORDINATES = { latitude: 10.302076, longitude: 123.860442 };
const ORIGIN = 'http://localhost:3000';
function providerResponse(address = 'Guadalupe, Cebu City, Philippines') {
  return new Response(JSON.stringify({ display_name: address }), { headers: { 'Content-Type': 'application/json' } });
}

async function fixture(t, options = {}) {
  let timestamp = Date.now();
  const calls = [];
  const backend = await createApp({
    appOrigin: ORIGIN,
    clock: () => timestamp,
    geocoding: {
      clock: () => timestamp,
      requestGate: { nextAllowedAt: 0, busy: false },
      fetch: async (url, request) => { calls.push({ url, request }); return providerResponse(); },
      ...options
    }
  });
  const server = backend.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await backend.close();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  });

  function account(role = 'HOUSEHOLD', status = 'APPROVED') {
    const id = randomUUID();
    const token = randomBytes(32).toString('hex');
    const user = { id, role, status, name: 'Location Test', email: `${id}@example.test` };
    backend.db.prepare('INSERT INTO users (id, email, password_hash, profile) VALUES (?, ?, ?, ?)')
      .run(id, user.email, 'not-used-by-this-session-test', JSON.stringify(user));
    backend.db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .run(digest(token), id, timestamp + 86400000);
    return `ayudaSession=${token}`;
  }
  async function request(cookie, body = COORDINATES, headers = {}) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/location/reverse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: JSON.stringify(body)
    });
    return { status: response.status, headers: response.headers, data: await response.json() };
  }
  return { account, request, calls, resource: resourcePath => fetch(`http://127.0.0.1:${server.address().port}${resourcePath}`), advance(ms) { timestamp += ms; } };
}

function service(t, options = {}) {
  let timestamp = 10000;
  const calls = [];
  const geocoder = createGeocoder({
    appOrigin: 'https://ayuda.example.test',
    clock: () => timestamp,
    requestGate: { nextAllowedAt: 0, busy: false },
    fetch: async (url, request) => { calls.push({ url, request }); return providerResponse(); },
    ...options
  });
  t.after(() => geocoder.close());
  return { ...geocoder, calls, advance(ms) { timestamp += ms; } };
}

test('reverse geocoding requires an approved household session and a same-origin request', async t => {
  const app = await fixture(t);
  assert.equal((await app.request()).status, 401);
  for (const [role, status] of [['HOUSEHOLD', 'PENDING'], ['HOUSEHOLD', 'REJECTED'], ['DONOR', 'APPROVED'], ['DSWS_ADMIN', 'APPROVED']]) {
    assert.equal((await app.request(app.account(role, status))).status, 403);
  }
  const response = await app.request(app.account(), COORDINATES, { Origin: 'https://another.example.test' });
  assert.equal(response.status, 403);
  assert.equal(app.calls.length, 0);
});

test('reverse geocoding rejects nonnumeric, nonfinite and out-of-range coordinates before contacting the provider', async t => {
  const app = await fixture(t);
  const cookie = app.account();
  for (const body of [{}, { ...COORDINATES, latitude: '10.3' }, { ...COORDINATES, latitude: 90.1 },
    { ...COORDINATES, longitude: -180.1 }, { ...COORDINATES, latitude: null }, { ...COORDINATES, longitude: false }]) {
    assert.equal((await app.request(cookie, body)).status, 400, JSON.stringify(body));
  }
  assert.equal(validCoordinates(Infinity, 0), false);
  assert.equal(validCoordinates(0, NaN), false);
  assert.equal(validCoordinates(-90, 180), true);
  assert.equal(validCoordinates(90, -180), true);
  assert.equal(app.calls.length, 0);
});

test('the same-origin endpoint returns only the address and preserves the restrictive CSP', async t => {
  const app = await fixture(t);
  const response = await app.request(app.account());
  assert.equal(response.status, 200);
  assert.deepEqual(response.data, { address: 'Guadalupe, Cebu City, Philippines' });
  assert.match(response.headers.get('Content-Security-Policy'), /connect-src 'self';/);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const { url, request } = app.calls[0];
  assert.equal(url.origin, 'https://nominatim.openstreetmap.org');
  assert.equal(url.searchParams.get('lat'), String(COORDINATES.latitude));
  assert.equal(url.searchParams.get('lon'), String(COORDINATES.longitude));
  assert.match(request.headers['User-Agent'], /AYUDA-Cebu\/1\.0/);
  assert.equal(request.redirect, 'error');
});

test('the map serves only its local vendor assets and allows only the designated tile host', async t => {
  const app = await fixture(t);
  for (const [asset, type, content] of [
    ['leaflet.js', /javascript/, /Leaflet 1\.9\.4/],
    ['leaflet.css', /text\/css/, /\.leaflet-container/]
  ]) {
    const response = await app.resource(`/vendor/leaflet/${asset}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('Content-Type'), type);
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
    const policy = response.headers.get('Content-Security-Policy');
    assert.equal(policy.split(';').map(part => part.trim()).find(part => part.startsWith('img-src ')),
      "img-src 'self' data: blob: https://tile.openstreetmap.org");
    assert.match(policy, /connect-src 'self';/);
    assert.match(policy, /script-src 'self' 'unsafe-inline';/);
    assert.match(await response.text(), content);
  }
  for (const resource of ['/node_modules/leaflet/package.json', '/vendor/leaflet/package.json', '/vendor/leaflet/leaflet-src.js']) {
    assert.equal((await app.resource(resource)).status, 404, resource);
  }
  assert.equal(app.calls.length, 0);
});

test('cached lookups avoid provider traffic while per-household limits still apply', async t => {
  const app = await fixture(t);
  const cookie = app.account();
  for (let i = 0; i < 20; i++) assert.equal((await app.request(cookie)).status, 200);
  const limited = await app.request(cookie);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('Retry-After')) > 0);
  assert.equal((await app.request(app.account())).status, 200, 'a different household has its own allowance');
  assert.equal(app.calls.length, 1);
  app.advance(10 * 60000);
  assert.equal((await app.request(cookie)).status, 200, 'the household allowance resets');
  assert.equal(app.calls.length, 1, 'the memory cache remains valid');
});

test('different households share a provider throttle and receive Retry-After', async t => {
  const app = await fixture(t);
  const first = app.account();
  const second = app.account();
  assert.equal((await app.request(first)).status, 200);
  const nextCoordinates = { latitude: 10.31, longitude: 123.9 };
  const limited = await app.request(second, nextCoordinates);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('Retry-After')) >= 1);
  assert.equal(app.calls.length, 1);
  app.advance(1100);
  assert.equal((await app.request(second, nextCoordinates)).status, 200);
  assert.equal(app.calls.length, 2);
});

test('address length is bounded, missing addresses remain usable and provider configuration is switchable', async t => {
  const geocoder = service(t, {
    reverseUrl: 'https://geocoding.example.test/custom/reverse?key=example',
    userAgent: 'AYUDA-Cebu/1.0 (contact: operator@example.test)',
    fetch: async (url, request) => {
      assert.equal(url.pathname, '/custom/reverse');
      assert.equal(url.searchParams.get('key'), 'example');
      assert.equal(request.headers['User-Agent'], 'AYUDA-Cebu/1.0 (contact: operator@example.test)');
      return providerResponse('  ' + 'A'.repeat(600));
    }
  });
  assert.equal((await geocoder.reverse(10, 123)).length, 500);
  const empty = service(t, { fetch: async () => providerResponse(null) });
  assert.equal(await empty.reverse(10, 123), '');
  const absent = service(t, { fetch: async () => new Response('', { status: 404 }) });
  assert.equal(await absent.reverse(10, 123), '');
});

test('upstream failures are safe, are not cached and do not disclose provider errors', async t => {
  for (const fetchProvider of [async () => { throw new Error('private provider details'); },
    async () => new Response('private provider details', { status: 500 }),
    async () => new Response('private provider details')]) {
    let attempts = 0;
    const app = await fixture(t, { fetch: async (...args) => { attempts++; return fetchProvider(...args); } });
    const cookie = app.account();
    const first = await app.request(cookie);
    assert.equal(first.status, 503);
    assert.doesNotMatch(JSON.stringify(first.data), /private provider details/);
    app.advance(1100);
    assert.equal((await app.request(cookie)).status, 503);
    assert.equal(attempts, 2);
  }
});

test('lookup timeout includes reading the response body and aborts the upstream request', async t => {
  let signal;
  const app = await fixture(t, {
    timeoutMs: 25,
    fetch: async (url, request) => {
      signal = request.signal;
      return { ok: true, status: 200, json: () => new Promise(() => {}) };
    }
  });
  const response = await app.request(app.account());
  assert.equal(response.status, 504);
  assert.match(response.data.message, /timed out/);
  assert.equal(signal.aborted, true);
});

test('the provider cache expires and remains bounded', async t => {
  const geocoder = service(t);
  assert.ok(await geocoder.reverse(0, 0));
  assert.ok(await geocoder.reverse(0, 0));
  assert.equal(geocoder.calls.length, 1);
  geocoder.advance(24 * 60 * 60 * 1000);
  await geocoder.reverse(0, 0);
  assert.equal(geocoder.calls.length, 2, 'expired cached addresses are fetched again');
  for (let index = 1; index <= 500; index++) {
    geocoder.advance(1100);
    await geocoder.reverse(index / 1000, 0);
  }
  geocoder.advance(1100);
  await geocoder.reverse(0, 0);
  assert.equal(geocoder.calls.length, 503, 'the oldest entry is evicted when the cache reaches capacity');
});

test('closing the geocoder immediately aborts an in-flight request and prevents new requests', async t => {
  let signal;
  const geocoder = service(t, { fetch: async (url, request) => { signal = request.signal; return new Promise(() => {}); } });
  const lookup = geocoder.reverse(10, 123);
  const rejected = assert.rejects(lookup, error => error.status === 503);
  await Promise.resolve();
  geocoder.close();
  await rejected;
  assert.equal(signal.aborted, true);
  await assert.rejects(geocoder.reverse(11, 123), error => error.status === 503);
});

test('separate app geocoders share the process-wide provider gate, including concurrent lookups', async t => {
  let timestamp = Date.now() + 86400000;
  let finish;
  const first = createGeocoder({ clock: () => timestamp, fetch: async () => new Promise(resolve => { finish = resolve; }) });
  const second = createGeocoder({ clock: () => timestamp, fetch: async () => providerResponse() });
  t.after(() => { first.close(); second.close(); });
  const lookup = first.reverse(10, 123);
  await Promise.resolve();
  timestamp += 1500;
  await assert.rejects(second.reverse(11, 123), error => error.status === 429, 'only one provider request may be in flight');
  finish(providerResponse());
  await lookup;
  assert.ok(await second.reverse(11, 123));
  await assert.rejects(first.reverse(12, 123), error => error.status === 429, 'instances also share spacing after completion');
});
