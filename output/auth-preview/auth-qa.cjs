const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const output = __dirname;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { layouts: [], checks: [], exceptions: [], failedRequests: [] };
let browser, socket, server, profile, pending = new Map(), sequence = 0;
function assert(value, message) { report.checks.push({ message, passed: !!value }); if (!value) throw new Error(message); }
function command(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error('Timeout: ' + method)); }, 12000);
    pending.set(id, { resolve: result => { clearTimeout(timeout); resolve(result); }, reject: error => { clearTimeout(timeout); reject(error); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function waitFor(expression) {
  for (let i = 0; i < 50; i++) { if (await evaluate(expression)) return; await delay(100); }
  throw new Error('Condition timed out: ' + expression);
}
async function visit(route, width, height) {
  await command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await command('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/index.html#/${route}` });
  await waitFor('document.readyState === "complete" && !!document.querySelector(".auth-card")');
  await evaluate('document.fonts.ready.then(() => true)');
  await waitFor('Array.from(document.images).every(image => image.complete)');
  await delay(150);
}
async function layout(name, screenshot = true, fullPage = false) {
  const data = await evaluate(`(() => {
    const card = document.querySelector('.auth-card').getBoundingClientRect();
    const form = document.querySelector('.auth-card form').getBoundingClientRect();
    return { width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight, card: {x:card.x,y:card.y,width:card.width,height:card.height},
      form: {x:form.x,y:form.y,width:form.width,height:form.height}, heading: document.querySelector('.auth-card h1').textContent,
      brokenImages: Array.from(document.images).filter(i=>!i.complete || !i.naturalWidth).map(i=>i.src),
      overflows: Array.from(document.querySelectorAll('.auth-card *')).filter(e=>e.getBoundingClientRect().right>innerWidth+1 || e.getBoundingClientRect().left < -1).map(e=>e.tagName+'.'+e.className) };
  })()`);
  report.layouts.push({ name, ...data });
  assert(data.scrollWidth <= data.width, name + ': no horizontal page overflow');
  assert(data.overflows.length === 0, name + ': all form content inside viewport width');
  assert(data.brokenImages.length === 0, name + ': all images loaded');
  if (screenshot) {
    const options = { format: 'png', captureBeyondViewport: fullPage };
    if (fullPage) options.clip = { x:0,y:0,width:data.width,height:data.scrollHeight,scale:1 };
    const image = await command('Page.captureScreenshot', options);
    await fsp.writeFile(path.join(output, name + '.png'), Buffer.from(image.data, 'base64'));
    console.log('Screenshot: ' + name + '.png');
  }
}
(async () => {
  try {
    server = http.createServer(async (request, response) => {
      try {
        const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
        const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
        if (file !== root && !file.startsWith(root + path.sep)) { response.writeHead(403); response.end(); return; }
        const mime = {'.html':'text/html','.js':'application/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml'};
        response.writeHead(200, {'Content-Type':mime[path.extname(file)] || 'application/octet-stream'});
        response.end(await fsp.readFile(file));
      } catch { response.writeHead(404); response.end('Not found'); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'ayuda-auth-qa-'));
    browser = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
      '--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check',
      '--disable-background-networking','--remote-debugging-port=0','--user-data-dir=' + profile,'about:blank'
    ], { windowsHide: true, stdio: ['ignore','pipe','pipe'] });
    let browserLog = '';
    browser.stderr.on('data', chunk => { browserLog += chunk.toString(); });
    browser.on('error', error => { browserLog += error.stack; });
    let port;
    for (let i = 0; i < 100; i++) {
      try { port = (await fsp.readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]; break; } catch {}
      if (browser.exitCode !== null) throw new Error('Browser exited: ' + browser.exitCode + '\n' + browserLog);
      await delay(100);
    }
    if (!port) throw new Error('Browser startup timed out\n' + browserLog);
    const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
    socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        const waiter = pending.get(message.id); pending.delete(message.id);
        message.error ? waiter.reject(new Error(JSON.stringify(message.error))) : waiter.resolve(message.result);
      }
      if (message.method === 'Runtime.exceptionThrown') report.exceptions.push(message.params.exceptionDetails);
      if (message.method === 'Network.loadingFailed' && !message.params.canceled) report.failedRequests.push(message.params);
    });
    await command('Page.enable'); await command('Runtime.enable'); await command('Network.enable');
    await visit('register',1056,593); await layout('register-1056');
    await visit('login',1056,593); await layout('login-1056');
    await visit('register',1440,900); await layout('register-1440');
    await visit('login',1440,900); await layout('login-1440');
    await visit('login',390,844); await layout('login-mobile-390');
    await visit('register',390,844); await layout('register-mobile-390',true,true);
    await visit('login',320,640); await layout('login-mobile-320',true,true);
    await visit('register',320,640); await layout('register-mobile-320',true,true);
    await visit('register?role=household',1056,593); await layout('household-register-1056',true,true);
    assert(await evaluate('!document.getElementById("regBarangayWrap").classList.contains("hidden") && !document.getElementById("regContactWrap").classList.contains("hidden")'), 'Household registration reveals barangay/contact');
    await visit('register?role=household',320,640); await layout('household-register-mobile-320',true,true);
    await visit('register?role=donor',390,844);
    assert(await evaluate('document.getElementById("regBarangayWrap").classList.contains("hidden") && document.getElementById("regContactWrap").classList.contains("hidden")'), 'Donor registration hides barangay/contact');
    await evaluate('document.getElementById("regRole").value="BARANGAY_OFFICIAL";document.getElementById("regRole").dispatchEvent(new Event("change",{bubbles:true}))');
    assert(await evaluate('!document.getElementById("regBarangayWrap").classList.contains("hidden")'), 'Official selection reveals barangay');
    await visit('login',390,844);
    await evaluate('document.getElementById("loginPassword").value="example-password";document.getElementById("loginPasswordToggle").click()');
    assert(await evaluate('document.getElementById("loginPassword").type === "text" && location.hash === "#/login" && !document.querySelector(".toast")'), 'Password toggle reveals text without submitting');
    await evaluate('document.getElementById("loginPasswordToggle").click()');
    assert(await evaluate('document.getElementById("loginPassword").type === "password" && document.getElementById("loginPasswordToggle").getAttribute("aria-label") === "Show password"'), 'Password toggle hides text and updates accessible label');
    await evaluate('document.getElementById("loginEmail").value="dsws@ayuda.local";document.getElementById("loginPassword").value="incorrect";document.querySelector(".auth-card form").requestSubmit()');
    assert(await evaluate('location.hash === "#/login" && document.querySelector(".toast").textContent.includes("Invalid")'), 'Invalid login remains on form with feedback');
    await evaluate('document.getElementById("loginPassword").value="demo123";document.querySelector(".auth-card form").requestSubmit()');
    await waitFor('location.hash === "#/dsws" && !!document.querySelector(".dashboard")');
    assert(true,'Seeded DSWS account login navigates to dashboard');
    await visit('register?role=donor',390,844);
    await evaluate('sessionStorage.clear();document.getElementById("regName").value="Auth QA Donor";document.getElementById("regEmail").value="auth-qa@example.com";document.getElementById("regPassword").value="qa-password-123";document.querySelector(".auth-card form").requestSubmit()');
    assert(await evaluate('JSON.parse(localStorage.getItem("ayudaUsersProV3")).some(u=>u.email === "auth-qa@example.com" && u.role === "DONOR" && u.status === "APPROVED")'), 'Donor registration creates approved prototype account');
    await waitFor('location.hash === "#/login" && !!document.getElementById("loginEmail")');
    await visit('forgot-password',1056,593); await layout('recovery-1056');
    await visit('forgot-password',320,640); await layout('recovery-mobile-320',true,true);
    await evaluate('document.getElementById("recoveryEmail").value="auth-qa@example.com";document.querySelector(".auth-card form").requestSubmit()');
    await waitFor('!!document.getElementById("recoveryCode")');
    await layout('reset-mobile-320',true,true);
    await evaluate('document.getElementById("recoveryCode").value=JSON.parse(sessionStorage.getItem("ayudaPasswordRecovery")).code;document.getElementById("newPassword").value="qa-password-456";document.getElementById("confirmPassword").value="qa-password-456";document.querySelector(".auth-card form").requestSubmit()');
    assert(await evaluate('JSON.parse(localStorage.getItem("ayudaUsersProV3")).find(u=>u.email === "auth-qa@example.com").password === "qa-password-456"'), 'Password recovery saves updated prototype password');
    await waitFor('location.hash === "#/login" && !!document.getElementById("loginEmail")');
    assert(report.exceptions.length === 0, 'No browser JavaScript exceptions');
    assert(report.failedRequests.length === 0, 'No failed resource requests');
    console.log(JSON.stringify({layouts:report.layouts.length,checks:report.checks.length,exceptions:report.exceptions.length,failedRequests:report.failedRequests.length}));
  } catch (error) { report.error = error.stack; console.error(error.stack); process.exitCode=1; }
  finally {
    await fsp.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
    if(socket && socket.readyState === WebSocket.OPEN) { try { await command('Browser.close'); } catch {} socket.close(); }
    if(browser && browser.exitCode === null) browser.kill();
    if(server) { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
    if(profile) console.log('Temporary browser profile: ' + profile);
  }
})();
