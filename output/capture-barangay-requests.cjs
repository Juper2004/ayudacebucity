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

const tabs = { HOUSEHOLD: ['overview', 'request', 'history', 'profile'], BARANGAY_OFFICIAL: ['overview', 'accounts', 'pending', 'all', 'profile'], DONOR: ['overview', 'browse', 'donations', 'profile'], DSWS_ADMIN: ['overview', 'officials', 'barangays', 'requests', 'reports'] };
const ids = { HOUSEHOLD: 'UI-HOUSEHOLD', BARANGAY_OFFICIAL: 'UI-OFFICIAL', DONOR: 'UI-DONOR', DSWS_ADMIN: 'ACC-1001' };
const signatures = new Map();
const fixtureTime = Date.now();
function assert(pass, label, details) { results.push({ pass: !!pass, label, ...(details ? { details } : {}) }); if (!pass) console.error('FAIL ' + label + ': ' + JSON.stringify(details)); }
function fixture(populated, status = 'APPROVED') {
  const now = new Date(fixtureTime).toISOString(), old = new Date(fixtureTime - 100 * 3600000).toISOString();
  const common = { password: 'SyntheticTest123!', status: 'APPROVED', contact: '0917 555 0100', createdAt: now };
  const household = { ...common, id: ids.HOUSEHOLD, name: 'Maria Santos', email: 'maria.santos@example.test', role: 'HOUSEHOLD', barangay: 'Lahug', status, ...(status === 'REJECTED' ? { rejectionReason: 'Please confirm your household address with the barangay.' } : {}) };
  const users = [{ ...common, id: ids.DSWS_ADMIN, name: 'DSWS Administrator', email: 'dsws@ayuda.local', role: 'DSWS_ADMIN' }, household,
    { ...common, id: ids.BARANGAY_OFFICIAL, name: 'Ana Reyes', email: 'ana.reyes@example.test', role: 'BARANGAY_OFFICIAL', barangay: 'Lahug' },
    { ...common, id: ids.DONOR, name: 'Cebu Community Volunteers', email: 'cebu.community.volunteers@example.test', role: 'DONOR' },
    ...(populated ? [{ ...common, id: 'UI-PENDING', name: 'Daniel dela Cruz', email: 'daniel.delacruz@example.test', role: 'HOUSEHOLD', barangay: 'Lahug', status: 'PENDING' }] : [])];
  const requests = populated ? [
    { id: 'REQ-UI-001', status: 'Under Verification', category: 'Food', disaster: 'Flood', urgency: 'Urgent', createdAt: old },
    { id: 'REQ-UI-002', status: 'Approved', category: 'Water', disaster: 'Typhoon', urgency: 'High', createdAt: now },
    { id: 'REQ-UI-003', status: 'Pledged', category: 'Medical', disaster: 'Fire', urgency: 'Normal', createdAt: now },
    { id: 'REQ-UI-004', status: 'Fulfilled', category: 'Shelter', disaster: 'Flood', urgency: 'Normal', createdAt: now },
    { id: 'REQ-UI-005', status: 'Rejected', category: 'Utility', disaster: 'Typhoon', urgency: 'High', createdAt: now, rejectionReason: 'Please provide supporting photos.' },
    { id: 'REQ-UI-006', status: 'Approved', category: 'Food', disaster: 'Flood', urgency: 'High', createdAt: now, barangay: 'Talamban', householdId: 'UI-OTHER' }
  ].map(r => ({ household: household.name, householdId: household.id, barangay: 'Lahug', description: 'Our family needs food, drinking water, and essential supplies after the recent flooding.', contact: common.contact, location: 'Near the barangay community hall', photos: [], ...r })) : [];
  const donations = populated ? [
    { id: 'DON-UI-001', requestId: 'REQ-UI-003', type: 'Items', amount: '5 first aid kits', status: 'Reserved', expiresAt: new Date(Date.now() + 48 * 3600000).toISOString() },
    { id: 'DON-UI-002', requestId: null, type: 'Items', amount: '20 family food packs', status: 'Pending Approval' },
    { id: 'DON-UI-003', requestId: 'REQ-UI-004', type: 'Items', amount: '10 blankets', status: 'Completed' }
  ].map(d => ({ donor: 'Cebu Community Volunteers', donorId: ids.DONOR, barangay: 'Lahug', createdAt: now, ...d })) : [];
  return { users, requests, donations };
}
async function seed(populated, status) { return evaluate(`commitRecords(${JSON.stringify(fixture(populated, status))})`); }
async function go(role, tab) {
  await evaluate(`(() => { setSession(getUsers().find(user => user.id === ${JSON.stringify(ids[role])})); goDash(${JSON.stringify(role)}, ${JSON.stringify(tab)}); render(); })()`);
  await settle();
}
const signatureExpression = `(() => {
  const main = document.querySelector('main');
  return {
    actions: [...main.querySelectorAll('[onclick],[onchange],[onsubmit]')].map(el => ['onclick','onchange','onsubmit'].filter(a => el.hasAttribute(a)).map(a => a + ':' + el.getAttribute(a)).join('|') + ':disabled=' + !!el.disabled).sort(),
    fields: [...main.querySelectorAll('input,select,textarea')].map(el => ({ id: el.id, tag: el.tagName, type: el.type, value: el.value, required: el.required, readOnly: el.readOnly, disabled: el.disabled, multiple: el.multiple, accept: el.accept, maxLength: el.maxLength, options: el.options ? [...el.options].map(o => [o.value,o.text]) : undefined })),
    metrics: [...main.querySelectorAll('.metric-card .value,.dsws-metric-copy strong')].map(el => el.textContent.trim()),
    rows: [...main.querySelectorAll('tbody tr')].map(el => el.textContent.replace(/\\s+/g,' ').trim()),
    cards: [...main.querySelectorAll('.request-card:not(.donor-request-card)')].map(el => el.textContent.replace(/\\s+/g,' ').trim()).filter(text => !/^\\d\\. /.test(text)),
    browse: [...main.querySelectorAll('#browseList article')].map(el => el.textContent.replace(/\\s+/g,' ').trim())
  };
})()`;
async function layout(role, tab, width, state) {
  const info = await evaluate(`(() => {
    const overflow = [...document.querySelectorAll('main *,header *, .mobile-bottom *')].filter(el => {
      if (el.closest('svg,.table-wrap') || !el.getClientRects().length) return false;
      const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
      return style.position !== 'fixed' && (rect.right > innerWidth + 2 || rect.left < -2);
    }).slice(0,8).map(el => ({ tag:el.tagName, cls:el.className, text:el.textContent.trim().slice(0,60) }));
    const duplicates = [...document.querySelectorAll('[id]')].map(el => el.id).filter((id,i,all) => all.indexOf(id) !== i);
    return { heading: document.querySelector('main h1')?.textContent.trim(), heroes: document.querySelectorAll('main .dsws-hero').length, width: innerWidth, scrollWidth:document.documentElement.scrollWidth, overflow, duplicates, active:[...document.querySelectorAll('[aria-current="page"]')].map(el => el.getAttribute('onclick')) };
  })()`);
  const pass = info.heading && info.heroes === 1 && info.scrollWidth <= width + 2 && !info.overflow.length && !info.duplicates.length && info.active.length === 2 && info.active.every(a => a.includes(tab));
  assert(pass, `layout ${state} ${role}/${tab} ${width}px`, pass ? undefined : info);
}
async function screenshot(name) { const shot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, fromSurface: true }); fs.writeFileSync(path.join(output, 'dashboard-' + name + '.png'), Buffer.from(shot.data, 'base64')); }
async function newPage(url) {
  const target = await cdp('Target.createTarget', { url: 'about:blank' }, false);
  sessionId = (await cdp('Target.attachToTarget', { targetId: target.targetId, flatten: true }, false)).sessionId;
  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Page.navigate', { url });
  for (let i=0; i<50; i++) { if (await evaluate('document.readyState === "complete" && typeof getUsers === "function"')) return target.targetId; await new Promise(r=>setTimeout(r,100)); }
  throw new Error('Page did not load');
}

(async () => {
  try {
    await newPage(pathToFileURL(path.join(root, 'index.html')).href);
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1080, deviceScaleFactor: 1, mobile: false });
    await seed(true);
    await go('BARANGAY_OFFICIAL', 'all');
    await layout('BARANGAY_OFFICIAL', 'all', 1440, 'preview');
    await screenshot('barangay_official-requests-1440');
    if (errors.length || results.some(result => !result.pass)) throw new Error(JSON.stringify({errors, results}));
    console.log(JSON.stringify({ screenshot: path.join(output, 'dashboard-barangay_official-requests-1440.png'), results }));
  } catch (error) {
    console.error(error.stack);
    process.exitCode = 1;
  } finally {
    try { await cdp('Browser.close', {}, false); } catch (_) { chrome.kill(); }
    clearTimeout(timer);
  }
})();
