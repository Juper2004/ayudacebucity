// Isolated Chrome touch-emulation check; no project .env or persistent database.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { createApp } = require('../server/app.cjs');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ayuda-report-mobile-check-'));
const downloads = path.join(profile, 'downloads');
fs.mkdirSync(downloads);
const results = [], errors = [], downloaded = [], completed = [], vendorResponses = [], observations = [], expectedFailureErrors = [];
let chrome, backend, server, sessionId, buffer = '', stderr = '', nextId = 0, rejectNextWorker = false, testingFailure = false;
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
  for (let attempt = 0; attempt < 150; attempt++) {
    try { if (await evaluate(expression)) return; }
    catch (error) {
      if (!/ReferenceError|context.*destroyed|Cannot find context/i.test(error.message)) throw error;
    }
    await delay(100);
  }
  throw new Error('Browser wait timed out: ' + expression);
}
async function tap(selector) {
  const point = await evaluate(`(() => {
    const button = document.querySelector(${JSON.stringify(selector)});
    button.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const rect = button.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  })()`);
  await cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...point, radiusX: 2, radiusY: 2, force: 1, id: 0 }] });
  await cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}
async function setMobile(width) {
  await cdp('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: true });
  await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await cdp('Emulation.setUserAgentOverride', {
    userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Mobile Safari/537.36',
    platform: 'Linux armv8l',
  });
}

(async () => {
  try {
    server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    backend = await createApp({
      databasePath: ':memory:', appOrigin: origin,
      admin: { name: 'PDF Mobile Verification Admin', email: 'pdf-mobile@example.test', password: 'Test-Pdf-Mobile-938!' },
      otpSecret: 'isolated-mobile-report-verification-secret',
    });
    // Exercise a first-load network delay long enough to outlast transient activation.
    server.on('request', (req, res) => {
      if (rejectNextWorker && req.url === '/report-worker.js') {
        rejectNextWorker = false;
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        res.end('Test-only unavailable worker');
        return;
      }
      if (req.url.startsWith('/vendor/')) res.on('finish', () => vendorResponses.push({ url: req.url, status: res.statusCode }));
      if (req.url === '/vendor/jspdf.umd.min.js') setTimeout(() => backend.app(req, res), 6200);
      else backend.app(req, res);
    });
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
          (testingFailure ? expectedFailureErrors : errors).push(message.params.entry.text);
        } else if (message.method === 'Browser.downloadWillBegin') downloaded.push(message.params);
        else if (message.method === 'Browser.downloadProgress' && message.params.state === 'completed') completed.push(message.params);
      }
    });
    const target = await cdp('Target.createTarget', { url: 'about:blank' }, false);
    sessionId = (await cdp('Target.attachToTarget', { targetId: target.targetId, flatten: true }, false)).sessionId;
    await cdp('Runtime.enable');
    await cdp('Page.enable');
    await cdp('Network.enable');
    await cdp('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp('Log.enable');
    await cdp('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true }, false);
    await setMobile(390);
    await cdp('Page.navigate', { url: origin + '/#/login' });
    await waitFor('authState.ready && Boolean(document.getElementById("loginEmail"))');
    await evaluate('document.getElementById("loginEmail").value = "pdf-mobile@example.test"; document.getElementById("loginPassword").value = "Test-Pdf-Mobile-938!"; document.getElementById("loginEmail").form.requestSubmit()');
    await waitFor('session()?.role === "DSWS_ADMIN" && Boolean(document.querySelector(".dashboard"))');
    await evaluate(`(() => {
      const createdAt = new Date().toISOString();
      commitRecords({ requests: [{ id: 'REQ-MOBILE-1', household: 'PRIVATE TEST HOUSEHOLD', householdId: 'TEST', disaster: 'Flood', urgency: 'High', description: 'PRIVATE TEST DESCRIPTION', barangay: 'Lahug', category: 'Food', status: 'Approved', createdAt }], donations: [] });
      goDash('DSWS_ADMIN', 'reports');
      window.__mobileTrace = [];
      window.__mobileHeartbeats = [];
      window.__workerEvents = [];
      window.__heartbeatTimer = setInterval(() => __mobileHeartbeats.push(performance.now()), 50);
      const BrowserWorker = window.Worker;
      window.Worker = class extends BrowserWorker {
        constructor(...args) {
          super(...args);
          __workerEvents.push({ event: 'started', url: String(args[0]), time: performance.now() });
          this.addEventListener('message', () => __workerEvents.push({ event: 'message', time: performance.now() }));
        }
      };
      document.addEventListener('click', event => {
        if (event.target.closest('#exportSummaryButton')) __mobileTrace.push({ event: 'tap', trusted: event.isTrusted, active: navigator.userActivation.isActive, time: performance.now() });
        if (event.target.closest('#downloadReportPdf')) __mobileTrace.push({ event: 'download', trusted: event.isTrusted, active: navigator.userActivation.isActive, time: performance.now() });
      }, true);
      new MutationObserver(() => {
        if (document.getElementById('downloadReportPdf') && !__mobileTrace.some(item => item.event === 'ready')) {
          __mobileTrace.push({ event: 'ready', active: navigator.userActivation.isActive, time: performance.now() });
        }
      }).observe(document.body, { childList: true, subtree: true });
    })()`);
    await waitFor('Boolean(document.getElementById("exportSummaryButton"))');
    check(await evaluate('innerWidth === 390 && navigator.maxTouchPoints === 5 && /Android/.test(navigator.userAgent)'), 'Mobile viewport, Android UA and touch emulation are enabled');
    check(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), '390px reports page does not overflow');
    await tap('#exportSummaryButton');
    check(await evaluate('reportExporting && document.getElementById("exportSummaryButton").disabled && document.getElementById("exportSummaryButton").getAttribute("aria-busy") === "true"'), 'Touch export shows busy state during delayed library load');
    await waitFor('!reportExporting && Boolean(document.getElementById("downloadReportPdf"))');
    const slowTrace = await evaluate('__mobileTrace');
    observations.push({ scenario: '390px slow first export', trace: slowTrace });
    console.log('TRACE ' + JSON.stringify(observations.at(-1)));
    check(slowTrace[0].trusted && slowTrace[0].active, 'CDP touch creates a trusted click with user activation');
    check(slowTrace[1].time - slowTrace[0].time >= 6000 && !slowTrace[1].active, 'Slow first-load PDF waits for an explicit download after transient activation expires');
    check(downloaded.length === 0, 'Preparing the mobile report does not attempt a download without a fresh tap');
    check(await evaluate('__workerEvents.some(item => item.event === "started" && item.url.includes("report-worker.js")) && __workerEvents.some(item => item.event === "message") && !window.jspdf'), 'PDF libraries and generation run in a worker');
    const heartbeat = await evaluate(`(() => {
      const ticks = __mobileHeartbeats.filter(time => time >= __mobileTrace[0].time && time <= __mobileTrace[1].time);
      return { ticks: ticks.length, maxGapMs: Math.max(...ticks.slice(1).map((time, index) => time - ticks[index])) };
    })()`);
    observations.push({ scenario: 'page responsiveness during preparation', ...heartbeat });
    check(heartbeat.ticks > 75 && heartbeat.maxGapMs < 1000, 'Main page keeps responding while worker prepares the report');
    check(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1 && document.getElementById("downloadReportPdf").getBoundingClientRect().width > 100'), '390px PDF dialog fits the phone viewport with a usable download link');
    check(await evaluate('document.getElementById("openReportPdf")?.target === "_blank" && document.getElementById("openReportPdf").href === document.getElementById("downloadReportPdf").href'), 'Phone dialog offers opening the prepared PDF as an alternative');
    await tap('#downloadReportPdf');
    check(await evaluate('__mobileTrace.some(item => item.event === "download" && item.trusted && item.active)'), 'Download link is activated by a fresh trusted touch');
    for (let attempt = 0; attempt < 100 && completed.length < 1; attempt++) await delay(100);
    check(completed.length === 1 && downloaded.length === 1, 'Chrome completes the explicit mobile PDF download after slow preparation');
    check(await evaluate('!document.getElementById("exportSummaryButton").disabled && !document.getElementById("exportSummaryButton").hasAttribute("aria-busy")'), 'Export button restores its enabled state');
    for (const filename of fs.readdirSync(downloads).filter(name => name.endsWith('.pdf'))) {
      const pdf = fs.readFileSync(path.join(downloads, filename));
      check(pdf.subarray(0, 5).toString('ascii') === '%PDF-', 'Mobile-emulated download has a PDF signature');
      check(!pdf.toString('latin1').includes('PRIVATE TEST'), 'Mobile summary omits private household text');
    }
    await setMobile(320);
    check(await evaluate('innerWidth === 320 && document.documentElement.scrollWidth <= innerWidth + 1'), '320px PDF dialog does not overflow');
    await tap('#downloadReportPdf');
    for (let attempt = 0; attempt < 100 && completed.length < 2; attempt++) await delay(100);
    check(completed.length === 2 && downloaded.length === 2, 'Chrome completes a second trusted touch download at 320px');
    const shot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, fromSurface: true });
    fs.writeFileSync(path.join(__dirname, 'report-export-mobile-touch.png'), Buffer.from(shot.data, 'base64'));
    check(vendorResponses.length === 2 && vendorResponses.every(response => response.status === 200), 'Worker loads both PDF libraries from same-origin vendor routes');
    check(errors.length === 0, 'No JavaScript or CSP errors during Chrome mobile emulation');
    await tap('#reportDownloadDialog .modal-close');
    check(await evaluate('preparedReport === null && !document.getElementById("reportDownloadDialog")'), 'Closing the PDF dialog releases the prepared report');

    const workersBeforeFailure = await evaluate('__workerEvents.filter(item => item.event === "started").length');
    rejectNextWorker = true;
    testingFailure = true;
    await tap('#exportSummaryButton');
    await waitFor(`!reportExporting && __workerEvents.filter(item => item.event === 'started').length > ${workersBeforeFailure}`);
    check(await evaluate('!document.getElementById("reportDownloadDialog") && preparedReport === null && !document.getElementById("exportSummaryButton").disabled'), 'Worker load failure leaves no stale file and restores the export button');
    check(await evaluate('document.body.textContent.includes("PDF files could not be loaded")'), 'Worker load failure shows an actionable error');
    testingFailure = false;
    await tap('#exportSummaryButton');
    await waitFor('!reportExporting && Boolean(document.getElementById("downloadReportPdf"))');
    await tap('#downloadReportPdf');
    for (let attempt = 0; attempt < 100 && completed.length < 3; attempt++) await delay(100);
    check(completed.length === 3, 'Retry after worker failure produces a downloadable PDF');
    await tap('#reportDownloadDialog .modal-close');
    const workersBeforeLogout = await evaluate('__workerEvents.filter(item => item.event === "started").length');
    await tap('#exportSummaryButton');
    await waitFor(`reportExporting && __workerEvents.filter(item => item.event === 'started').length > ${workersBeforeLogout}`);
    await evaluate('logout()');
    await waitFor('session() === null && !reportExporting');
    check(await evaluate('!document.getElementById("reportDownloadDialog") && preparedReport === null') && completed.length === 3, 'Signing out during PDF preparation prevents the ready dialog and download');
    check(errors.length === 0, 'No unexpected JavaScript or CSP errors across mobile export scenarios');
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
    if (path.dirname(resolvedProfile) === path.resolve(os.tmpdir()) && path.basename(resolvedProfile).startsWith('ayuda-report-mobile-check-')) {
      try { fs.rmSync(resolvedProfile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
      catch (error) { console.error('Temporary profile cleanup: ' + error.message); }
    }
    const report = { passed: results.length, errors, expectedFailureErrors, downloads: downloaded.length, completed: completed.length, observations };
    fs.writeFileSync(path.join(__dirname, 'report-mobile-check-result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  }
})();
