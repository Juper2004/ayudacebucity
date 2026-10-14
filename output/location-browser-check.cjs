'use strict';
// Isolated end-to-end verification: temporary Chrome profile and in-memory accounts.
// Run: node output/location-browser-check.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { createApp } = require('../server/app.cjs');

const output = __dirname;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ayuda-location-check-'));
const results = [];
const exceptions = [];
const pending = new Map();
const position = { latitude: 10.302076, longitude: 123.860442, accuracy: 8 };
const coordinates = '10.302076, 123.860442';
const address = 'Test household, Guadalupe, Cebu City, Central Visayas, Philippines';
let browser, backend, server, sessionId, buffer = '', nextId = 0, stderr = '';
let providerCalls = 0;
let tileRequests = 0;
// Keep map tests offline while exercising the actual, locally hosted Leaflet library.
const tilePng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT1cAAAAASUVORK5CYII=';

function cdp(method, params = {}, browserCommand = false) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timed out: ' + method + '\n' + stderr)); }, 20000);
    pending.set(id, { resolve, reject, timer });
    browser.stdio[3].write(JSON.stringify({ id, method, params, ...(!browserCommand && sessionId ? { sessionId } : {}) }) + '\0');
  });
}
async function evaluate(expression) {
  const response = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  return response.result.value;
}
async function until(expression, label, milliseconds = 10000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    const value = await evaluate(expression);
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error('Timed out waiting for ' + label + ': ' + await evaluate('document.getElementById("reqLocationStatus")?.textContent || location.hash'));
}
async function check(label, action) {
  try {
    await action();
    results.push({ label, pass: true });
    console.log('PASS ' + label);
  } catch (error) {
    results.push({ label, pass: false, error: error.stack });
    console.error('FAIL ' + label + '\n' + error.stack);
  }
}
async function screenshot(name) {
  await evaluate('document.documentElement.style.scrollBehavior="auto"; window.scrollTo({top:document.documentElement.scrollHeight,behavior:"instant"})');
  await settleVisuals();
  const shot = await cdp('Page.captureScreenshot', { format: 'png', fromSurface: true });
  fs.writeFileSync(path.join(output, name), Buffer.from(shot.data, 'base64'));
}
async function settleVisuals() {
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
async function freshForm({ fake = true, lookup = 'real' } = {}) {
  await evaluate(`(() => {
    window.fetch = window.__nativeFetch;
    window.setTimeout = window.__nativeSetTimeout;
    if(window.__nativeSecureContextDescriptor) Object.defineProperty(window, 'isSecureContext', window.__nativeSecureContextDescriptor);
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: window.__nativeGeolocation });
    location.hash = '#/household/request'; render();
    window.__geoCalls = []; window.__clearedWatches = []; window.__lookupResolve = null; window.__lookupCalls = [];
    ${fake ? `Object.defineProperty(navigator, 'geolocation', { configurable: true, value: {
      watchPosition(success, error, options) { window.__geoCalls.push({ success, error, options }); return window.__geoCalls.length; },
      clearWatch(id) { window.__clearedWatches.push(id); }
    } });` : ''}
    window.fetch = (url, options) => {
      if(!String(url).includes('/api/location/reverse')) return window.__nativeFetch(url, options);
      window.__lookupCalls.push(JSON.parse(options.body));
      ${lookup === 'pending' ? `return new Promise(resolve => { window.__lookupResolve = address => resolve(new Response(JSON.stringify({ address }), { status:200, headers: {'Content-Type':'application/json'} })); });` : ''}
      ${lookup === 'failed' ? `return Promise.resolve(new Response(JSON.stringify({ message:'Address lookup unavailable' }), { status:503, headers: {'Content-Type':'application/json'} }));` : ''}
      return window.__nativeFetch(url, options);
    };
  })()`);
  await until('!!document.getElementById("reqLocationButton")', 'request location form');
}
async function startFake() {
  await evaluate('document.getElementById("reqLocationButton").click()');
  await until('window.__geoCalls.length > 0', 'geolocation watch start');
}
async function sendPosition(overrides = {}) {
  await evaluate(`window.__geoCalls.at(-1).success({ coords: ${JSON.stringify({ ...position, ...overrides })}, timestamp: Date.now() })`);
}
async function captureDeadline() {
  await evaluate(`window.__locationDeadlines=[]; window.setTimeout=(fn,ms,...args)=>{ if(ms===60000){window.__locationDeadlines.push(()=>fn(...args));return window.__nativeSetTimeout(()=>{},90000);} return window.__nativeSetTimeout(fn,ms,...args); };`);
}
async function expireCapture() {
  assert.equal(await evaluate('window.__locationDeadlines.length'),1,'capture has one 60-second deadline');
  await evaluate('window.__locationDeadlines.forEach(callback=>callback())');
}
async function locationState() {
  return evaluate(`(() => { const field = document.getElementById('reqLocation'); return {
    value: field.value, dataset: {...field.dataset}, status:document.getElementById('reqLocationStatus').textContent,
    result:document.getElementById('reqLocationResult').textContent,
    links:[...document.querySelectorAll('#reqLocationResult a')].map(a => ({href:a.href, target:a.target, rel:a.rel})),
    disabled:document.getElementById('reqLocationButton').disabled
  }; })()`);
}
async function openMap() {
  await evaluate('document.getElementById("reqLocationMapButton").click()');
  await until('typeof locationMapPicker !== "undefined" && !!locationMapPicker?.map', 'local Leaflet map initialization');
  await settleVisuals();
}
async function selectMapPoint(latitude = position.latitude, longitude = position.longitude) {
  await evaluate(`(() => {
    const map = locationMapPicker.map;
    map.setView([${latitude}, ${longitude}], 18, {animate:false});
    map.fire('click', {latlng:L.latLng(${latitude}, ${longitude})});
  })()`);
  await until('!document.getElementById("reqLocationMapConfirm").disabled', 'explicit map selection ready');
}
async function fillRequest(category = 'Food', description = 'Synthetic location verification request.') {
  await evaluate(`(() => {
    document.getElementById('reqCategory').value = ${JSON.stringify(category)};
    document.getElementById('reqDisaster').value = 'Flood';
    document.getElementById('reqDescription').value = ${JSON.stringify(description)};
    const canvas = document.createElement('canvas'); canvas.width = 4; canvas.height = 4;
    canvas.getContext('2d').fillRect(0,0,4,4);
    const bytes = Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]), c => c.charCodeAt(0));
    const transfer = new DataTransfer(); transfer.items.add(new File([bytes], 'verification.png', {type:'image/png'}));
    document.getElementById('reqPhotos').files = transfer.files;
  })()`);
}

async function main() {
  const reservation = net.createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const origin = 'http://127.0.0.1:' + port;
  backend = await createApp({
    databasePath: ':memory:', appOrigin: origin, secureCookies: false,
    otpSecret: 'location-browser-test-secret-0123456789abcdef',
    geocoding: { fetch: async () => {
      providerCalls++;
      return new Response(JSON.stringify({ display_name: address }), { status:200, headers:{'Content-Type':'application/json'} });
    } }
  });
  server = backend.app.listen(port, '127.0.0.1');
  await once(server, 'listening');
  const registration = await fetch(origin + '/api/auth/register', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({ name:'Location Test Household', email:'location-check@example.test', password:'Location-test-password-938!', role:'HOUSEHOLD', barangay:'Guadalupe', contact:'09171234567' })
  });
  assert.equal(registration.status, 201);
  const { user } = await registration.json();
  user.status = 'APPROVED';
  backend.db.prepare('UPDATE users SET profile = ? WHERE id = ?').run(JSON.stringify(user), user.id);

  const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  browser = spawn(chromePath, [
    '--headless=new', '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-extensions', '--disable-sync',
    '--disable-features=Translate,OptimizationHints,MediaRouter', '--user-data-dir=' + profile, 'about:blank'
  ], { windowsHide: true, stdio:['ignore','ignore','pipe','pipe','pipe'] });
  browser.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
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
      } else if (message.method === 'Fetch.requestPaused') {
        tileRequests++;
        cdp('Fetch.fulfillRequest', {
          requestId: message.params.requestId, responseCode: 200,
          responseHeaders: [{name:'Content-Type', value:'image/png'}, {name:'Cache-Control', value:'max-age=3600'}],
          body: tilePng
        }).catch(error => exceptions.push('Offline tile response: ' + error.message));
      }
    }
  });
  browser.on('error', error => { stderr += error.message; });
  const target = await cdp('Target.createTarget', {url:'about:blank'}, true);
  sessionId = (await cdp('Target.attachToTarget', {targetId:target.targetId, flatten:true}, true)).sessionId;
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await cdp('Fetch.enable', {patterns:[{urlPattern:'*tile.openstreetmap.org/*', requestStage:'Request'}]});
  await cdp('Browser.grantPermissions', {origin, permissions:['geolocation']}, true);
  await cdp('Emulation.setGeolocationOverride', position);
  await cdp('Emulation.setDeviceMetricsOverride', {width:1440,height:1050,deviceScaleFactor:1,mobile:false});
  await cdp('Page.navigate', {url:origin});
  await until('typeof refreshAuth === "function" && authState.ready', 'app load');
  await evaluate(`(async () => {
    await api('/api/auth/login', {email:'location-check@example.test',password:'Location-test-password-938!'});
    await refreshAuth(); location.hash = '#/household/request'; render();
    window.__nativeFetch = window.fetch; window.__nativeGeolocation = navigator.geolocation; window.__nativeSetTimeout = window.setTimeout;
    window.__nativeSecureContextDescriptor=Object.getOwnPropertyDescriptor(window,'isSecureContext');
  })()`);

  await check('Native browser location resolves an address through same-origin CSP', async () => {
    await freshForm({fake:false});
    await evaluate('document.getElementById("reqLocationButton").click()');
    await cdp('Emulation.setGeolocationOverride',position);
    await until(`document.getElementById('reqLocation').value === ${JSON.stringify(address)}`, 'reverse-geocoded address');
    const state = await locationState();
    assert.equal(state.dataset.coordinates, coordinates);
    assert.equal(state.dataset.source, 'device');
    assert.equal(Number(state.dataset.accuracy), 8);
    assert.ok(Number.isFinite(Date.parse(state.dataset.capturedAt)));
    assert.ok(providerCalls > 0, 'actual injected server provider was called');
    assert.ok(state.links.some(link => link.href.includes('10.302076') && link.href.includes('123.860442')));
    assert.match(state.result, /8\s*m|8\s*met/i);
    const response = await fetch(origin);
    assert.match(response.headers.get('content-security-policy'), /connect-src 'self'/);
    await screenshot('location-household-desktop.png');
  });
  await check('Location panel fits mobile screens', async () => {
    await cdp('Emulation.setDeviceMetricsOverride', {width:390,height:844,deviceScaleFactor:1,mobile:true});
    await screenshot('location-household-mobile.png');
    assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'));
    await cdp('Emulation.setDeviceMetricsOverride', {width:320,height:800,deviceScaleFactor:1,mobile:true});
    assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'));
    await cdp('Emulation.setDeviceMetricsOverride', {width:1440,height:1050,deviceScaleFactor:1,mobile:false});
  });
  await check('GPS requests a fresh, high-accuracy fix and immediately saves coordinates', async () => {
    await freshForm({lookup:'pending'}); await startFake();
    const options = await evaluate('window.__geoCalls.at(-1).options');
    assert.equal(options.enableHighAccuracy, true);
    assert.equal(options.maximumAge, 0);
    assert.ok(options.timeout > 0 && options.timeout <= 20000);
    await sendPosition();
    const state = await locationState();
    assert.equal(state.dataset.coordinates, coordinates);
    assert.equal(Number(state.dataset.accuracy), 8);
    assert.ok(await evaluate('window.__clearedWatches.length > 0'), 'watch stops for an accurate fix');
  });
  await check('Unavailable address lookup preserves usable GPS and map link', async () => {
    await freshForm({lookup:'failed'}); await startFake(); await sendPosition();
    await until('!document.getElementById("reqLocationButton").disabled', 'lookup failure recovery');
    const state = await locationState();
    assert.equal(state.value, coordinates);
    assert.equal(state.dataset.coordinates, coordinates);
    assert.match(state.status, /address|lookup|coordinates/i);
    assert.ok(state.links.length > 0);
  });
  for (const [code, expression, label] of [[1,/permission|blocked|allow/i,'denied'],[2,/waiting|retry|trying|signal|unavailable|determine/i,'temporarily unavailable'],[3,/waiting|retry|trying|signal|timed out/i,'temporarily timed out']]) {
    await check('Specific guidance when location is ' + label, async () => {
      await freshForm(); await captureDeadline(); await startFake();
      await evaluate(`window.__geoCalls.at(-1).error({code:${code},message:'Synthetic location failure'})`);
      const state = await locationState();
      assert.match(state.status, expression);
      assert.equal(state.disabled, code !== 1);
      assert.ok(!state.dataset.coordinates);
      if(code!==1) {
        await until('window.__geoCalls.length > 1','automatic retry after transient error');
        await sendPosition();
        assert.equal((await locationState()).dataset.coordinates,coordinates,'same click accepts a later accurate reading');
      }
    });
  }
  await check('Unsupported browsers offer manual address entry', async () => {
    await freshForm();
    await evaluate(`Object.defineProperty(navigator,'geolocation',{configurable:true,value:undefined});captureGps();`);
    const state=await locationState();
    assert.match(state.status,/not support|unsupported/i);assert.equal(state.disabled,false);
    assert.equal(await evaluate('window.__geoCalls.length'),0);
  });
  await check('Insecure contexts explain HTTPS or localhost requirements', async () => {
    await freshForm();
    assert.ok(await evaluate('window.__nativeSecureContextDescriptor?.configurable'));
    await evaluate(`Object.defineProperty(window,'isSecureContext',{configurable:true,value:false});captureGps();`);
    const state=await locationState();
    assert.match(state.status,/HTTPS/);assert.match(state.status,/localhost/);assert.equal(state.disabled,false);
    assert.equal(await evaluate('window.__geoCalls.length'),0);
  });
  await check('Manual edits clear saved GPS and defeat late address responses', async () => {
    await freshForm({lookup:'pending'}); await startFake(); await sendPosition();
    await until('typeof window.__lookupResolve === "function"', 'address request start');
    await evaluate(`(() => { const field=document.getElementById('reqLocation'); field.value='Manually confirmed household entrance'; field.dispatchEvent(new Event('input', {bubbles:true})); window.__lookupResolve('Stale address'); })()`);
    await new Promise(resolve => setTimeout(resolve, 50));
    const state = await locationState();
    assert.equal(state.value, 'Manually confirmed household entrance');
    assert.ok(!state.dataset.coordinates && !state.dataset.accuracy && !state.dataset.capturedAt);
  });
  await check('Editing while locating cancels capture and ignores late GPS callbacks', async () => {
    await freshForm(); await startFake();
    await evaluate(`(() => { const field=document.getElementById('reqLocation'); field.value='Near barangay hall'; field.dispatchEvent(new Event('input', {bubbles:true})); })()`);
    await sendPosition();
    const state = await locationState();
    assert.equal(state.value, 'Near barangay hall'); assert.ok(!state.dataset.coordinates);
    assert.ok(await evaluate('window.__clearedWatches.length > 0'));
  });
  await check('Navigation invalidates old geolocation callbacks', async () => {
    await freshForm(); await startFake();
    await evaluate(`window.__oldGeoCall=window.__geoCalls.at(-1); location.hash='#/household/history'; render(); location.hash='#/household/request'; render();`);
    await evaluate(`window.__oldGeoCall.success({coords:${JSON.stringify(position)},timestamp:Date.now()})`);
    const state = await locationState(); assert.equal(state.value, ''); assert.ok(!state.dataset.coordinates);
  });
  await check('Page hiding stops location work and leaves a usable form', async () => {
    await freshForm();await startFake();
    await evaluate(`window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}))`);
    await sendPosition();
    const state=await locationState();assert.equal(state.disabled,false);assert.equal(state.value,'');
    assert.match(state.status,/stopped|cancel/i);assert.ok(await evaluate('window.__clearedWatches.length>0'));
  });
  await check('Cancel button stops GPS without filling the field later', async () => {
    await freshForm(); await startFake();
    await evaluate('document.getElementById("reqLocationCancel").click()'); await sendPosition();
    const state = await locationState(); assert.equal(state.value, ''); assert.equal(state.disabled, false);
    assert.ok(!state.dataset.coordinates);
  });
  await check('Capture deadline ends a silent GPS watch', async () => {
    await freshForm();await captureDeadline();await startFake();await expireCapture();
    const state = await locationState(); assert.equal(state.disabled, false); assert.match(state.status,/time.?out|timed out|too long/i);
    assert.ok(await evaluate('window.__clearedWatches.length > 0'));
  });
  await check('One click waits through 271m and 45m readings before accepting 8m', async () => {
    await freshForm({lookup:'pending'});await startFake();
    for(const accuracy of [271,45]) {
      await sendPosition({accuracy});const state=await locationState();
      assert.equal(state.value,'');assert.ok(!state.dataset.coordinates&&!state.dataset.accuracy&&!state.dataset.capturedAt);
      assert.equal(state.disabled,true);assert.equal(state.links.length,0);
      assert.equal(await evaluate('window.__lookupCalls.length'),0,'coarse reading never reaches address lookup');
    }
    await sendPosition();
    const state=await locationState();assert.equal(state.dataset.coordinates,coordinates);assert.equal(Number(state.dataset.accuracy),8);
    assert.equal(await evaluate('window.__geoCalls.length'),1,'one click starts one continuous watch');
    assert.equal(await evaluate('window.__lookupCalls.length'),1,'only accepted reading triggers lookup');
  });
  await check('A 271m reading times out without saving a pin or looking up an address', async () => {
    await freshForm({lookup:'pending'});await captureDeadline();await startFake();
    await sendPosition({accuracy:271});await screenshot('location-coarse-pending.png');
    await sendPosition({accuracy:400});await expireCapture();
    const state=await locationState();
    assert.equal(state.value,'');assert.ok(!state.dataset.coordinates&&!state.dataset.accuracy&&!state.dataset.capturedAt);
    assert.equal(state.disabled,false);assert.equal(state.links.length,0);
    assert.match(state.status,/precis|accur|10\s*m/i);assert.equal(await evaluate('window.__lookupCalls.length'),0);
    await screenshot('location-coarse-rejected.png');
  });
  await check('A coarse reading blocks submission and cancellation never saves it', async () => {
    await freshForm({lookup:'pending'});await fillRequest('Medical','Synthetic rejected coarse location.');await startFake();
    await sendPosition({accuracy:271});await evaluate('document.getElementById("reqLocation").form.requestSubmit()');
    assert.ok(await evaluate(`!getRequests().some(request=>request.description==='Synthetic rejected coarse location.')`));
    assert.equal((await locationState()).disabled,true);
    await evaluate('document.getElementById("reqLocationCancel").click()');
    const state=await locationState();assert.equal(state.value,'');assert.ok(!state.dataset.coordinates);assert.equal(await evaluate('window.__lookupCalls.length'),0);
  });
  await check('Stale or invalid timestamps never qualify even with 8m accuracy', async () => {
    await freshForm({lookup:'pending'});await startFake();
    for(const timestamp of ['Date.now()-120000','NaN','Infinity','null','undefined','Date.now()+120000']) {
      await evaluate(`window.__geoCalls.at(-1).success({coords:${JSON.stringify(position)},timestamp:${timestamp}})`);
      const state=await locationState();assert.equal(state.value,'');assert.ok(!state.dataset.coordinates);assert.equal(state.disabled,true);
      assert.equal(await evaluate('window.__lookupCalls.length'),0);
    }
    await sendPosition();assert.equal((await locationState()).dataset.coordinates,coordinates);
  });
  await check('Invalid or zero device accuracy cannot produce an automatic pin', async () => {
    await freshForm({lookup:'pending'});await startFake();
    for(const accuracy of ['0','-1','NaN','Infinity']) {
      await evaluate(`window.__geoCalls.at(-1).success({coords:{...${JSON.stringify(position)},accuracy:${accuracy}},timestamp:Date.now()})`);
      const state=await locationState();assert.equal(state.value,'');assert.ok(!state.dataset.coordinates);assert.equal(state.disabled,true);
      assert.equal(await evaluate('window.__lookupCalls.length'),0);
    }
    await sendPosition();assert.equal((await locationState()).dataset.coordinates,coordinates);
  });
  await check('Permission denial after a coarse reading rejects the automatic pin', async () => {
    await freshForm({lookup:'pending'});await startFake();await sendPosition({accuracy:271});
    await evaluate(`window.__geoCalls.at(-1).error({code:1,message:'Permission revoked'})`);
    const state=await locationState();assert.equal(state.disabled,false);assert.equal(state.value,'');assert.ok(!state.dataset.coordinates);
    assert.match(state.status,/permission|blocked|allow/i);assert.equal(await evaluate('window.__lookupCalls.length'),0);
  });
  await check('A new capture clears a previously accepted automatic address and pin', async () => {
    await freshForm({lookup:'pending'});await startFake();await sendPosition();
    await evaluate(`window.__lookupResolve(${JSON.stringify(address)})`);
    await until('!document.getElementById("reqLocationButton").disabled','first capture completed');
    await startFake();
    const state=await locationState();assert.equal(state.value,'');assert.ok(!state.dataset.coordinates&&!state.dataset.accuracy&&!state.dataset.capturedAt);
    assert.equal(state.disabled,true);assert.equal(state.links.length,0);
  });
  await check('Coarse capture automatically reacquires and ignores superseded watch callbacks', async () => {
    await freshForm({lookup:'pending'});
    await evaluate(`window.__locationRetries=[];window.setTimeout=(fn,ms,...args)=>{if(ms===15000){window.__locationRetries.push(()=>fn(...args));return window.__nativeSetTimeout(()=>{},90000);}return window.__nativeSetTimeout(fn,ms,...args);};`);
    await startFake();await sendPosition({accuracy:271});
    await evaluate('window.__supersededWatch=window.__geoCalls.at(-1)');
    assert.ok(await evaluate('window.__locationRetries.length>0'),'capture schedules automatic reacquisition');
    await evaluate('window.__locationRetries.shift()()');
    await until('window.__geoCalls.length > 1','automatic watch restart');
    await evaluate(`window.__supersededWatch.success({coords:${JSON.stringify(position)},timestamp:Date.now()});window.__supersededWatch.error({code:1,message:'Stale denial'})`);
    const state=await locationState();assert.equal(state.disabled,true);assert.equal(state.value,'');assert.ok(!state.dataset.coordinates);
    assert.equal(await evaluate('window.__lookupCalls.length'),0);
    await sendPosition();assert.equal((await locationState()).dataset.coordinates,coordinates);
  });
  await check('Failed precision capture preserves a manually entered household address', async () => {
    await freshForm({lookup:'pending'});await captureDeadline();
    await evaluate(`const manualField=document.getElementById('reqLocation');manualField.value='House beside barangay hall';manualField.dispatchEvent(new Event('input',{bubbles:true}));`);
    await startFake();await sendPosition({accuracy:271});await expireCapture();
    const state=await locationState();assert.equal(state.value,'House beside barangay hall');assert.ok(!state.dataset.coordinates);assert.equal(state.disabled,false);
  });
  await check('Manual coordinates create a map pin without claiming device accuracy', async () => {
    await freshForm();
    await evaluate(`(() => {const field=document.getElementById('reqLocation');field.value='10.302076, 123.860442';field.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    const state=await locationState();
    assert.equal(state.dataset.coordinates,coordinates);
    assert.equal(state.dataset.source,'manual');
    assert.ok(!state.dataset.accuracy && !state.dataset.capturedAt);
    assert.ok(state.links.some(link=>link.href.includes('10.302076')&&link.href.includes('123.860442')));
    await fillRequest('Water','Synthetic manually entered coordinates.');
    await evaluate('document.getElementById("reqLocation").form.requestSubmit()');
    const request=await until(`getRequests().find(request=>request.description==='Synthetic manually entered coordinates.')`,'manual coordinates saved');
    assert.equal(request.gps,coordinates);assert.equal(request.gpsAccuracy,undefined);assert.equal(request.gpsCapturedAt,undefined);
    assert.equal(request.locationSource,'manual');
  });
  await check('Map assets and tiles load only after an explicit map action', async () => {
    await freshForm();
    assert.equal(tileRequests,0,'GPS and address entry do not load third-party map tiles');
    assert.equal(await evaluate('typeof L'), 'undefined', 'Leaflet is loaded only when requested');
    await openMap();
    assert.ok(await evaluate('!!L?.map && [...document.scripts].some(script=>new URL(script.src).pathname.startsWith("/vendor/leaflet/"))'));
    assert.ok(await evaluate('[...document.querySelectorAll("link[rel=stylesheet]")].some(link=>new URL(link.href).pathname.startsWith("/vendor/leaflet/"))'));
    await until('document.querySelectorAll("#reqLocationMapCanvas .leaflet-tile-loaded").length > 0', 'offline intercepted tiles');
    assert.ok(tileRequests>0);
    assert.equal(await evaluate('locationMapPicker.selected'),null,'Cebu default center is not an automatic household pin');
    assert.equal(await evaluate('document.getElementById("reqLocationMapConfirm").disabled'),true);
    assert.ok(!(await locationState()).dataset.coordinates);
    await evaluate('closeLocationMap()');
  });
  await check('A 182m device estimate previews the map but needs an explicit close-up selection', async () => {
    await freshForm({lookup:'pending'});await startFake();await sendPosition({accuracy:182});
    await openMap();
    const preview = await evaluate('({selected:locationMapPicker.selected,center:locationMapPicker.map.getCenter(),zoom:locationMapPicker.map.getZoom(),disabled:document.getElementById("reqLocationMapConfirm").disabled})');
    assert.equal(preview.selected,null);assert.equal(preview.disabled,true);
    assert.ok(Math.abs(preview.center.lat-position.latitude)<0.001 && Math.abs(preview.center.lng-position.longitude)<0.001,'map starts around the coarse estimate');
    assert.ok(!(await locationState()).dataset.coordinates,'opening a rough estimate never saves it');
    await evaluate(`locationMapPicker.map.setView([${position.latitude},${position.longitude}],16,{animate:false});locationMapPicker.map.fire('click',{latlng:L.latLng(${position.latitude},${position.longitude})});`);
    assert.equal(await evaluate('document.getElementById("reqLocationMapConfirm").disabled'),true,'wide map views cannot confirm a household pin');
    await evaluate('confirmLocationMapPin()');
    assert.ok(!(await locationState()).dataset.coordinates,'calling confirm cannot bypass the zoom requirement');
    await selectMapPoint();await evaluate('confirmLocationMapPin()');
    const state=await locationState();
    assert.equal(state.dataset.coordinates,coordinates);assert.equal(state.dataset.source,'map');
    assert.ok(Number.isFinite(Date.parse(state.dataset.confirmedAt)));
    assert.ok(!state.dataset.accuracy&&!state.dataset.capturedAt,'manual map confirmation claims no GPS precision');
    assert.match(state.result,/confirmed on map/i);assert.equal(state.disabled,false);
    await fillRequest('Shelter','Synthetic confirmed household map pin.');
    await evaluate('document.getElementById("reqLocation").form.requestSubmit()');
    const request=await until(`getRequests().find(request=>request.description==='Synthetic confirmed household map pin.')`,'confirmed map request saved');
    assert.equal(request.gps,coordinates);assert.equal(request.locationSource,'map');
    assert.ok(Number.isFinite(Date.parse(request.locationConfirmedAt)));
    assert.equal(request.gpsAccuracy,undefined);assert.equal(request.gpsCapturedAt,undefined);
    await evaluate(`openRequest(${JSON.stringify(request.id)})`);
    assert.match(await evaluate('document.querySelector("[role=dialog]").textContent'),/confirmed on map/i);
  });
  await check('Closing an unconfirmed map change keeps the previous saved pin', async () => {
    await freshForm();
    await evaluate(`const field=document.getElementById('reqLocation');field.value='${coordinates}';field.dispatchEvent(new Event('input',{bubbles:true}));`);
    const before=await locationState();await openMap();await selectMapPoint(10.303,123.861);
    await evaluate('closeLocationMap()');
    const after=await locationState();assert.equal(after.value,before.value);assert.deepEqual(after.dataset,before.dataset);
  });
  await check('Map confirmation defeats late geolocation and reverse-address callbacks', async () => {
    await freshForm({lookup:'pending'});await startFake();await sendPosition();
    await until('typeof window.__lookupResolve === "function"','pending address for device fix');
    await evaluate('window.__oldLookupResolve=window.__lookupResolve;window.__oldGeoCall=window.__geoCalls.at(-1)');
    await openMap();await selectMapPoint(10.303,123.861);await evaluate('confirmLocationMapPin()');
    await evaluate(`window.__oldLookupResolve('Stale device address');window.__oldGeoCall.success({coords:${JSON.stringify(position)},timestamp:Date.now()})`);
    await new Promise(resolve=>setTimeout(resolve,50));
    const state=await locationState();assert.equal(state.dataset.coordinates,'10.303000, 123.861000');assert.equal(state.dataset.source,'map');
    assert.notEqual(state.value,'Stale device address');assert.ok(!state.dataset.accuracy&&!state.dataset.capturedAt);
  });
  await check('Typing an address invalidates an open map selection', async () => {
    await freshForm();await openMap();await selectMapPoint();
    await evaluate(`const field=document.getElementById('reqLocation');field.value='Household entrance near school';field.dispatchEvent(new Event('input',{bubbles:true}));confirmLocationMapPin();`);
    const state=await locationState();assert.equal(state.value,'Household entrance near school');
    assert.ok(!state.dataset.coordinates&&!state.dataset.source&&!state.dataset.confirmedAt);
  });
  await check('Navigation releases the map and ignores its old selection', async () => {
    await freshForm();await openMap();await selectMapPoint();
    await evaluate(`window.__oldMap=locationMapPicker.map;location.hash='#/household/history';render();location.hash='#/household/request';render();`);
    assert.equal(await evaluate('!!locationMapPicker'),false);
    assert.equal(await evaluate('window.__oldMap.getContainer().isConnected'),false);
    await evaluate('confirmLocationMapPin()');assert.ok(!(await locationState()).dataset.coordinates);
  });
  await check('Map fits small screens and supports keyboard center selection', async () => {
    await freshForm();await openMap();
    try {
      for(const width of [390,320]) {
        await cdp('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:true});
        await evaluate('locationMapPicker.map.invalidateSize({animate:false})');await settleVisuals();
        assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'),'map fits '+width+'px viewport');
      }
      await evaluate(`locationMapPicker.map.setView([${position.latitude},${position.longitude}],18,{animate:false});document.getElementById('reqLocationMapCenter').focus()`);
      assert.equal(await evaluate('document.activeElement.id'),'reqLocationMapCenter');
      await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
      await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
      await until('!document.getElementById("reqLocationMapConfirm").disabled','keyboard center selection');
      assert.ok(await evaluate('!!locationMapPicker.selected'));
      await screenshot('location-map-mobile.png');
      await evaluate('confirmLocationMapPin()');assert.equal((await locationState()).dataset.source,'map');
    } finally {
      await cdp('Emulation.setDeviceMetricsOverride',{width:1440,height:1050,deviceScaleFactor:1,mobile:false});
    }
  });
  await check('Submission waits for a fix; cancellation permits an optional empty location', async () => {
    await freshForm();await fillRequest('Utility','Synthetic cancelled optional location.');await startFake();
    await evaluate('document.getElementById("reqLocation").form.requestSubmit()');
    assert.ok(await evaluate(`!getRequests().some(request=>request.description==='Synthetic cancelled optional location.')`));
    assert.ok(await evaluate('!!document.getElementById("reqLocation")'));
    await evaluate('document.getElementById("reqLocationCancel").click();document.getElementById("reqLocation").form.requestSubmit()');
    const request=await until(`getRequests().find(request=>request.description==='Synthetic cancelled optional location.')`,'request after cancellation');
    assert.equal(request.location,'Not provided');assert.equal(request.gps,'Not provided');
  });
  await check('Submitting during address lookup preserves GPS, accuracy, and timestamp', async () => {
    await freshForm({lookup:'pending'}); await fillRequest(); await startFake(); await sendPosition();
    await evaluate('document.getElementById("reqLocation").form.requestSubmit()');
    const request = await until(`getRequests().find(request=>request.description === 'Synthetic location verification request.')`, 'saved request');
    assert.equal(request.gps, coordinates); assert.equal(Number(request.gpsAccuracy), 8);
    assert.ok(Number.isFinite(Date.parse(request.gpsCapturedAt)));
    await evaluate(`openRequest(${JSON.stringify(request.id)})`);
    assert.ok(await evaluate(`document.querySelector('[role="dialog"]').textContent.includes(${JSON.stringify(coordinates)})`));
    assert.ok(await evaluate(`[...document.querySelectorAll('[role="dialog"] a')].some(link=>link.href.includes('10.302076')&&link.href.includes('123.860442'))`));
    await settleVisuals();
    const shot = await cdp('Page.captureScreenshot',{format:'png',fromSurface:true});
    fs.writeFileSync(path.join(output,'location-request-details.png'),Buffer.from(shot.data,'base64'));
  });
  await check('No unhandled browser exceptions', async () => assert.deepEqual(exceptions, []));
}

const deadline = setTimeout(() => { console.error('Location verification exceeded 3 minutes'); browser?.kill(); process.exitCode = 1; }, 180000);
main().catch(error => { results.push({label:'Harness setup',pass:false,error:error.stack}); console.error(error); }).finally(async () => {
  clearTimeout(deadline);
  for (const handler of pending.values()) clearTimeout(handler.timer);
  if (browser) { try { await cdp('Browser.close', {}, true); } catch {} browser.kill(); }
  if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); });
  await backend?.close();
  const report = { passed:results.filter(result=>result.pass).length, failed:results.filter(result=>!result.pass).length, providerCalls, tileRequests, results, exceptions };
  fs.writeFileSync(path.join(output,'location-browser-results.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({passed:report.passed,failed:report.failed,providerCalls}));
  const resolved = path.resolve(profile);
  if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('ayuda-location-check-')) {
    try { fs.rmSync(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:100}); } catch {}
  }
  if (report.failed) process.exitCode=1;
});
