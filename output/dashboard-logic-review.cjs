const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const before = fs.readFileSync('output/dashboard-ui-baseline/script.js', 'utf8').replace(/\r\n/g, '\n');
const after = fs.readFileSync('script.js', 'utf8').replace(/\r\n/g, '\n');
const allowed = new Set(['accountVerificationGate', 'householdPage', 'requestForm', 'accountVerificationPage', 'barangayPage', 'donorPage', 'browseList', 'profilePanel', 'donationTable']);
function segments(source) {
  const starts = [...source.matchAll(/^(?:async )?function ([A-Za-z0-9_]+)\(|^window\.([A-Za-z0-9_]+)\s*=/gm)];
  const result = new Map([['preamble', source.slice(0, starts[0].index)]]);
  starts.forEach((match, i) => result.set(match[1] || `window.${match[2]}`, source.slice(match.index, starts[i + 1]?.index ?? source.length)));
  return result;
}
const oldSegments = segments(before), newSegments = segments(after);
assert.deepEqual([...oldSegments.keys()], [...newSegments.keys()], 'Function inventory changed');
const changed = [...oldSegments.keys()].filter(name => oldSegments.get(name) !== newSegments.get(name));
for (const name of changed) assert(allowed.has(name), `Unexpected non-rendering function change: ${name}`);
const traceHelpers = ['requestList', 'requestTable', 'accountCards', 'generalDonationList', 'browseList', 'donationTable', 'accountStatusPanel'];
function runtime(source, fixture) {
  const context = vm.createContext({ console, setTimeout() {}, clearTimeout() {}, document: {}, window: { addEventListener() {}, setInterval() {} }, sessionStorage: { getItem: () => JSON.stringify({ id: fixture.user.id }) }, fixture, traces: [], metrics: [] });
  vm.runInContext(source, context);
  vm.runInContext(`
    readRecords = kind => kind === 'users' ? [fixture.user, ...fixture.users] : fixture[kind];
    dashShell = (role, tab, content) => content;
    metricCard = (value, label) => { metrics.push([value, label]); return ''; };
    dswsMetric = (value, label) => { metrics.push([value, label]); return ''; };
  `, context);
  for (const name of traceHelpers) vm.runInContext(`{
    const original = ${name};
    ${name} = (...args) => { traces.push([${JSON.stringify(name)}, args]); return original(...args); };
  }`, context);
  return context;
}
function contracts(html) {
  return {
    events: [...html.matchAll(/\bon[a-z]+="[^"]*"/g)].map(m => m[0]).sort(),
    controls: [...html.matchAll(/<(?:form|input|select|textarea|option)\b[^>]*>/g)].map(m => m[0].replace(/\s+(?:class|style)="[^"]*"/g, '')).sort(),
    disabledButtons: [...html.matchAll(/<button\b[^>]*\bdisabled\b[^>]*>/g)].length,
  };
}
function json(value) { return JSON.parse(JSON.stringify(value)); }
const statuses = ['Under Verification', 'Approved', 'Pledged', 'Fulfilled', 'Rejected'];
const requests = statuses.map((status, i) => ({ id: `REQ-${i}`, householdId: 'HOUSEHOLD-1', household: 'Fixture Family', barangay: 'Lahug', contact: '09123456789', category: ['Food', 'Medical', 'Shelter', 'Water', 'Utility'][i], disaster: 'Flood', urgency: i === 0 ? 'Urgent' : 'Normal', description: `Request ${i}`, status, createdAt: '2026-01-01T00:00:00.000Z' }));
requests.push({ ...requests[0], id: 'REQ-OTHER', householdId: 'OTHER', barangay: 'Mabolo' });
const donations = [
  { id: 'DON-1', donorId: 'DONOR-1', donor: 'Fixture Donor', barangay: 'Lahug', requestId: 'REQ-0', type: 'Food', amount: '10 bags', status: 'Reserved', createdAt: '2026-01-01T00:00:00.000Z' },
  { id: 'DON-2', donorId: 'DONOR-1', donor: 'Fixture Donor', barangay: 'Lahug', requestId: null, type: 'Food', amount: '20 bags', status: 'Pending Approval', createdAt: '2026-01-01T00:00:00.000Z' },
  { id: 'DON-3', donorId: 'DONOR-1', donor: 'Fixture Donor', barangay: 'Lahug', requestId: 'REQ-3', type: 'Water', amount: '30 bottles', status: 'Completed', createdAt: '2026-01-01T00:00:00.000Z' },
  { id: 'DON-4', donorId: 'OTHER', donor: 'Other donor', barangay: 'Mabolo', requestId: null, type: 'Food', amount: '1 bag', status: 'Pending Approval', createdAt: '2026-01-01T00:00:00.000Z' },
];
const users = ['PENDING', 'APPROVED', 'REJECTED'].map((status, i) => ({ id: `HH-${i}`, name: `Household ${i}`, email: `hh${i}@example.com`, contact: '09123456789', role: 'HOUSEHOLD', status, barangay: 'Lahug', createdAt: '2026-01-01T00:00:00.000Z' }));
let cases = 0;
for (const role of ['HOUSEHOLD', 'BARANGAY_OFFICIAL', 'DONOR']) {
  for (const status of role === 'HOUSEHOLD' ? ['APPROVED', 'PENDING', 'REJECTED'] : ['APPROVED']) {
    for (const populated of [false, true]) {
      const user = { id: role === 'HOUSEHOLD' ? 'HOUSEHOLD-1' : role === 'DONOR' ? 'DONOR-1' : 'OFFICIAL-1', role, status, name: 'Fixture & <Family>', barangay: 'Lahug', email: 'fixture@example.com', contact: '09123456789', createdAt: '2026-01-01T00:00:00.000Z', rejectionReason: status === 'REJECTED' ? 'Fixture reason' : undefined };
      const fixture = { user, users: populated ? users : [], requests: populated ? requests : [], donations: populated ? donations : [] };
      const tabs = role === 'HOUSEHOLD' ? ['overview', 'request', 'history', 'profile'] : role === 'BARANGAY_OFFICIAL' ? ['overview', 'accounts', 'pending', 'all', 'profile'] : ['overview', 'browse', 'donations', 'profile'];
      const fn = role === 'HOUSEHOLD' ? 'householdPage' : role === 'BARANGAY_OFFICIAL' ? 'barangayPage' : 'donorPage';
      for (const tab of tabs) {
        const oldContext = runtime(before, fixture), newContext = runtime(after, fixture);
        const oldHtml = vm.runInContext(`${fn}(${JSON.stringify(tab)})`, oldContext);
        const newHtml = vm.runInContext(`${fn}(${JSON.stringify(tab)})`, newContext);
        const label = `${role}/${status}/${populated ? 'populated' : 'empty'}/${tab}`;
        assert.deepEqual(contracts(newHtml), contracts(oldHtml), `Form or event contract mismatch in ${label}`);
        assert.deepEqual(json(newContext.metrics), json(oldContext.metrics), `Metric mismatch in ${label}`);
        assert.deepEqual(json(newContext.traces), json(oldContext.traces), `Data rendering mismatch in ${label}`);
        cases++;
      }
    }
  }
}
console.log(JSON.stringify({ changedRenderingFunctions: changed, unchangedSegments: oldSegments.size - changed.length, renderedCasesCompared: cases, result: 'PASS: business functions, data selections, metric values, event handlers, form contracts, and disabled actions preserved.' }, null, 2));
