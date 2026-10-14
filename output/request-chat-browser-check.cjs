'use strict';
// Run: node output/request-chat-browser-check.cjs
// Isolated integration checks with an in-memory database, synthetic accounts,
// and a temporary headless Chrome profile. Never loads .env or user data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { createApp } = require('../server/app.cjs');
const { hashPassword } = require('../server/security.cjs');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ayuda-request-chat-'));
const results = [], exceptions = [], pending = new Map();
let browser, backend, server, nextId = 0, buffer = '', stderr = '';
const password = 'Synthetic-request-chat-938!';
const requestMessage = 'Hello, when can our household collect the relief packs?';
const officialMessage = 'Your food packs will be ready at the barangay hall at 3 PM.';
const maliciousMessage = '<img src=x onerror="window.requestChatXss=true"> Please confirm pickup. ' + 'x'.repeat(160);
let origin, householdTab, officialTab, donorTab, requestId;
const users = [
  { id: 'CHAT-HOUSEHOLD', name: 'Maria Santos', email: 'chat-household@example.test', role: 'HOUSEHOLD' },
  { id: 'CHAT-OFFICIAL', name: 'Ana Reyes', email: 'chat-official@example.test', role: 'BARANGAY_OFFICIAL' },
  { id: 'CHAT-DONOR', name: 'Community Donor', email: 'chat-donor@example.test', role: 'DONOR' }
].map(user => ({ ...user, barangay: 'Lahug', status: 'APPROVED', contact: '09171234567', createdAt: new Date().toISOString() }));

function cdp(method, params = {}, sessionId) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method + '\n' + stderr)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    browser.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  });
}
async function evaluate(tab, expression) {
  const value = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, tab);
  if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description || value.exceptionDetails.text);
  return value.result.value;
}
async function until(tab, expression, label, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await evaluate(tab, expression);
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  throw new Error('Timed out waiting for ' + label);
}
async function settle(tab) {
  await evaluate(tab, `(async () => {
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
  try { await action(); results.push({ label, pass: true }); console.log('PASS ' + label); }
  catch (error) { results.push({ label, pass: false, error: error.stack }); console.error('FAIL ' + label + '\n' + error.stack); }
}
async function go(tab, role, page) {
  await evaluate(tab, `(async () => { closeModal(); await refreshDashboardData(true); await refreshNotifications(true); goDash(${JSON.stringify(role)}, ${JSON.stringify(page)}); render(); })()`);
  await settle(tab);
}
async function openChat(tab) {
  await evaluate(tab, `openRequestChat(${JSON.stringify(requestId)})`);
  await until(tab, `!!document.querySelector('.request-chat-modal') && !!document.getElementById('requestChatMessages')`, 'request chat');
  await settle(tab);
}
async function send(tab, message, selector = '#requestChatInput', log = '#requestChatMessages') {
  await evaluate(tab, `(() => { const input = document.querySelector(${JSON.stringify(selector)}); input.value=${JSON.stringify(message)}; input.dispatchEvent(new Event('input', {bubbles:true})); input.form.requestSubmit(); })()`);
  await until(tab, `document.querySelector(${JSON.stringify(log)})?.textContent.includes(${JSON.stringify(message)})`, 'sent message');
  assert.equal(await evaluate(tab, `document.querySelector(${JSON.stringify(selector)}).value`), '');
}
async function screenshot(tab, name) {
  await settle(tab);
  const shot = await cdp('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }, tab);
  fs.writeFileSync(path.join(__dirname, name + '.png'), Buffer.from(shot.data, 'base64'));
}
async function viewport(tab, width) {
  await cdp('Emulation.setDeviceMetricsOverride', { width, height: width < 600 ? 844 : 950, deviceScaleFactor: 1, mobile: width < 600 }, tab);
  await settle(tab);
}
async function assertLayout(tab, label) {
  const dimensions = await evaluate(tab, `(() => {
    const dialog = document.querySelector('.request-chat-modal');
    const box = dialog?.getBoundingClientRect();
    const input = document.querySelector('#requestChatInput')?.getBoundingClientRect();
    const submit = document.querySelector('#requestChatInput')?.form.querySelector('button[type="submit"]')?.getBoundingClientRect();
    const log = document.querySelector('#requestChatMessages');
    return { width: innerWidth, height:innerHeight, page: document.documentElement.scrollWidth,
      dialog: dialog && { left: box.left, right: box.right, top: box.top, bottom: box.bottom, client: dialog.clientWidth, scroll: dialog.scrollWidth },
      input:input && {left:input.left,right:input.right,top:input.top,bottom:input.bottom},
      submit:submit && {left:submit.left,right:submit.right,top:submit.top,bottom:submit.bottom},
      log:log && {client:log.clientWidth,scroll:log.scrollWidth} };
  })()`);
  assert.ok(dimensions.page <= dimensions.width + 1, label + ' page overflow: ' + JSON.stringify(dimensions));
  assert.ok(dimensions.dialog, label + ' chat open');
  assert.ok(dimensions.dialog.left >= -1 && dimensions.dialog.right <= dimensions.width + 1, label + ' horizontal fit: ' + JSON.stringify(dimensions));
  assert.ok(dimensions.dialog.top >= -1 && dimensions.dialog.bottom <= dimensions.height + 1, label + ' vertical fit: ' + JSON.stringify(dimensions));
  assert.ok(dimensions.dialog.scroll <= dimensions.dialog.client + 1, label + ' dialog overflow: ' + JSON.stringify(dimensions));
  assert.ok(dimensions.log.scroll <= dimensions.log.client + 1, label + ' message overflow: ' + JSON.stringify(dimensions));
  for (const element of ['input', 'submit']) {
    assert.ok(dimensions[element].left >= -1 && dimensions[element].right <= dimensions.width + 1 && dimensions[element].bottom <= dimensions.height + 1, label + ' ' + element + ' fit: ' + JSON.stringify(dimensions));
  }
}
async function newTab(user) {
  const target = await cdp('Target.createTarget', { url: 'about:blank' });
  const tab = (await cdp('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
  await cdp('Page.enable', {}, tab); await cdp('Runtime.enable', {}, tab);
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 950, deviceScaleFactor: 1, mobile: false }, tab);
  await cdp('Page.navigate', { url: origin }, tab);
  await until(tab, 'typeof refreshAuth === "function" && authState.ready', 'application');
  await evaluate(tab, `(async () => { await api('/api/auth/login', ${JSON.stringify({ email: user.email, password })}); await refreshAuth(); await refreshDashboardData(true); await refreshNotifications(true); goDash(${JSON.stringify(user.role)},'overview'); render(); })()`);
  await settle(tab);
  return tab;
}

async function main() {
  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  origin = 'http://127.0.0.1:' + port;
  backend = await createApp({ databasePath: ':memory:', appOrigin: origin, secureCookies: false,
    otpSecret: 'request-chat-test-secret-0123456789abcdef' });
  const hash = await hashPassword(password);
  for (const user of users) backend.db.prepare('INSERT INTO users (id,email,password_hash,profile) VALUES (?,?,?,?)').run(user.id,user.email,hash,JSON.stringify(user));
  server = backend.app.listen(port, '127.0.0.1'); await once(server, 'listening');
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
  householdTab = await newTab(users[0]);
  requestId = await evaluate(householdTab, `(async () => { const data=await api('/api/requests',{category:'Food',disaster:'Flood',urgency:'Urgent',description:'Our household needs food after flooding.',contact:'09171234567',location:'Synthetic household address',photos:[]}); return data.request.id; })()`);
  officialTab = await newTab(users[1]);

  await check('Pending request stays locked in household and barangay dashboards and detail views', async () => {
    for (const [tab,role,page] of [[householdTab,'HOUSEHOLD','history'],[officialTab,'BARANGAY_OFFICIAL','all']]) {
      await go(tab,role,page);
      assert.equal(await evaluate(tab, `document.querySelectorAll('[onclick^="openRequestChat("]').length`),0);
      await evaluate(tab, `openRequest(${JSON.stringify(requestId)})`); await settle(tab);
      assert.equal(await evaluate(tab, `document.querySelectorAll('[onclick^="openRequestChat("]').length`),0);
      await evaluate(tab, `closeModal(); openRequestChat(${JSON.stringify(requestId)})`);
      assert.equal(await evaluate(tab, `!!document.querySelector('.request-chat-modal')`),false);
    }
  });
  await check('Barangay approval unlocks request chat in both dashboards, home sections, and request details', async () => {
    await go(officialTab,'BARANGAY_OFFICIAL','all');
    await evaluate(officialTab, `document.querySelector('[onclick^="approveRequest("]').click()`);
    await until(officialTab, `getRequests().find(r=>r.id===${JSON.stringify(requestId)})?.status==='Approved' && !!document.querySelector('[onclick^="openRequestChat("]')`, 'approved request action');
    for (const [tab,role,pages,label] of [[householdTab,'HOUSEHOLD',['overview','history'],'Chat with barangay'],[officialTab,'BARANGAY_OFFICIAL',['overview','all'],'Chat with household']]) {
      for (const page of pages) {
        await go(tab,role,page);
        assert.ok(await evaluate(tab, `[...document.querySelectorAll('[onclick^="openRequestChat("]')].some(b=>b.textContent.includes(${JSON.stringify(label)}))`),role+' '+page+' chat action');
      }
      await evaluate(tab, `openRequest(${JSON.stringify(requestId)})`); await settle(tab);
      assert.ok(await evaluate(tab, `!!document.querySelector('#modalRoot [onclick^="openRequestChat("]')`),role+' details chat action');
      await evaluate(tab, `document.querySelector('#modalRoot [onclick^="openRequestChat("]').click()`);
      await until(tab, `!!document.querySelector('.request-chat-modal')`, 'chat from details');
      assert.match(await evaluate(tab, `document.querySelector('#requestChatContext').textContent`), /Approved/);
    }
  });
  await check('Household sends a message and the barangay tab receives it through automatic polling', async () => {
    await openChat(householdTab); await openChat(officialTab);
    await send(householdTab,requestMessage);
    await until(officialTab, `document.querySelector('#requestChatMessages')?.textContent.includes(${JSON.stringify(requestMessage)})`, 'household message polling');
    assert.match(await evaluate(officialTab, `document.querySelector('#requestChatMessages').textContent`),/Maria Santos/);
  });
  await check('Barangay replies and the household tab receives the reply through automatic polling', async () => {
    await send(officialTab,officialMessage);
    await until(householdTab, `document.querySelector('#requestChatMessages')?.textContent.includes(${JSON.stringify(officialMessage)})`, 'official reply polling');
    assert.match(await evaluate(householdTab, `document.querySelector('#requestChatMessages').textContent`),/Ana Reyes/);
  });
  await check('Conversation survives closing, reopening, and a full household page reload', async () => {
    await evaluate(householdTab,'closeModal()'); await openChat(householdTab);
    assert.match(await evaluate(householdTab, `document.querySelector('#requestChatMessages').textContent`),/3 PM/);
    await cdp('Page.reload',{},householdTab);
    await until(householdTab, `authState.ready && !!session() && !dashboardDataCache.loading && getRequests().some(r=>r.id===${JSON.stringify(requestId)})`, 'authenticated household reload');
    await openChat(householdTab);
    const text = await evaluate(householdTab, `document.querySelector('#requestChatMessages').textContent`);
    assert.ok(text.includes(requestMessage)); assert.ok(text.includes(officialMessage));
  });
  await check('New message notification opens the matching household conversation and is marked read', async () => {
    await evaluate(householdTab, `(async () => { closeModal(); await refreshNotifications(true); render(); })()`);
    const id = await evaluate(householdTab, `notificationState.items.find(item=>item.targetType==='request_chat' && item.targetId===${JSON.stringify(requestId)} && !item.readAt)?.id`);
    assert.ok(id);
    await evaluate(householdTab, `document.getElementById('notificationToggle').click()`); await settle(householdTab);
    await evaluate(householdTab, `[...document.querySelectorAll('.notification-item')].find(button=>button.getAttribute('onclick').includes(${JSON.stringify(id)})).click()`);
    await until(householdTab, `!!document.querySelector('.request-chat-modal') && document.querySelector('#requestChatMessages')?.textContent.includes(${JSON.stringify(officialMessage)})`, 'notification conversation');
    assert.ok(await evaluate(householdTab, `notificationState.items.find(item=>item.id===${JSON.stringify(id)})?.readAt`));
  });
  await check('Message content is escaped and long text wraps without creating HTML elements', async () => {
    await send(householdTab,maliciousMessage);
    await until(officialTab, `document.querySelector('#requestChatMessages')?.textContent.includes(${JSON.stringify(maliciousMessage)})`, 'escaped message');
    for (const tab of [householdTab,officialTab]) {
      assert.equal(await evaluate(tab, `document.querySelectorAll('#requestChatMessages img').length`),0);
      assert.equal(await evaluate(tab, 'Boolean(window.requestChatXss)'),false);
    }
  });
  await check('Relief progress updates in the open conversation from Approved to Pledged to Fulfilled', async () => {
    donorTab = await newTab(users[2]);
    await evaluate(donorTab, `api('/api/donations',{requestId:${JSON.stringify(requestId)},type:'Items',amount:'2 family food packs'})`);
    await until(householdTab, `document.querySelector('#requestChatContext')?.textContent.includes('Pledged')`, 'pledge progress polling');
    await evaluate(officialTab, `api('/api/requests/'+${JSON.stringify(requestId)}+'/fulfill',{})`);
    await until(householdTab, `document.querySelector('#requestChatContext')?.textContent.includes('Fulfilled')`, 'fulfilled progress polling');
    await send(householdTab,'We received the packs. Thank you!');
    await until(officialTab, `document.querySelector('#requestChatMessages')?.textContent.includes('We received the packs. Thank you!')`, 'post fulfilment reply');
  });
  for (const width of [1440,390,320]) {
    await check('Household and barangay conversations fit the '+width+'px viewport', async () => {
      for (const [tab,label] of [[householdTab,'household'],[officialTab,'barangay']]) {
        await viewport(tab,width); await assertLayout(tab,label+' '+width);
        await screenshot(tab,'request-chat-'+label+'-'+width);
      }
    });
  }
  await check('Dialog has an accessible conversation log, label, focus trap, and Escape close', async () => {
    await viewport(householdTab,1440);
    assert.equal(await evaluate(householdTab, `document.querySelector('#requestChatMessages').getAttribute('role')`),'log');
    assert.ok(await evaluate(householdTab, `document.querySelector('label[for="requestChatInput"]')?.textContent`));
    await evaluate(householdTab, `getFocusableElements(document.querySelector('.request-chat-modal')).at(-1).focus()`);
    await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9},householdTab);
    await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9},householdTab);
    assert.ok(await evaluate(householdTab, `document.activeElement===getFocusableElements(document.querySelector('.request-chat-modal'))[0]`));
    await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27},householdTab);
    await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27},householdTab);
    assert.equal(await evaluate(householdTab, `!!document.querySelector('.request-chat-modal')`),false);
  });
  await check('Existing donor and barangay general donation chat still exchanges messages', async () => {
    if (!donorTab) donorTab=await newTab(users[2]);
    const donationId = await evaluate(donorTab, `(async () => { const data=await api('/api/donations',{barangay:'Lahug',type:'Items',amount:'20 food packs'}); await refreshDashboardData(true); return data.donation.id; })()`);
    await evaluate(donorTab,`openDonationChat(${JSON.stringify(donationId)})`);
    await send(donorTab,'Donation chat regression message.','#donationChatInput','#donationChatMessages');
    await evaluate(officialTab,`(async () => { closeModal(); await refreshDashboardData(true); await openDonationChat(${JSON.stringify(donationId)}); })()`);
    assert.match(await evaluate(officialTab,`document.querySelector('#donationChatMessages').textContent`),/Donation chat regression message/);
    await send(officialTab,'Barangay received your donor message.','#donationChatInput','#donationChatMessages');
    await until(donorTab,`document.querySelector('#donationChatMessages')?.textContent.includes('Barangay received your donor message.')`,'donor reply polling');
  });
  await check('No unhandled browser exceptions',async () => assert.deepEqual(exceptions,[]));
}

const deadline = setTimeout(() => { console.error('Request chat verification exceeded 3 minutes'); browser?.kill(); process.exitCode=1; },180000);
main().catch(error => { results.push({label:'Harness setup',pass:false,error:error.stack}); console.error(error); }).finally(async () => {
  clearTimeout(deadline);
  for (const handler of pending.values()) clearTimeout(handler.timer);
  if (browser) { try { await cdp('Browser.close'); } catch {} browser.kill(); }
  if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); });
  await backend?.close();
  const report={checkedAt:new Date().toISOString(),passed:results.filter(result=>result.pass).length,failed:results.filter(result=>!result.pass).length,results,exceptions};
  fs.writeFileSync(path.join(__dirname,'request-chat-browser-results.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({passed:report.passed,failed:report.failed}));
  const resolved=path.resolve(profile);
  if (path.dirname(resolved)===path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('ayuda-request-chat-')) {
    try { fs.rmSync(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:100}); } catch {}
  }
  if (report.failed) process.exitCode=1;
});
