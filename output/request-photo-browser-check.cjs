// Isolated, synthetic browser checks for request details and submitted-photo viewing.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output');
const profile = path.join(require('node:os').tmpdir(), 'ayuda-request-photo-check-' + Date.now());
fs.mkdirSync(profile, { recursive: true });
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
chrome.on('error', error => { console.error(error); clearTimeout(timer); process.exitCode = 1; });
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
function assert(pass, label, details) {
  results.push({ pass: !!pass, label, ...(details === undefined ? {} : { details }) });
  if (!pass) console.error('FAIL ' + label + ': ' + JSON.stringify(details));
}
async function check(expression, label) { assert(await evaluate(expression), label); }
async function click(selector) { await evaluate('document.querySelector(' + JSON.stringify(selector) + ').click()'); await settle(); }
async function key(key, modifiers = 0) {
  const keyCode = { Tab: 9, Escape: 27, ArrowLeft: 37, ArrowRight: 39 }[key];
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: keyCode, modifiers });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: keyCode, modifiers });
  await settle();
}
async function screenshot(name) {
  const shot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
  fs.writeFileSync(path.join(output, name + '.png'), Buffer.from(shot.data, 'base64'));
}
async function actor(id) {
  await evaluate('closeModal(); setSession(getUsers().find(u=>u.id===' + JSON.stringify(id) + '));');
}
async function open(id = 'REQ-PHOTO-001-1234567890') {
  await evaluate('openRequest(' + JSON.stringify(id) + ')'); await settle();
}
const storageExpression = 'JSON.stringify(Object.fromEntries(Object.values(STORAGE).map(key=>[key,localStorage.getItem(key)])))';
(async () => {
  try {
    const target = await cdp('Target.createTarget', { url: 'about:blank' }, false);
    sessionId = (await cdp('Target.attachToTarget', { targetId: target.targetId, flatten: true }, false)).sessionId;
    await cdp('Runtime.enable'); await cdp('Page.enable');
    await cdp('Page.navigate', { url: pathToFileURL(path.join(root, 'index.html')).href });
    for (let i = 0; i < 60; i++) {
      if (await evaluate('document.readyState === "complete" && typeof getUsers === "function"')) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await evaluate(`(() => {
      const now = new Date().toISOString();
      const common = { password:'SyntheticTest123!',status:'APPROVED',contact:'0917 555 0100',createdAt:now };
      const users = [
        {...common,id:'PHOTO-HOUSEHOLD',name:'Maria Santos',email:'maria@example.test',role:'HOUSEHOLD',barangay:'Lahug'},
        {...common,id:'PHOTO-OTHER-HOUSEHOLD',name:'Other Household',email:'other@example.test',role:'HOUSEHOLD',barangay:'Lahug'},
        {...common,id:'PHOTO-OFFICIAL',name:'Ana Reyes',email:'ana@example.test',role:'BARANGAY_OFFICIAL',barangay:'Lahug'},
        {...common,id:'PHOTO-OTHER-OFFICIAL',name:'Other Official',email:'official@example.test',role:'BARANGAY_OFFICIAL',barangay:'Apas'},
        {...common,id:'PHOTO-DONOR',name:'Community Donor',email:'donor@example.test',role:'DONOR'},
        {...common,id:'PHOTO-REVOKED',name:'Revoked Donor',email:'revoked@example.test',role:'DONOR',status:'REJECTED'},
        {...common,id:'ACC-1001',name:'DSWS Administrator',email:'dsws@ayuda.local',role:'DSWS_ADMIN'}
      ];
      const photos = [[480,760,'Portrait attachment','#23664d'],[1000,500,'Landscape attachment','#156796'],[600,600,'Square attachment','#825c36']].map(([width,height,label,color])=>{
        const canvas=document.createElement('canvas'); canvas.width=width; canvas.height=height;
        const context=canvas.getContext('2d'); context.fillStyle=color; context.fillRect(0,0,width,height);
        context.strokeStyle='#ffffff'; context.lineWidth=12; context.strokeRect(18,18,width-36,height-36);
        context.fillStyle='#ffffff'; context.font='bold 28px sans-serif'; context.textAlign='center';
        context.fillText(label,width/2,height/2); context.font='18px sans-serif'; context.fillText('Synthetic test image',width/2,height/2+35);
        return canvas.toDataURL('image/png');
      });
      window.fixturePhotos=photos;
      const request = {id:'REQ-PHOTO-001-1234567890',householdId:'PHOTO-HOUSEHOLD',household:'Maria Santos',barangay:'Lahug',contact:common.contact,category:'Food',disaster:'Flood',urgency:'Urgent',status:'Under Verification',location:'Doña Modesta Gaisano Street, Lahug, Cebu City, Central Visayas, 6000, Philippines',description:'Our household needs food, drinking water, and essential supplies after the flooding. Photos show the current situation at our home.',photos,createdAt:now};
      return commitRecords({users,requests:[request,{...request,id:'REQ-EMPTY',photos:[]},{...request,id:'REQ-BROKEN',photos:['data:image/png;base64,broken',photos[1]]},{...request,id:'REQ-REJECTED',status:'Rejected',rejectionReason:'Please confirm your household address.',photos:[]}],donations:[{id:'DON-PHOTO',requestId:null,donor:'Community Donor',donorId:'PHOTO-DONOR',barangay:'Lahug',type:'Items',amount:'20 food packs',status:'Pending Approval',createdAt:now}]});
    })()`);
    await actor('PHOTO-OFFICIAL');
    await evaluate('goDash("BARANGAY_OFFICIAL","pending"); render()'); await settle();
    const storageBefore = await evaluate(storageExpression);
    for (const width of [1440,768,390,320]) {
      await cdp('Emulation.setDeviceMetricsOverride', { width, height: width > 800 ? 1000 : 850, deviceScaleFactor: 1, mobile: false });
      await evaluate('closeModal()'); await open();
      const layout = await evaluate(`(() => {
        const dialog=document.querySelector('.request-dialog'), rect=dialog.getBoundingClientRect(), close=dialog.querySelector('[aria-label="Close dialog"]'), closeRect=close?.getBoundingClientRect();
        return {width:innerWidth,height:innerHeight,rect:{left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom},documentWidth:document.documentElement.scrollWidth,closeVisible:!!closeRect&&closeRect.top>=0&&closeRect.bottom<=innerHeight,dialogLabel:dialog.getAttribute('aria-labelledby'),photoCount:dialog.querySelectorAll('.request-photo-card[data-photo-index]').length,allPhotoContain:[...dialog.querySelectorAll('.request-photo-preview img')].every(img=>getComputedStyle(img).objectFit==='contain'&&img.complete&&img.naturalWidth>0)};
      })()`);
      assert(layout.rect.left >= 0 && layout.rect.right <= width + 1 && layout.rect.top >= 0 && layout.rect.bottom <= layout.height + 1 && layout.documentWidth <= width && layout.closeVisible && layout.dialogLabel && layout.photoCount === 3 && layout.allPhotoContain, 'Request details fit viewport and photos preserve full image at ' + width + 'px', layout);
      await screenshot('request-details-' + width);
      await click('.request-photo-card[data-photo-index="0"]');
      await check('document.querySelector(".request-details-view").hidden && !document.querySelector(".request-photo-viewer").hidden && document.querySelector(".request-full-photo").src===fixturePhotos[0] && document.querySelector(".request-viewer-count").textContent.includes("Photo 1 of 3") && document.querySelector(".request-photo-prev").disabled && !document.querySelector(".request-photo-next").disabled', 'First attachment opens at original source with correct navigation at ' + width + 'px');
      const viewerLayout = await evaluate(`(() => {
        const dialog=document.querySelector('.request-dialog'), rect=dialog.getBoundingClientRect(), image=document.querySelector('.request-full-photo'), imageRect=image.getBoundingClientRect(), stage=document.querySelector('.request-photo-stage').getBoundingClientRect();
        return {fits:rect.left>=0&&rect.right<=innerWidth+1&&rect.top>=0&&rect.bottom<=innerHeight+1,contained:getComputedStyle(image).objectFit==='contain'&&imageRect.left>=stage.left-1&&imageRect.right<=stage.right+1&&imageRect.top>=stage.top-1&&imageRect.bottom<=stage.bottom+1,loaded:image.complete&&image.naturalWidth===480,scrollWidth:dialog.scrollWidth,clientWidth:dialog.clientWidth};
      })()`);
      assert(viewerLayout.fits && viewerLayout.contained && viewerLayout.loaded && viewerLayout.scrollWidth <= viewerLayout.clientWidth + 1, 'Full-size viewer fits viewport at ' + width + 'px', viewerLayout);
      await screenshot('request-photo-viewer-' + width);
      await click('.request-photo-next');
      await check('document.querySelector(".request-full-photo").src===fixturePhotos[1] && document.querySelector(".request-viewer-count").textContent.includes("Photo 2 of 3")', 'Next button opens landscape attachment at ' + width + 'px');
      await key('ArrowRight');
      await check('document.querySelector(".request-full-photo").src===fixturePhotos[2] && document.querySelector(".request-photo-next").disabled', 'Right arrow opens final attachment and disables next at ' + width + 'px');
      await key('ArrowLeft');
      await check('document.querySelector(".request-full-photo").src===fixturePhotos[1]', 'Left arrow returns to previous attachment at ' + width + 'px');
      await click('.request-photo-zoom');
      await check('document.querySelector(".request-photo-stage").classList.contains("is-zoomed") && document.querySelector(".request-photo-zoom").getAttribute("aria-pressed")==="true"', 'Zoom activates at ' + width + 'px');
      await click('.request-photo-zoom');
      await check('!document.querySelector(".request-photo-stage").classList.contains("is-zoomed") && document.querySelector(".request-photo-zoom").getAttribute("aria-pressed")==="false"', 'Zoom returns to fit at ' + width + 'px');
      await click('.request-viewer-back');
      await check('!document.querySelector(".request-details-view").hidden && document.querySelector(".request-photo-viewer").hidden && document.activeElement.matches(".request-photo-card[data-photo-index=\"0\"]")', 'Back returns to details and original thumbnail focus at ' + width + 'px');
      await click('.request-photo-card[data-photo-index="1"]');
      await key('Escape');
      await check('!!document.querySelector(".request-dialog") && document.querySelector(".request-photo-viewer").hidden && document.activeElement.matches(".request-photo-card[data-photo-index=\"1\"]")', 'Escape returns to request details at ' + width + 'px');
      await key('Escape');
      await check('!document.getElementById("modalRoot") && !document.getElementById("app").inert', 'Second Escape closes dialog at ' + width + 'px');
    }
    assert(storageBefore === await evaluate(storageExpression), 'Viewing and navigating photos preserves all users, requests, and donations');
    await open();
    await evaluate('getFocusableElements(document.querySelector(".request-dialog")).at(-1).focus()');
    await key('Tab');
    await check('document.activeElement===getFocusableElements(document.querySelector(".request-dialog"))[0]', 'Details traps forward Tab');
    await key('Tab',8);
    await check('document.activeElement===getFocusableElements(document.querySelector(".request-dialog")).at(-1)', 'Details traps backward Tab');
    await click('.request-photo-card[data-photo-index="0"]');
    await evaluate('getFocusableElements(document.querySelector(".request-dialog")).at(-1).focus()'); await key('Tab');
    await check('document.activeElement===getFocusableElements(document.querySelector(".request-dialog"))[0]', 'Photo viewer traps forward Tab within visible controls');
    await key('Tab',8);
    await check('document.activeElement===getFocusableElements(document.querySelector(".request-dialog")).at(-1)', 'Photo viewer traps backward Tab within visible controls');
    await evaluate('closeModal()'); await open('REQ-EMPTY');
    await check('!!document.querySelector(".request-photos-empty") && document.querySelectorAll(".request-photo-card").length===0', 'Empty attachments display clear empty state');
    await evaluate('closeModal()'); await open('REQ-BROKEN');
    await check('!!document.querySelector(".request-photo-unavailable") && !document.querySelector(".request-photo-unavailable").hidden', 'Broken thumbnail displays unavailable state');
    await click('.request-photo-card[data-photo-index="0"]');
    await check('!!document.querySelector(".request-photo-error") && !document.querySelector(".request-photo-error").hidden && !document.querySelector(".request-photo-next").disabled', 'Broken full attachment displays recovery message and usable navigation');
    await click('.request-photo-next');
    await check('document.querySelector(".request-full-photo").src===fixturePhotos[1] && document.querySelector(".request-full-photo").naturalWidth===1000', 'Broken photo does not prevent opening next valid attachment');
    await click('.request-viewer-back');
    await check('!document.querySelector(".request-details-view").hidden', 'Broken photo does not prevent returning to request details');
    for (const [user,id,allowed] of [
      ['PHOTO-OTHER-OFFICIAL','REQ-PHOTO-001-1234567890',false],
      ['PHOTO-OTHER-HOUSEHOLD','REQ-PHOTO-001-1234567890',false],
      ['PHOTO-HOUSEHOLD','REQ-PHOTO-001-1234567890',true],
      ['PHOTO-REVOKED','REQ-PHOTO-001-1234567890',false],
      ['PHOTO-DONOR','REQ-REJECTED',false],
      ['PHOTO-DONOR','REQ-PHOTO-001-1234567890',true],
      ['ACC-1001','REQ-PHOTO-001-1234567890',true]
    ]) {
      await actor(user); await open(id);
      assert((await evaluate('!!document.querySelector(".request-dialog")'))===allowed, 'Request access unchanged for ' + user + ' on ' + id);
    }
    await actor('PHOTO-OFFICIAL');
    await evaluate('openGeneralDonationDetails("DON-PHOTO")'); await settle();
    await check('!!document.querySelector("#modalRoot .modal") && !document.querySelector(".request-dialog") && document.getElementById("modalRoot").textContent.includes("20 food packs")', 'Existing donation details modal keeps original content and styling scope');
    await key('Escape');
    await check('!document.getElementById("modalRoot")', 'Existing donation modal Escape still closes');
    assert(!errors.length, 'No browser JavaScript errors', errors.length ? errors : undefined);
  } catch (error) {
    assert(false, 'Fatal browser check', error.stack); console.error(error.stack);
  } finally {
    const evidence = path.join(output, 'request-photo-browser-results.json');
    fs.writeFileSync(evidence, JSON.stringify({ checkedAt: new Date().toISOString(), profile, results, errors }, null, 2));
    try { await cdp('Browser.close', {}, false); } catch (_) { chrome.kill(); }
    clearTimeout(timer);
    console.log(JSON.stringify({ passed: results.filter(r => r.pass).length, failed: results.filter(r => !r.pass).length, evidence }));
    if (results.some(r => !r.pass)) process.exitCode = 1;
  }
})();

