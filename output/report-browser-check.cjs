// Isolated report export verification; never loads the project's .env or persistent database.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { createApp } = require('../server/app.cjs');

const output = path.resolve(__dirname);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ayuda-report-check-'));
const downloads = path.join(profile, 'downloads');
fs.mkdirSync(downloads);
const results = [], errors = [], downloaded = [], vendorResponses = [];
let chrome, backend, server, sessionId, buffer = '', stderr = '', nextId = 0;
const pending = new Map();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function check(condition, label) {
  assert.ok(condition, label);
  results.push(label);
  console.log('PASS ' + label);
}
function cdp(method, params = {}, useSession = true) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method + '\n' + stderr)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    chrome.stdio[3].write(JSON.stringify({ id, method, params, ...(useSession && sessionId ? { sessionId } : {}) }) + '\0');
  });
}
async function evaluate(expression) {
  const response = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  return response.result.value;
}
async function waitFor(expression) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if (await evaluate(expression)) return; }
    catch (error) {
      if (!/ReferenceError|context.*destroyed|Cannot find context/i.test(error.message)) throw error;
    }
    await delay(100);
  }
  throw new Error('Browser wait timed out: ' + expression);
}
async function settle() {
  await evaluate('(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); for (const animation of document.getAnimations()) { if (Number.isFinite(animation.effect?.getComputedTiming().endTime)) animation.finish(); } })()');
}
async function screenshot(name) {
  await settle();
  const shot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, fromSurface: true });
  fs.writeFileSync(path.join(output, name), Buffer.from(shot.data, 'base64'));
}

(async () => {
  try {
    server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    backend = await createApp({
      databasePath: ':memory:', appOrigin: origin,
      admin: { name: 'PDF Verification Admin', email: 'pdf-admin@example.test', password: 'Test-Pdf-Admin-938!' },
      otpSecret: 'isolated-report-verification-secret',
    });
    server.on('request', backend.app);
    chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
      '--headless=new', '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check',
      '--disable-background-networking', '--disable-component-update', '--disable-extensions', '--disable-sync',
      '--disable-features=Translate,OptimizationHints,MediaRouter', '--hide-scrollbars',
      '--user-data-dir=' + profile, 'about:blank',
    ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
    await once(chrome, 'spawn');
    chrome.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-3000); });
    chrome.stdio[4].on('data', chunk => {
      buffer += chunk.toString();
      let separator;
      while ((separator = buffer.indexOf('\0')) !== -1) {
        const raw = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 1);
        if (!raw) continue;
        const message = JSON.parse(raw);
        if (message.id && pending.has(message.id)) {
          const handler = pending.get(message.id);
          pending.delete(message.id); clearTimeout(handler.timer);
          message.error ? handler.reject(new Error(JSON.stringify(message.error))) : handler.resolve(message.result || {});
        } else if (message.method === 'Runtime.exceptionThrown') {
          errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
        } else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
          errors.push(message.params.args.map(arg => arg.value || arg.description).join(' '));
        } else if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error' && !message.params.entry.url?.endsWith('/favicon.ico')) {
          errors.push(message.params.entry.text);
        } else if (message.method === 'Browser.downloadWillBegin') {
          downloaded.push(message.params);
        } else if (message.method === 'Network.responseReceived' && message.params.response.url.includes('/vendor/')) {
          vendorResponses.push({ url: message.params.response.url, status: message.params.response.status });
        }
      }
    });
    const target = await cdp('Target.createTarget', { url: 'about:blank' }, false);
    sessionId = (await cdp('Target.attachToTarget', { targetId: target.targetId, flatten: true }, false)).sessionId;
    await cdp('Runtime.enable');
    await cdp('Page.enable');
    await cdp('Network.enable');
    await cdp('Log.enable');
    await cdp('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true }, false);
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1080, deviceScaleFactor: 1, mobile: false });
    await cdp('Page.navigate', { url: origin + '/#/login' });
    await waitFor('authState.ready && Boolean(document.getElementById("loginEmail"))');
    await evaluate('exportReport()');
    check(await evaluate('!window.jspdf && !reportExporting'), 'Anonymous export is rejected before PDF libraries load');
    check(downloaded.length === 0, 'Anonymous export creates no download');

    await evaluate('document.getElementById("loginEmail").value = "pdf-admin@example.test"; document.getElementById("loginPassword").value = "Test-Pdf-Admin-938!"; document.getElementById("loginEmail").form.requestSubmit()');
    await waitFor('session()?.role === "DSWS_ADMIN" && Boolean(document.querySelector(".dashboard"))');
    await evaluate(`(() => {
      const now = Date.now(), current = new Date(now).toISOString(), old = new Date(now - 100 * 3600000).toISOString();
      const requests = [
        { id: 'REQ-PDF-1', barangay: 'Lahug', category: 'Food', status: 'Under Verification', createdAt: old },
        { id: 'REQ-PDF-2', barangay: 'Apas', category: 'Water', status: 'Approved', createdAt: current },
        { id: 'REQ-PDF-3', barangay: 'Tisa', category: 'Medical', status: 'Pledged', createdAt: current },
        { id: 'REQ-PDF-4', barangay: 'Lahug', category: 'Shelter', status: 'Fulfilled', createdAt: old },
        { id: 'REQ-PDF-5', barangay: 'Apas', category: 'Utility', status: 'Rejected', createdAt: old }
      ].map(record => ({ household: 'SYNTHETIC PRIVATE HOUSEHOLD', householdId: 'TEST-HOUSEHOLD', disaster: 'Flood', urgency: 'High', description: 'SYNTHETIC PRIVATE DESCRIPTION', ...record }));
      const donations = [
        { id: 'DON-PDF-1', requestId: 'REQ-PDF-3', status: 'Reserved', createdAt: current, expiresAt: new Date(now + 48 * 3600000).toISOString() },
        { id: 'DON-PDF-2', requestId: null, barangay: 'Lahug', status: 'Pending Approval', createdAt: current },
        { id: 'DON-PDF-3', requestId: 'REQ-PDF-4', status: 'Completed', createdAt: old }
      ].map(record => ({ donor: 'SYNTHETIC PRIVATE DONOR', donorId: 'TEST-DONOR', amount: 'SYNTHETIC PRIVATE AMOUNT', type: 'Items', ...record }));
      if (!commitRecords({ requests, donations })) throw new Error('Synthetic seed failed');
      goDash('DSWS_ADMIN', 'reports');
    })()`);
    await waitFor('Boolean(document.getElementById("exportSummaryButton"))');
    await evaluate(`(() => {
      const donations = getDonations(), old = new Date(Date.now() - 100 * 3600000).toISOString();
      donations.push({ id: 'DON-PDF-EXPIRED', donor: 'SYNTHETIC PRIVATE DONOR', donorId: 'TEST-DONOR', amount: 'SYNTHETIC PRIVATE AMOUNT', type: 'Items', requestId: 'REQ-PDF-2', status: 'Reserved', createdAt: old, expiresAt: old });
      if (!setDonations(donations)) throw new Error('Expired pledge seed failed');
      document.getElementById('exportSummaryButton').click();
      window.__pdfBusyObserved = document.getElementById('exportSummaryButton').disabled && document.getElementById('exportSummaryButton').getAttribute('aria-busy') === 'true';
    })()`);
    await waitFor('!reportExporting && window.jspdf?.jsPDF && document.getElementById("exportSummaryButton")?.disabled === false');
    check(await evaluate('__pdfBusyObserved'), 'Export button displays a busy state while PDF libraries load');
    check(await evaluate('document.getElementById("exportSummaryButton").textContent.includes("Export summary (PDF)") && !document.getElementById("exportSummaryButton").hasAttribute("aria-busy")'), 'Export button restores its enabled label after saving');
    check(await evaluate('getDonations().find(donation => donation.id === "DON-PDF-EXPIRED").status === "Expired"'), 'Export processes expired pledges before the snapshot');
    for (let attempt = 0; attempt < 100 && !fs.readdirSync(downloads).some(name => name.endsWith('.pdf')); attempt++) await delay(100);
    const filename = fs.readdirSync(downloads).find(name => name.endsWith('.pdf'));
    check(Boolean(filename) && /^ayuda-cebu-dsws-summary-\d{4}-\d{2}-\d{2}\.pdf$/.test(filename), 'Clicking Export summary downloads a dated PDF');
    const pdf = fs.readFileSync(path.join(downloads, filename));
    check(pdf.subarray(0, 5).toString('ascii') === '%PDF-', 'Downloaded file has a valid PDF signature');
    check(!pdf.toString('latin1').includes('SYNTHETIC PRIVATE'), 'Summary PDF omits household, donor and free-text donation details');
    fs.writeFileSync(path.join(output, 'dsws-summary-sample.pdf'), pdf);
    check(vendorResponses.length === 2 && vendorResponses.every(response => response.status === 200), 'Both PDF libraries load from real same-origin vendor routes');
    await evaluate('render()');
    await screenshot('report-export-desktop.png');
    await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 1080, deviceScaleFactor: 1, mobile: false });
    await settle();
    check(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), 'Reports page fits the mobile viewport');
    await screenshot('report-export-mobile.png');

    const beforeUnauthorized = downloaded.length;
    await evaluate('logout()');
    await waitFor('session() === null');
    await evaluate('exportReport()');
    await delay(250);
    check(downloaded.length === beforeUnauthorized && await evaluate('!reportExporting'), 'Signed-out export remains blocked after PDF libraries are cached');
    check(errors.length === 0, 'No JavaScript or CSP errors during export');
  } catch (error) {
    console.error(error.stack);
    if (errors.length) console.error(JSON.stringify(errors));
    process.exitCode = 1;
  } finally {
    if (chrome?.pid) {
      try { await cdp('Browser.close', {}, false); } catch { chrome.kill(); }
      for (let attempt = 0; attempt < 40 && chrome.exitCode === null; attempt++) await delay(100);
      if (chrome.exitCode === null) chrome.kill();
    }
    for (const entry of pending.values()) clearTimeout(entry.timer);
    if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    if (backend) await backend.close();
    const resolvedProfile = path.resolve(profile);
    if (path.dirname(resolvedProfile) === path.resolve(os.tmpdir()) && path.basename(resolvedProfile).startsWith('ayuda-report-check-')) {
      try { fs.rmSync(resolvedProfile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
      catch (error) { console.error('Temporary profile cleanup: ' + error.message); }
    }
    console.log(JSON.stringify({ passed: results.length, errors, downloads: downloaded.length }));
  }
})();
