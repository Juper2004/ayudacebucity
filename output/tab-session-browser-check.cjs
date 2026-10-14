'use strict';
// Same-cookie-jar browser regression check. Uses only an ephemeral origin,
// temporary Chrome profile, synthetic accounts, and an in-memory database.
// Run: node output/tab-session-browser-check.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { once } = require('node:events');
const { createServer } = require('node:http');
const { spawn } = require('node:child_process');
const { createApp } = require('../server/app.cjs');

const results = [], exceptions = [], requests = [], pending = new Map();
const password = 'Tab-session-test-938!';
const address = 'Synthetic household, Guadalupe, Cebu City, Philippines';
const accounts = {
  admin: { name: 'Tab Test DSWS', email: 'tabs-admin@example.test', role: 'DSWS_ADMIN', route: '#/dsws' },
  official: { name: 'Tab Test Official', email: 'tabs-official@example.test', role: 'BARANGAY_OFFICIAL', route: '#/barangay' },
  household: { name: 'Tab Test Household', email: 'tabs-household@example.test', role: 'HOUSEHOLD', route: '#/household' },
  alternate: { name: 'Tab Test Other Household', email: 'tabs-other@example.test', role: 'HOUSEHOLD', route: '#/household' }
};
let browser, backend, server, origin, profile, buffer = '', nextId = 0, stderr = '', providerCalls = 0;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const timeout = setTimeout(() => { console.error('Tab session browser verification timed out.'); browser?.kill(); process.exitCode = 1; }, 150000);

function cdp(method, params = {}, page) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method + '\n' + stderr)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    browser.stdio[3].write(JSON.stringify({ id, method, params, ...(page ? { sessionId: page.sessionId } : {}) }) + '\0');
  });
}
async function evaluate(page, expression) {
  const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, page);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
async function until(page, expression, label, milliseconds = 12000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    try { if (await evaluate(page, expression)) return; }
    catch (error) { if (!/ReferenceError|context.*destroyed|Cannot find context/i.test(error.message)) throw error; }
    await delay(60);
  }
  throw new Error('Timed out waiting for ' + label + ': ' + await evaluate(page, 'JSON.stringify({route:location.hash,text:document.body.innerText.slice(-700)})'));
}
async function check(label, action) {
  await action();
  results.push({ label, pass: true });
  console.log('PASS ' + label);
}
async function attach(targetId) {
  const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
  const page = { targetId, sessionId };
  await cdp('Page.enable', {}, page);
  await cdp('Runtime.enable', {}, page);
  await cdp('Network.enable', {}, page);
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1080, deviceScaleFactor: 1, mobile: false }, page);
  return page;
}
async function ready(page) {
  await until(page, 'typeof getTabSessionId === "function" && authState.ready', 'tab-isolated app startup');
}
async function newPage() {
  // Omitting browserContextId deliberately places all tabs in one cookie jar.
  const { targetId } = await cdp('Target.createTarget', { url: 'about:blank' });
  const page = await attach(targetId);
  await cdp('Page.navigate', { url: origin + '/#/login' }, page);
  await ready(page);
  return page;
}
async function login(page, account, suppliedPassword = password) {
  await evaluate(page, 'location.hash = "#/login"');
  await until(page, 'Boolean(document.getElementById("loginEmail"))', 'login form');
  await evaluate(page, `(() => {
    document.getElementById('loginEmail').value = ${JSON.stringify(account.email)};
    document.getElementById('loginPassword').value = ${JSON.stringify(suppliedPassword)};
    document.getElementById('loginEmail').form.requestSubmit();
  })()`);
  if (suppliedPassword !== password) {
    await until(page, 'Boolean(document.getElementById("loginEmail")) && !document.getElementById("loginEmail").form.dataset.busy && document.body.innerText.includes("Invalid email or password")', 'failed login response');
  } else {
    await until(page, `location.hash === ${JSON.stringify(account.route)} && session()?.email === ${JSON.stringify(account.email)} && Boolean(document.querySelector('.dashboard'))`, 'logged-in ' + account.role);
  }
}
async function identity(page, account) {
  const current = await evaluate(page, '(async () => { await refreshAuth(); return {memory:session()?.email || null, server:(await api("/api/auth/session")).user?.email || null}; })()');
  assert.deepEqual(current, { memory: account?.email || null, server: account?.email || null });
}
async function register(account, barangay) {
  const response = await fetch(origin + '/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...account, password, barangay, contact: '09171234567' })
  });
  assert.equal(response.status, 201, await response.clone().text());
  const { user } = await response.json();
  user.status = 'APPROVED';
  backend.db.prepare('UPDATE users SET profile = ? WHERE id = ?').run(JSON.stringify(user), user.id);
}
async function main() {
  server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = 'http://127.0.0.1:' + server.address().port;
  backend = await createApp({
    databasePath: ':memory:', appOrigin: origin, secureCookies: false,
    admin: { ...accounts.admin, password },
    geocoding: { fetch: async () => {
      providerCalls++;
      return new Response(JSON.stringify({ display_name: address }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } }
  });
  server.on('request', backend.app);
  await register(accounts.official, 'Guadalupe');
  await register(accounts.household, 'Guadalupe');
  await register(accounts.alternate, 'Lahug');

  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ayuda-tab-session-check-'));
  browser = spawn(process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
    '--headless=new', '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-extensions', '--disable-sync', '--disable-popup-blocking',
    '--disable-features=Translate,OptimizationHints,MediaRouter', '--user-data-dir=' + profile, 'about:blank'
  ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  browser.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  browser.on('error', error => { stderr += error.message; });
  browser.stdio[4].on('data', chunk => {
    buffer += chunk;
    let separator;
    while ((separator = buffer.indexOf('\0')) !== -1) {
      const raw = buffer.slice(0, separator); buffer = buffer.slice(separator + 1);
      if (!raw) continue;
      const message = JSON.parse(raw);
      if (pending.has(message.id)) {
        const entry = pending.get(message.id); pending.delete(message.id); clearTimeout(entry.timer);
        message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result || {});
      } else if (message.method === 'Runtime.exceptionThrown') {
        exceptions.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
      } else if (message.method === 'Network.requestWillBeSent') {
        const request = message.params.request;
        if (request.url.startsWith(origin + '/api/')) requests.push({
          sessionId: message.sessionId, path: new URL(request.url).pathname,
          tabId: Object.entries(request.headers).find(([key]) => key.toLowerCase() === 'x-ayuda-tab')?.[1]
        });
      }
    }
  });
  const pages = { admin: await newPage(), official: await newPage(), household: await newPage() };
  const ids = {};
  await check('DSWS, barangay, and household log in simultaneously through real forms in one cookie jar', async () => {
    for (const role of ['admin', 'official', 'household']) {
      await login(pages[role], accounts[role]);
      ids[role] = await evaluate(pages[role], 'sessionStorage.getItem("ayudaTabId")');
      assert.match(ids[role], /^[a-f0-9]{32}$/);
    }
    assert.equal(new Set(Object.values(ids)).size, 3);
    for (const role of Object.keys(pages)) await identity(pages[role], accounts[role]);
    const { cookies } = await cdp('Storage.getCookies');
    for (const id of Object.values(ids)) assert.ok(cookies.some(cookie => cookie.name === 'ayudaSession_' + id && cookie.httpOnly));
    assert.ok(!cookies.some(cookie => cookie.name === 'ayudaSession'));
    for (const page of Object.values(pages)) assert.equal(await evaluate(page, 'document.cookie.includes("ayudaSession")'), false);
  });
  await check('Focus and explicit account refresh preserve each tab identity', async () => {
    for (const role of Object.keys(pages)) {
      await cdp('Page.bringToFront', {}, pages[role]);
      await evaluate(pages[role], '(async () => { window.dispatchEvent(new Event("focus")); await refreshAccountState(); })()');
      await identity(pages[role], accounts[role]);
    }
  });
  await check('Automatic 30-second polling preserves all three accounts', async () => {
    const before = Object.fromEntries(Object.entries(pages).map(([role, page]) => [role, requests.filter(request => request.sessionId === page.sessionId && request.path === '/api/auth/session').length]));
    await delay(32000);
    for (const [role, page] of Object.entries(pages)) {
      const count = requests.filter(request => request.sessionId === page.sessionId && request.path === '/api/auth/session').length;
      assert.ok(count > before[role], role + ' performed its automatic session poll');
      await identity(page, accounts[role]);
    }
  });
  await check('Reload persists each selected account and tab identifier', async () => {
    for (const [role, page] of Object.entries(pages)) {
      await cdp('Page.reload', {}, page);
      await ready(page);
      await identity(page, accounts[role]);
      assert.equal(await evaluate(page, 'sessionStorage.getItem("ayudaTabId")'), ids[role]);
    }
  });
  await check('Role-specific account visibility and permissions stay scoped per tab', async () => {
    for (const [role, page] of Object.entries(pages)) {
      const emails = await evaluate(page, '(async () => (await api("/api/accounts")).users.map(user => user.email).sort())()');
      const expected = role === 'admin' ? Object.values(accounts).map(account => account.email) : role === 'official' ? [accounts.official.email, accounts.household.email] : [accounts.household.email];
      assert.deepEqual(emails, expected.sort());
      const status = await evaluate(page, '(async () => { try { await api("/api/accounts/officials", {}); return 200; } catch(error) { return error.status; } })()');
      assert.equal(status, role === 'admin' ? 400 : 403);
    }
  });
  await check('Household precise-location UI sends its tab selector to the direct reverse-geocoding fetch', async () => {
    const page = pages.household;
    await cdp('Browser.grantPermissions', { origin, permissions: ['geolocation'] });
    await cdp('Emulation.setGeolocationOverride', { latitude: 10.302076, longitude: 123.860442, accuracy: 8 }, page);
    await evaluate(page, 'location.hash = "#/household/request"');
    await until(page, 'Boolean(document.getElementById("reqLocationButton"))', 'household request form');
    await evaluate(page, 'document.getElementById("reqLocationButton").click()');
    await until(page, `document.getElementById('reqLocation')?.value === ${JSON.stringify(address)}`, 'mocked nearby address');
    assert.equal(providerCalls, 1);
    assert.ok(requests.some(request => request.path === '/api/location/reverse' && request.tabId === ids.household));
    await identity(pages.admin, accounts.admin);
    await identity(pages.official, accounts.official);
  });
  const fresh = await newPage();
  await check('A newly opened tab starts logged out while existing tabs stay signed in', async () => {
    await identity(fresh, null);
    const id = await evaluate(fresh, 'sessionStorage.getItem("ayudaTabId")');
    assert.ok(!Object.values(ids).includes(id));
    for (const role of Object.keys(pages)) await identity(pages[role], accounts[role]);
  });
  await check('Failed UI login preserves current and other tab sessions', async () => {
    await login(pages.household, accounts.admin, 'Incorrect-password-938!');
    await identity(pages.household, accounts.household);
    await identity(pages.admin, accounts.admin);
    await identity(pages.official, accounts.official);
    await login(fresh, accounts.admin, 'Incorrect-password-938!');
    await identity(fresh, null);
    await identity(pages.admin, accounts.admin);
  });
  await check('Switching one tab to another account preserves the other two accounts', async () => {
    await login(pages.household, accounts.alternate);
    await identity(pages.household, accounts.alternate);
    assert.equal(await evaluate(pages.household, 'sessionStorage.getItem("ayudaTabId")'), ids.household);
    await identity(pages.admin, accounts.admin);
    await identity(pages.official, accounts.official);
  });
  await check('window.open copied sessionStorage receives a new selector and stays logged out', async () => {
    const opened = await evaluate(pages.admin, 'Boolean(window.open("about:blank", "tab-session-child"))');
    assert.equal(opened, true);
    let childTarget;
    for (let attempt = 0; attempt < 50 && !childTarget; attempt++) {
      const { targetInfos } = await cdp('Target.getTargets');
      childTarget = targetInfos.find(target => target.openerId === pages.admin.targetId && target.type === 'page');
      if (!childTarget) await delay(50);
    }
    assert.ok(childTarget, 'popup target has the original tab as opener');
    const child = await attach(childTarget.targetId);
    assert.equal(await evaluate(child, 'sessionStorage.getItem("ayudaTabId")'), ids.admin, 'browser actually copied opener sessionStorage');
    await cdp('Page.navigate', { url: origin + '/#/dsws' }, child);
    await ready(child);
    await identity(child, null);
    assert.notEqual(await evaluate(child, 'sessionStorage.getItem("ayudaTabId")'), ids.admin);
    await identity(pages.admin, accounts.admin);
    await identity(pages.official, accounts.official);
    await identity(pages.household, accounts.alternate);
  });
  await check('Logging out removes only the current tab session', async () => {
    await evaluate(pages.official, 'logout()');
    await until(pages.official, 'session() === null && location.hash === "#/login"', 'official logout');
    await identity(pages.official, null);
    await identity(pages.admin, accounts.admin);
    await identity(pages.household, accounts.alternate);
    const { cookies } = await cdp('Storage.getCookies');
    assert.ok(!cookies.some(cookie => cookie.name === 'ayudaSession_' + ids.official));
    assert.ok(cookies.some(cookie => cookie.name === 'ayudaSession_' + ids.admin));
    assert.ok(cookies.some(cookie => cookie.name === 'ayudaSession_' + ids.household));
  });
  await check('All frontend API requests carry a valid selector and no runtime exception occurred', async () => {
    assert.ok(requests.length > 30);
    assert.ok(requests.every(request => /^[a-f0-9]{32}$/.test(request.tabId || '')), JSON.stringify(requests.filter(request => !request.tabId)));
    assert.deepEqual(exceptions, []);
  });
}

main().catch(error => {
  results.push({ label: 'Browser regression failure', pass: false, error: error.stack });
  console.error(error.stack);
  process.exitCode = 1;
}).finally(async () => {
  const report = { checkedAt: new Date().toISOString(), passed: results.filter(result => result.pass).length, failed: results.filter(result => !result.pass).length, providerCalls, apiRequests: requests.length, results, exceptions };
  fs.writeFileSync(path.join(__dirname, 'tab-session-browser-results.json'), JSON.stringify(report, null, 2));
  if (browser) { try { await cdp('Browser.close'); } catch { browser.kill(); } }
  clearTimeout(timeout);
  if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  if (backend) await backend.close();
  console.log(JSON.stringify({ passed: report.passed, failed: report.failed, providerCalls }));
});
