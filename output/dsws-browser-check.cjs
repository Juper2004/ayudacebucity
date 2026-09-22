// Temporary isolated browser verification; no application data or dependencies are changed.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const output = path.resolve(root, 'output');
const mobileOnly = process.argv.includes('--mobile-only');
const officialsOnly = process.argv.includes('--officials-desktop-only');
const profile = path.join(output, 'dsws-check-profile-' + Date.now());
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
const timer = setTimeout(() => { console.error('Browser verification timed out'); chrome.kill(); process.exitCode = 1; }, 180000);
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
async function go(tab) {
  await evaluate(`(() => { const button = [...document.querySelectorAll('.side-btn, .mobile-nav-btn')].find(button => button.getAttribute('onclick').includes("'${tab}'") || button.getAttribute('onclick').includes('"${tab}"')); if (button) button.click(); else goDash('DSWS_ADMIN', '${tab}'); })()`);
  await settle();
}
function assert(condition, label, detail = '') {
  results.push({ kind: 'functional', label, pass: Boolean(condition), ...(detail ? { detail } : {}) });
  if (!condition) console.error('FAIL ' + label + ': ' + JSON.stringify(detail));
}
async function screenshot(name) {
  const response = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, fromSurface: true });
  fs.writeFileSync(path.join(output, 'dsws-' + name + '.png'), Buffer.from(response.data, 'base64'));
}
async function measure(tab, width, state) {
  const info = await evaluate(`(() => {
    const visible = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const overflow = [...document.querySelectorAll('.dsws-panel, .panel, .request-card, .dsws-official-card, form, .field')]
      .filter(visible).filter(el => !el.closest('.table-wrap'))
      .filter(el => el.scrollWidth > el.clientWidth + 3 && !['auto', 'scroll'].includes(getComputedStyle(el).overflowX))
      .map(el => ({ element: el.tagName.toLowerCase() + '.' + [...el.classList].join('.'), width: el.clientWidth, scrollWidth: el.scrollWidth, text: el.textContent.trim().slice(0, 90) }));
    return { heading: document.querySelector('main h1')?.textContent.trim(), hash: location.hash,
      active: [...document.querySelectorAll('[aria-current="page"]')].map(el => ({ text: el.textContent.trim(), action: el.getAttribute('onclick') })),
      viewport: window.innerWidth, documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth, overflow };
  })()`);
  const headingPatterns = { overview: /overview/i, officials: /official/i, barangays: /barangay/i, requests: /request/i, reports: /report/i };
  const pass = headingPatterns[tab].test(info.heading || '') && info.hash.endsWith('/' + tab) && info.active.length === 2 && info.active.every(item => item.action.includes(tab)) && info.documentWidth <= width + 2 && info.bodyWidth <= width + 2 && !info.overflow.length;
  results.push({ kind: 'layout', tab, width, state, pass, ...info });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${state} ${width}px ${tab}${info.overflow.length ? ' ' + JSON.stringify(info.overflow) : ''}`);
}
const seed = `(() => {
  const admin = getUsers().find(user => user.role === 'DSWS_ADMIN');
  const now = new Date().toISOString(), older = new Date(Date.now() - 100 * 3600000).toISOString();
  const officials = [
    { id: 'TEST-OFFICIAL-1', name: 'Marisol de la Cruz', email: 'marisol.lahug@example.test', barangay: 'Lahug', status: 'PENDING' },
    { id: 'TEST-OFFICIAL-2', name: 'Rafael Villanueva', email: 'rafael.talamban@example.test', barangay: 'Talamban', status: 'PENDING' },
    { id: 'TEST-OFFICIAL-3', name: 'Ana Maria Fernandez', email: 'ana.fernandez.community.coordination@example.test', barangay: 'Pung-ol-Sibugay', status: 'APPROVED' }
  ].map(user => ({ ...user, role: 'BARANGAY_OFFICIAL', password: 'SyntheticTest123!', contact: '0917 123 4567', createdAt: now }));
  const household = { id: 'TEST-HOUSEHOLD', name: 'Santos family', email: 'santos@example.test', role: 'HOUSEHOLD', password: 'SyntheticTest123!', status: 'APPROVED', barangay: 'Lahug', createdAt: now };
  const donor = { id: 'TEST-DONOR', name: 'Cebu Community Volunteers', email: 'volunteers@example.test', role: 'DONOR', password: 'SyntheticTest123!', status: 'APPROVED', createdAt: now };
  const requests = [
    { id: 'REQ-TEST-001', barangay: 'Lahug', category: 'Food', disaster: 'Flood', urgency: 'High', status: 'Under Verification', createdAt: older },
    { id: 'REQ-TEST-002', barangay: 'Pung-ol-Sibugay', category: 'Water', disaster: 'Typhoon', urgency: 'Medium', status: 'Approved', createdAt: now },
    { id: 'REQ-TEST-003', barangay: 'Talamban', category: 'Medical', disaster: 'Fire', urgency: 'High', status: 'Pledged', createdAt: now },
    { id: 'REQ-TEST-004', barangay: 'Lahug', category: 'Shelter', disaster: 'Flood', urgency: 'Low', status: 'Fulfilled', createdAt: now },
    { id: 'REQ-TEST-005', barangay: 'Basak San Nicolas', category: 'Utility', disaster: 'Typhoon', urgency: 'Medium', status: 'Rejected', createdAt: now }
  ].map(request => ({ ...request, household: 'Santos family', householdId: household.id, contact: '0917 555 0100', description: 'Our household needs assistance after recent flooding. Five family members need safe drinking water and food supplies.', location: 'Near the barangay community hall', photos: [] }));
  const donations = [{ id: 'DON-TEST-001', donor: donor.name, donorId: donor.id, requestId: 'REQ-TEST-003', barangay: 'Talamban', type: 'Medical', amount: '5 first aid kits', status: 'Reserved', createdAt: now, expiresAt: new Date(Date.now() + 48 * 3600000).toISOString() }];
  if (!commitRecords({ users: [admin, ...officials, household, donor], requests, donations })) throw new Error('Unable to seed isolated profile');
  setSession(admin); render(); return { users: getUsers().length, requests: getRequests().length, donations: getDonations().length };
})()`;
(async () => {
  try {
    const target = await cdp('Target.createTarget', { url: 'about:blank' }, false);
    sessionId = (await cdp('Target.attachToTarget', { targetId: target.targetId, flatten: true }, false)).sessionId;
    await cdp('Runtime.enable'); await cdp('Page.enable');
    await cdp('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads }, false);
    await cdp('Page.navigate', { url: pathToFileURL(path.join(root, 'index.html')).href });
    for (let attempt = 0; attempt < 40; attempt++) {
      if (await evaluate('document.readyState === "complete" && typeof getUsers === "function"')) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await evaluate('setSession(getUsers().find(user => user.role === "DSWS_ADMIN")); goDash("DSWS_ADMIN", "overview")');
    await settle();
    const tabs = officialsOnly ? ['officials'] : ['overview', 'officials', 'barangays', 'requests', 'reports'];
    for (const width of officialsOnly ? [] : mobileOnly ? [390, 320] : [1440, 390, 320]) {
      await cdp('Emulation.setDeviceMetricsOverride', { width, height: width > 800 ? 1080 : 900, deviceScaleFactor: 1, mobile: false });
      for (const tab of tabs) { await go(tab); await measure(tab, width, 'empty'); }
    }
    console.log('Seeded isolated profile: ' + JSON.stringify(await evaluate(seed)));
    for (const width of officialsOnly ? [1440] : mobileOnly ? [390, 320] : [1440, 1024, 768, 390, 320]) {
      await cdp('Emulation.setDeviceMetricsOverride', { width, height: width > 800 ? 1080 : 900, deviceScaleFactor: 1, mobile: false });
      for (const tab of tabs) {
        await go(tab); await measure(tab, width, 'populated');
        if (width === 1440 || width === 390 || (width === 320 && tab === 'officials')) await screenshot(`${tab}-${width}`);
      }
    }
    if (!mobileOnly && !officialsOnly) {
    await go('officials');
    const create = await evaluate(`(() => {
      for (const [id, value] of Object.entries({ officialName: 'Browser Test Official', officialBarangay: 'Apas', officialContact: '0917 777 1000', officialEmail: 'browser.created@example.test', officialPassword: 'SyntheticTest123!' })) document.getElementById(id).value = value;
      document.getElementById('officialName').form.requestSubmit();
      const user = getUsers().find(user => user.email === 'browser.created@example.test'); return user && { role: user.role, status: user.status, barangay: user.barangay };
    })()`);
    assert(create?.status === 'APPROVED' && create?.role === 'BARANGAY_OFFICIAL' && create?.barangay === 'Apas', 'Create official via valid form submit', create);
    await evaluate(`document.querySelector('button[onclick*="approveOfficial"][onclick*="TEST-OFFICIAL-1"]').click()`);
    assert(await evaluate(`getUsers().find(user => user.id === 'TEST-OFFICIAL-1').status === 'APPROVED'`), 'Approve official using action button');
    await evaluate(`document.querySelector('button[onclick*="rejectOfficial"][onclick*="TEST-OFFICIAL-2"]').click()`);
    assert(await evaluate(`getUsers().find(user => user.id === 'TEST-OFFICIAL-2').status === 'REJECTED' && !!getUsers().find(user => user.id === 'TEST-OFFICIAL-2').rejectionReason`), 'Reject official with real prompt and saved reason');
    await go('requests');
    await evaluate(`document.querySelector('button[onclick*="openRequest"][onclick*="REQ-TEST-001"]').click()`);
    await settle();
    assert(await evaluate(`!!document.querySelector('#modalRoot [role="dialog"]') && document.querySelector('#modalRoot').textContent.includes('REQ-TEST-001') && document.querySelector('#modalRoot').textContent.includes('Santos family')`), 'Open request details');
    await screenshot('request-dialog-320');
    await evaluate(`document.querySelector('#modalRoot button[aria-label="Close dialog"]').click()`);
    assert(await evaluate(`!document.getElementById('modalRoot')`), 'Close request details');
    await go('reports');
    await evaluate(`document.querySelector('button[onclick="exportReport()"]').click()`);
    const reportFile = path.join(downloads, 'ayuda-cebu-dsws-summary.json');
    for (let attempt = 0; attempt < 40 && !fs.existsSync(reportFile); attempt++) await new Promise(resolve => setTimeout(resolve, 100));
    const report = fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, 'utf8')) : null;
    assert(report?.requests?.length === 5 && report?.donations?.length === 1 && !!report?.generatedAt, 'Export actual downloadable JSON summary', report && { requests: report.requests.length, donations: report.donations.length });
    }
    assert(!errors.length, 'No browser JavaScript errors', errors);
  } catch (error) {
    results.push({ kind: 'fatal', pass: false, error: error.stack }); console.error(error.stack);
  } finally {
    const resultPath = path.join(output, officialsOnly ? 'dsws-browser-officials-results.json' : mobileOnly ? 'dsws-browser-mobile-results.json' : 'dsws-browser-results.json');
    fs.writeFileSync(resultPath, JSON.stringify({ profile, checkedAt: new Date().toISOString(), results, errors }, null, 2));
    try { await cdp('Browser.close', {}, false); } catch (_) { chrome.kill(); }
    clearTimeout(timer);
    console.log(JSON.stringify({ passed: results.filter(result => result.pass).length, failed: results.filter(result => !result.pass).length, profile, evidence: resultPath }));
    if (results.some(result => !result.pass)) process.exitCode = 1;
  }
})();
