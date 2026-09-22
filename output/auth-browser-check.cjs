// Temporary isolated browser verification; no application data or dependencies are changed.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const output = path.resolve(root, 'output');
const mobileOnly = process.argv.includes('--mobile-only');
const officialsOnly = process.argv.includes('--officials-desktop-only');
const profile = path.join(require('node:os').tmpdir(), 'ayuda-dashboard-check-' + Date.now());
const downloads = path.join(profile, 'downloads');
fs.mkdirSync(downloads, { recursive: true });
const chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
  '--headless=new', '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check',
  '--disable-background-networking', '--disable-extensions', '--disable-sync',
  '--disable-features=Translate,OptimizationHints,MediaRouter', '--hide-scrollbars',
  '--user-data-dir=' + profile, 'about:blank'
], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
let nextId = 0, buffer = '', sessionId, stderr = '';
const pending = new Map(), errors = [], results = [];
const timer = setTimeout(() => { console.error('Browser verification timed out'); chrome.kill(); process.exitCode = 1; }, 300000);
chrome.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
chrome.on('error', error => { console.error(error); process.exitCode = 1; });
chrome.stdio[4].on('data', chunk => {
  buffer += chunk.toString();
  let separator;
  while ((separator = buffer.indexOf('\0')) !== -1) {
    const raw = buffer.slice(0, separator); buffer = buffer.slice(separator + 1);
    if (!raw) continue;
    const message = JSON.parse(raw);
    if (message.id && pending.has(message.id)) {
      const handler = pending.get(message.id); pending.delete(message.id); clearTimeout(handler.timer);
      message.error ? handler.reject(new Error(JSON.stringify(message.error))) : handler.resolve(message.result || {});
    } else if (message.method === 'Runtime.exceptionThrown') {
      errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    } else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      errors.push(message.params.args.map(arg => arg.value || arg.description).join(' '));
    } else if (message.method === 'Page.javascriptDialogOpening') {
      cdp('Page.handleJavaScriptDialog', { accept: true, promptText: 'Synthetic verification: missing supporting documents.' }).catch(error => errors.push(error.message));
    }
  }
});
function cdp(method, params = {}, useSession = true) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method + '\n' + stderr)); }, 15000);
    pending.set(id, { resolve, reject, timer: timeout });
    chrome.stdio[3].write(JSON.stringify({ id, method, params, ...(useSession && sessionId ? { sessionId } : {}) }) + '\0');
  });
}
async function evaluate(expression) {
  const response = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  return response.result.value;
}
async function settle() {
  await evaluate('(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 100)))); for (const animation of document.getAnimations()) { if (Number.isFinite(animation.effect?.getComputedTiming().endTime)) { try { animation.finish(); } catch (_) {} } } })()');
}

async function newPage(url) {
  const target = await cdp('Target.createTarget', { url: 'about:blank' }, false);
  sessionId = (await cdp('Target.attachToTarget', { targetId: target.targetId, flatten: true }, false)).sessionId;
  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Page.navigate', { url });
  for (let i=0; i<50; i++) { if (await evaluate('document.readyState === "complete" && typeof getUsers === "function"')) return target.targetId; await new Promise(r=>setTimeout(r,100)); }
  throw new Error('Page did not load');
}

const { createApp } = require('../server/app.cjs');
const { createServer } = require('node:http');
const { once } = require('node:events');
let backend, server;
function check(pass, label) {
  results.push({ pass: Boolean(pass), label });
  if (!pass) throw new Error(label);
}
async function waitFor(expression) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if (await evaluate(expression)) return; }
    catch (error) {
      if (!/ReferenceError|context.*destroyed|Cannot find context/i.test(error.message)) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for browser: ' + expression);
}
async function navigate(route, selector) {
  await evaluate(`location.hash = ${JSON.stringify(route)}`);
  await waitFor(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
}
async function fill(values) {
  await evaluate(`(() => { for (const [id, value] of Object.entries(${JSON.stringify(values)})) document.getElementById(id).value = value; })()`);
}
async function submit(field) {
  await evaluate(`document.getElementById(${JSON.stringify(field)}).form.requestSubmit()`);
}
async function login(email, password, dashboard) {
  await navigate('#/login', '#loginEmail');
  await fill({ loginEmail: email, loginPassword: password });
  await submit('loginEmail');
  await waitFor(`location.hash === ${JSON.stringify(dashboard)} && Boolean(document.querySelector('.dashboard'))`);
}
(async () => {
  try {
    const sent = [];
    server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    backend = await createApp({
      databasePath: ':memory:', appOrigin: origin,
      admin: { name: 'Browser Test Admin', email: 'admin@example.test', password: 'BrowserAdmin123!' },
      mailer: { configured: true, async sendRecoveryCode(mail) { sent.push(mail); } }
    });
    server.on('request', backend.app);
    await newPage(origin + '/#/register?role=donor');
    await waitFor('authState.ready && Boolean(document.getElementById("regEmail"))');
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1080, deviceScaleFactor: 1, mobile: false });
    await fill({ regName: 'Browser Test Donor', regEmail: 'donor@example.test', regPassword: 'BrowserDonor123!' });
    await submit('regEmail');
    await waitFor('Boolean(document.getElementById("loginEmail"))');
    check(true, 'Donor registration through the real form');
    await login('donor@example.test', 'BrowserDonor123!', '#/donor');
    check(await evaluate('session().role === "DONOR" && !localStorage.getItem("ayudaUsersProV3")'), 'Login uses the server and creates no browser credentials');
    await cdp('Page.reload');
    await waitFor('authState.ready && Boolean(document.querySelector(".dashboard"))');
    check(await evaluate('session().email === "donor@example.test"'), 'Session persists after reload');
    await evaluate('logout()');
    await waitFor('session() === null');
    await navigate('#/forgot-password', '#recoveryEmail');
    await fill({ recoveryEmail: 'donor@example.test' });
    await submit('recoveryEmail');
    await waitFor('Boolean(document.getElementById("recoveryCode"))');
    for (let i = 0; i < 100 && !sent.length; i++) await new Promise(resolve => setTimeout(resolve, 25));
    check(sent.length === 1, 'Forgot-password form reaches the injected email provider');
    check(await evaluate(`!document.body.textContent.includes(${JSON.stringify(sent[0].code)}) && !document.querySelector('.recovery-demo-code') && !JSON.stringify({...localStorage,...sessionStorage}).includes(${JSON.stringify(sent[0].code)})`), 'Code is absent from page and browser storage');
    check(await evaluate('document.getElementById("resendRecovery").disabled'), 'Resend cooldown is visible');
    for (const width of [1440, 390]) {
      await cdp('Emulation.setDeviceMetricsOverride', { width, height: 1080, deviceScaleFactor: 1, mobile: false });
      await settle();
      check(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), `Reset layout fits ${width}px`);
      const shot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, fromSurface: true });
      fs.writeFileSync(path.join(output, `auth-reset-${width}.png`), Buffer.from(shot.data, 'base64'));
    }
    await cdp('Page.reload');
    await waitFor('authState.ready && Boolean(document.getElementById("recoveryCode"))');
    check(await evaluate('recoveryEmail === "donor@example.test"'), 'Reset page survives reload without saving the code');
    await fill({ recoveryCode: sent[0].code, newPassword: 'BrowserReset123!', confirmPassword: 'BrowserReset123!' });
    await submit('recoveryCode');
    await waitFor('Boolean(document.getElementById("loginEmail"))');
    await login('donor@example.test', 'BrowserReset123!', '#/donor');
    check(true, 'Reset form changes password and new password logs in');
    await evaluate('logout()');
    await navigate('#/login', '#loginEmail');
    await fill({ loginEmail: 'donor@example.test', loginPassword: 'BrowserDonor123!' });
    await submit('loginEmail');
    await waitFor('!document.getElementById("loginEmail").form.dataset.busy');
    check(await evaluate('session() === null && location.hash === "#/login"'), 'Old password is rejected');
    await navigate('#/register?role=household', '#regEmail');
    await fill({ regRole: 'HOUSEHOLD', regName: 'Browser Test Household', regBarangay: 'Lahug', regContact: '09171234567', regEmail: 'household@example.test', regPassword: 'BrowserHouse123!' });
    await evaluate('toggleReg()');
    await submit('regEmail');
    await waitFor('Boolean(document.getElementById("loginEmail"))');
    await login('household@example.test', 'BrowserHouse123!', '#/household');
    await navigate('#/household/request', 'main h1');
    await waitFor('document.body.textContent.includes("Approval pending")');
    check(await evaluate('!document.getElementById("reqDescription") && session().status === "PENDING"'), 'Pending household can log in but cannot request assistance');
    await evaluate('logout()');
    await login('admin@example.test', 'BrowserAdmin123!', '#/dsws');
    await navigate('#/dsws/officials', '#officialEmail');
    await fill({ officialName: 'Browser Official', officialEmail: 'official@example.test', officialPassword: 'BrowserOfficial123!', officialBarangay: 'Lahug', officialContact: '09171234567' });
    await submit('officialEmail');
    await waitFor('getUsers().some(user => user.email === "official@example.test")');
    check(await evaluate('getUsers().find(user => user.email === "official@example.test").role === "BARANGAY_OFFICIAL"'), 'Administrator creates an official through the real form');
    await evaluate('logout()');
    await login('official@example.test', 'BrowserOfficial123!', '#/barangay');
    await navigate('#/barangay/accounts', '.dsws-panel');
    await waitFor('Boolean(document.querySelector("button[onclick*=approveHouseholdAccount]"))');
    await evaluate('document.querySelector("button[onclick*=approveHouseholdAccount]").click()');
    await waitFor('getUsers().find(user => user.email === "household@example.test")?.status === "APPROVED"');
    check(true, 'Official approves household using the server');
    check(!errors.length, 'No JavaScript runtime errors');
  } catch (error) {
    results.push({ pass: false, label: error.message });
    console.error(error.stack);
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(path.join(output, 'auth-browser-results.json'), JSON.stringify({ checkedAt: new Date().toISOString(), results, errors }, null, 2));
    try { await cdp('Browser.close', {}, false); } catch (_) { chrome.kill(); }
    clearTimeout(timer);
    if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    if (backend) await backend.close();
    console.log(JSON.stringify({ passed: results.filter(r => r.pass).length, failed: results.filter(r => !r.pass).length }));
  }
})();
