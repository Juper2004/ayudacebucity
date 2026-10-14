'use strict';
// Isolated donor consolidation regression. Uses in-memory accounts and a temporary
// Chrome profile; never reads .env or touches the user's browser records.
// Run: node output/donor-consolidation-browser-check.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { createApp } = require('../server/app.cjs');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ayuda-donor-consolidation-'));
const results = [], exceptions = [], pending = new Map();
let browser, backend, server, sessionId, nextId = 0, buffer = '', stderr = '';
const email = 'donor-consolidation@example.test', password = 'Synthetic-donor-password-938!';
const now = new Date().toISOString();
const requests = Array.from({ length: 20 }, (_, index) => ({
  id: 'REQ-CONS-' + String(index + 1).padStart(3, '0'),
  householdId: 'HH-CONS-' + (index + 1), household: 'Consolidation Household ' + (index + 1),
  barangay: 'Apas', category: 'Food', disaster: index < 10 ? 'Flood' : 'Typhoon',
  urgency: index === 0 ? 'Urgent' : index % 2 ? 'Low' : 'Medium',
  status: index < 10 ? 'Approved' : 'Under Verification',
  description: 'Synthetic food request from household ' + (index + 1) + '.',
  contact: '09171234567', location: 'Synthetic household address', gps: 'Not provided',
  photos: [], createdAt: now
}));
const extraRequests = [
  { ...requests[0], id: 'REQ-CONS-WATER', householdId: 'HH-WATER', category: 'Water' },
  { ...requests[0], id: 'REQ-CONS-LAHUG', householdId: 'HH-LAHUG', barangay: 'Lahug' }
];

function cdp(method, params = {}, browserCommand = false) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method + '\n' + stderr)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    browser.stdio[3].write(JSON.stringify({ id, method, params, ...(!browserCommand && sessionId ? { sessionId } : {}) }) + '\0');
  });
}
async function evaluate(expression) {
  const value = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description || value.exceptionDetails.text);
  return value.result.value;
}
async function until(expression, label) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const value = await evaluate(expression);
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error('Timed out waiting for ' + label);
}
async function settle() {
  await evaluate(`(async () => {
    await document.fonts.ready;
    for (const animation of document.getAnimations()) {
      if (Number.isFinite(animation.effect?.getComputedTiming().endTime)) {
        try { animation.finish(); } catch {}
      }
    }
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  })()`);
}
async function check(label, action) {
  try {
    await action(); results.push({ label, pass: true }); console.log('PASS ' + label);
  } catch (error) {
    results.push({ label, pass: false, error: error.stack }); console.error('FAIL ' + label + '\n' + error.stack);
  }
}
async function seed(records = requests, donations = []) {
  assert.equal(await evaluate(`commitRecords({ requests: ${JSON.stringify(records)}, donations: ${JSON.stringify(donations)} })`), true);
  await go('browse');
  // Remove feedback left by a previous independent synthetic fixture.
  await evaluate(`document.querySelector('.toast')?.remove(); if (!storageWarnings.size) document.getElementById('storageNotice')?.remove();`);
}
async function go(tab) {
  await evaluate(`closeModal(); location.hash = '#/donor/${tab}'; render();`);
  await settle();
}
async function openGroup(barangay = 'Apas', category = 'Food') {
  await evaluate(`openDonorGroup(${JSON.stringify(barangay)}, ${JSON.stringify(category)})`);
  await until(`!!document.querySelector('.donor-group-dialog')`, 'group details');
  await settle();
}
async function screenshot(name) {
  await settle();
  const shot = await cdp('Page.captureScreenshot', { format: 'png', fromSurface: true });
  fs.writeFileSync(path.join(__dirname, name + '.png'), Buffer.from(shot.data, 'base64'));
}
async function viewport(width) {
  await cdp('Emulation.setDeviceMetricsOverride', { width, height: 950, deviceScaleFactor: 1, mobile: width < 600 });
  await settle();
}
async function assertLayout(label) {
  const dimensions = await evaluate(`(() => {
    const dialog = document.querySelector('[role="dialog"]');
    const box = dialog?.getBoundingClientRect();
    return { width: innerWidth, page: document.documentElement.scrollWidth,
      dialog: dialog && { left: box.left, right: box.right, client: dialog.clientWidth, scroll: dialog.scrollWidth } };
  })()`);
  assert.ok(dimensions.page <= dimensions.width + 1, label + ' page overflow: ' + JSON.stringify(dimensions));
  if (dimensions.dialog) {
    assert.ok(dimensions.dialog.left >= -1 && dimensions.dialog.right <= dimensions.width + 1, label + ' dialog viewport fit');
    assert.ok(dimensions.dialog.scroll <= dimensions.dialog.client + 1, label + ' dialog overflow: ' + JSON.stringify(dimensions));
  }
}

async function main() {
  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const origin = 'http://127.0.0.1:' + port;
  backend = await createApp({ databasePath: ':memory:', appOrigin: origin, secureCookies: false,
    otpSecret: 'donor-consolidation-test-secret-0123456789abcdef' });
  server = backend.app.listen(port, '127.0.0.1'); await once(server, 'listening');
  const registration = await fetch(origin + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Synthetic Community Donor', email, password, role: 'DONOR' }) });
  assert.equal(registration.status, 201);
  browser = spawn(process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
    '--headless=new', '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-extensions', '--disable-sync',
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
        const handler = pending.get(message.id); pending.delete(message.id); clearTimeout(handler.timer);
        message.error ? handler.reject(new Error(JSON.stringify(message.error))) : handler.resolve(message.result || {});
      } else if (message.method === 'Runtime.exceptionThrown') {
        exceptions.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
      }
    }
  });
  const target = await cdp('Target.createTarget', { url: 'about:blank' }, true);
  sessionId = (await cdp('Target.attachToTarget', { targetId: target.targetId, flatten: true }, true)).sessionId;
  await cdp('Page.enable'); await cdp('Runtime.enable'); await viewport(1440);
  await cdp('Page.navigate', { url: origin });
  await until('typeof refreshAuth === "function" && authState.ready', 'application');
  await evaluate(`(async () => { await api('/api/auth/login', ${JSON.stringify({ email, password })}); await refreshAuth(); })()`);

  await check('20 households requesting Food in Apas consolidate into one card without changing stored requests', async () => {
    await seed();
    assert.equal(await evaluate(`document.querySelectorAll('#browseList .donor-request-card').length`), 1);
    const card = await evaluate(`document.querySelector('#browseList .donor-request-card').textContent`);
    assert.match(card, /20\s+households/i); assert.match(card, /20\s+requests/i);
    assert.match(card, /10\s+approved/i); assert.match(card, /10\s+(?:under verification|pending)/i);
    assert.match(card, /Urgent/); assert.match(card, /Flood/); assert.match(card, /Typhoon/);
    assert.deepEqual(await evaluate('getRequests()'), requests);
    await screenshot('donor-consolidation-browse-1440');
  });
  await check('Different barangays and categories stay separate and both filters apply together', async () => {
    await seed([...requests, ...extraRequests]);
    assert.equal(await evaluate(`document.querySelectorAll('#browseList .donor-request-card').length`), 3);
    await evaluate(`document.getElementById('filterBarangay').value='Apas'; document.getElementById('filterBarangay').dispatchEvent(new Event('change'));`);
    assert.equal(await evaluate(`document.querySelectorAll('#browseList .donor-request-card').length`), 2);
    await evaluate(`document.getElementById('filterCategory').value='Food'; document.getElementById('filterCategory').dispatchEvent(new Event('change'));`);
    assert.equal(await evaluate(`document.querySelectorAll('#browseList .donor-request-card').length`), 1);
    assert.match(await evaluate(`document.getElementById('browseList').textContent`), /20\s+households/i);
    await evaluate(`document.getElementById('filterBarangay').value='Lahug'; renderBrowse();`);
    assert.equal(await evaluate(`document.querySelectorAll('#browseList .donor-request-card').length`), 1);
    assert.match(await evaluate(`document.getElementById('browseList').textContent`), /1\s+household/i);
    await evaluate(`document.getElementById('filterCategory').value='Medical'; renderBrowse();`);
    assert.equal(await evaluate(`document.querySelectorAll('#browseList .donor-request-card').length`), 0);
    assert.match(await evaluate(`document.getElementById('browseList').textContent`), /No .*match/i);
  });
  await check('Case and whitespace variants consolidate, while ineligible statuses are excluded', async () => {
    const variants = [requests[0], { ...requests[1], barangay: ' apas ', category: ' food ' },
      ...['Pledged', 'Fulfilled', 'Rejected'].map((status, index) => ({ ...requests[index + 2], status }))];
    const visible = await evaluate(`(() => { const input=${JSON.stringify(variants)}; const preview=document.createElement('div'); preview.innerHTML=browseList(input); return { groups:groupDonorRequests(input).length, html:preview.textContent }; })()`);
    assert.equal(visible.groups, 1); assert.match(visible.html, /2\s+households/i); assert.match(visible.html, /2\s+requests/i);
    assert.equal(await evaluate(`groupDonorRequests(${JSON.stringify(variants)}, {barangay:'APAS',category:'Food'}).length`), 1);
  });
  await check('Repeated household requests and unidentified records do not inflate the known household count', async () => {
    const repeated = [...requests, { ...requests[0], id: 'REQ-CONS-DUPLICATE' },
      { ...requests[0], id: 'REQ-CONS-UNKNOWN', householdId: null }];
    await seed(repeated);
    const card = await evaluate(`document.querySelector('#browseList .donor-request-card').textContent`);
    assert.match(card, /20\s+identified households/i); assert.match(card, /22\s+requests/i);
    assert.match(card, /1\s+request has no household identification/i);
  });
  await check('Overview uses the same community groups and metric', async () => {
    await seed([...requests, ...extraRequests]); await go('overview');
    assert.equal(await evaluate(`document.querySelectorAll('.donor-request-card').length`), 3);
    assert.match(await evaluate(`document.querySelector('.dsws-metrics').textContent`), /3\s*Community needs/i);
    await screenshot('donor-consolidation-overview-1440');
  });
  await check('View requests opens all 20 members and Details opens the actual selected request', async () => {
    await seed();
    await evaluate(`document.querySelector('#browseList .donor-request-card .btn-primary').click()`);
    await until(`document.querySelectorAll('.donor-group-member').length===20`, '20 group members');
    assert.match(await evaluate(`document.querySelector('.donor-group-dialog').textContent`), /REQ-CONS-001/);
    const selected = await evaluate(`(() => { const row=[...document.querySelectorAll('.donor-group-member')].find(row=>row.textContent.includes('REQ-CONS-007')); [...row.querySelectorAll('button')].find(button=>button.textContent.trim()==='Details').click(); return document.querySelector('[role="dialog"]').textContent; })()`);
    assert.match(selected, /REQ-CONS-007/); assert.match(selected, /Consolidation Household 7/);
    assert.match(selected, /Synthetic food request from household 7\./);
    await evaluate(`document.querySelector('.donor-group-back').click()`);
    assert.equal(await evaluate(`document.querySelectorAll('.donor-group-member').length`), 20);
  });
  await check('Pledging one approved member updates only that request and leaves 19 grouped members', async () => {
    await seed(); await openGroup();
    await evaluate(`(() => { const row=[...document.querySelectorAll('.donor-group-member')].find(row=>row.textContent.includes('REQ-CONS-001')); [...row.querySelectorAll('button')].find(button=>button.textContent.trim()==='Pledge support').click(); })()`);
    assert.match(await evaluate(`document.querySelector('[role="dialog"]').textContent`), /REQ-CONS-001/);
    await evaluate(`document.getElementById('pledgeAmount').value='2 family food packs'; document.getElementById('pledgeAmount').form.requestSubmit();`);
    const state = await evaluate(`({requests:getRequests(), donations:getDonations(), card:document.querySelector('#browseList .donor-request-card')?.textContent})`);
    assert.equal(state.donations.length, 1); assert.equal(state.donations[0].requestId, 'REQ-CONS-001');
    assert.equal(state.requests.find(request => request.id === 'REQ-CONS-001').status, 'Pledged');
    assert.deepEqual(state.requests.filter(request => request.id !== 'REQ-CONS-001'), requests.slice(1));
    assert.match(state.card, /19\s+households/i); assert.match(state.card, /19\s+requests/i);
    await openGroup(); assert.equal(await evaluate(`document.querySelectorAll('.donor-group-member').length`), 19);
  });
  await check('Pledging a pending member preserves verification and other group members', async () => {
    await seed(); await openGroup();
    await evaluate(`(() => { const row=[...document.querySelectorAll('.donor-group-member')].find(row=>row.textContent.includes('REQ-CONS-020')); [...row.querySelectorAll('button')].find(button=>button.textContent.trim()==='Pledge support').click(); document.getElementById('pledgeAmount').value='Pending household food packs'; document.getElementById('pledgeAmount').form.requestSubmit(); })()`);
    assert.equal(await evaluate(`getRequests().find(request=>request.id==='REQ-CONS-020').status`), 'Under Verification');
    assert.equal(await evaluate('getDonations().length'), 1);
    assert.match(await evaluate(`document.querySelector('#browseList .donor-request-card').textContent`), /20\s+households/i);
  });
  for (const width of [390, 320]) {
    await check('Browse, group details, and pledge dialog fit a ' + width + 'px viewport', async () => {
      await seed(); await viewport(width); await assertLayout('Browse');
      await screenshot('donor-consolidation-browse-' + width);
      await openGroup(); await assertLayout('Group');
      await screenshot('donor-consolidation-group-' + width);
      await evaluate(`document.querySelector('.donor-group-member .btn-primary').click()`);
      await settle(); await assertLayout('Pledge');
      await screenshot('donor-consolidation-pledge-' + width);
    });
  }
  await check('No unhandled browser exceptions', async () => assert.deepEqual(exceptions, []));
}

const deadline = setTimeout(() => { console.error('Donor consolidation verification exceeded 3 minutes'); browser?.kill(); process.exitCode = 1; }, 180000);
main().catch(error => { results.push({ label: 'Harness setup', pass: false, error: error.stack }); console.error(error); }).finally(async () => {
  clearTimeout(deadline);
  for (const handler of pending.values()) clearTimeout(handler.timer);
  if (browser) { try { await cdp('Browser.close', {}, true); } catch {} browser.kill(); }
  if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); });
  await backend?.close();
  const report = { passed: results.filter(result => result.pass).length, failed: results.filter(result => !result.pass).length, results, exceptions };
  fs.writeFileSync(path.join(__dirname, 'donor-consolidation-browser-results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, failed: report.failed }));
  const resolved = path.resolve(profile);
  if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('ayuda-donor-consolidation-')) {
    try { fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
  }
  if (report.failed) process.exitCode = 1;
});
