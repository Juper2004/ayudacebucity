const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');

function loadDashboard() {
  const context = vm.createContext({
    window: { addEventListener() {}, setInterval() {} },
  });
  // Evaluate the real frontend without starting its page lifecycle or timers.
  vm.runInContext(source, context, { filename: 'script.js' });
  return context;
}

function request(id, overrides = {}) {
  return {
    id,
    householdId: `HOUSEHOLD-${id}`,
    household: 'Household name',
    barangay: 'Apas',
    category: 'Food',
    disaster: 'Typhoon',
    urgency: 'Normal',
    description: 'Food assistance needed',
    status: 'Approved',
    createdAt: '2026-09-20T00:00:00.000Z',
    ...overrides,
  };
}

const ids = rows => Array.from(rows, row => row.id);

test('twenty households requesting the same assistance appear in one community need', () => {
  const dashboard = loadDashboard();
  const records = Array.from({ length: 20 }, (_, index) => request(`REQ-${index + 1}`));
  const groups = dashboard.groupDonorRequests(records);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].barangay, 'Apas');
  assert.equal(groups[0].category, 'Food');
  assert.equal(groups[0].requests.length, 20);
  assert.equal(groups[0].householdCount, 20);
  assert.equal(groups[0].unidentifiedCount, 0);
  assert.equal(groups[0].approvedCount, 20);
  assert.equal(groups[0].pendingCount, 0);
  assert.deepEqual(new Set(ids(groups[0].requests)), new Set(ids(records)));
});

test('household totals use account IDs and do not infer identity from a shared name', () => {
  const dashboard = loadDashboard();
  const records = [
    request('REQ-1', { householdId: 'ACCOUNT-1', household: 'Maria Santos' }),
    request('REQ-2', { householdId: 'ACCOUNT-1', household: 'Maria Santos Updated' }),
    request('REQ-3', { householdId: 'ACCOUNT-2', household: 'Maria Santos' }),
    request('REQ-4', { householdId: '', household: 'Maria Santos' }),
    request('REQ-5', { householdId: null, household: 'Maria Santos' }),
    request('REQ-6', { householdId: undefined, household: 'Maria Santos' }),
  ];
  const [group] = dashboard.groupDonorRequests(records);

  assert.equal(group.requests.length, 6);
  assert.equal(group.householdCount, 2);
  assert.equal(group.unidentifiedCount, 3);
});

test('different barangays and assistance categories remain separate', () => {
  const dashboard = loadDashboard();
  const groups = dashboard.groupDonorRequests([
    request('REQ-1'),
    request('REQ-2', { category: 'Water' }),
    request('REQ-3', { barangay: 'Lahug' }),
  ]);

  assert.deepEqual(Array.from(groups, group => [group.barangay, group.category]), [
    ['Apas', 'Food'],
    ['Apas', 'Water'],
    ['Lahug', 'Food'],
  ]);
  assert.ok(groups.every(group => group.householdCount === 1));
});

test('only approved and under-verification requests contribute to community needs', () => {
  const dashboard = loadDashboard();
  const statuses = ['Approved', 'Under Verification', 'Pledged', 'Fulfilled', 'Rejected', 'Cancelled', ''];
  const groups = dashboard.groupDonorRequests(statuses.map((status, index) => request(`REQ-${index}`, { status })));

  assert.equal(groups.length, 1);
  assert.deepEqual(ids(groups[0].requests), ['REQ-0', 'REQ-1']);
  assert.equal(groups[0].householdCount, 2);
  assert.equal(groups[0].approvedCount, 1);
  assert.equal(groups[0].pendingCount, 1);
});

test('grouping and combined filters normalize case and whitespace with canonical display labels', () => {
  const dashboard = loadDashboard();
  const records = [
    request('REQ-1', { barangay: '  basak   PARDO ', category: ' food  ' }),
    request('REQ-2', { barangay: 'BASAK PARDO', category: 'FOOD' }),
    request('REQ-3', { barangay: 'Basak Pardo', category: 'Water' }),
    request('REQ-4', { barangay: 'Apas', category: 'Food' }),
  ];
  const groups = dashboard.groupDonorRequests(records, { barangay: ' BASAK  pardo ', category: ' FOOD ' });

  assert.equal(groups.length, 1);
  assert.equal(groups[0].barangay, 'Basak Pardo');
  assert.equal(groups[0].category, 'Food');
  assert.deepEqual(ids(groups[0].requests), ['REQ-1', 'REQ-2']);
  assert.equal(dashboard.groupDonorRequests(records, { barangay: 'Lahug' }).length, 0);
  assert.equal(dashboard.groupDonorRequests(records, { category: 'Water' }).length, 1);
});

test('aggregates approval totals, highest urgency, distinct disasters, and the oldest request', () => {
  const dashboard = loadDashboard();
  const [group] = dashboard.groupDonorRequests([
    request('REQ-low', { urgency: 'Low', createdAt: '2026-09-01T00:00:00.000Z' }),
    request('REQ-normal', { urgency: 'Normal', disaster: ' typhoon ', status: 'Under Verification' }),
    request('REQ-medium', { urgency: 'Medium', disaster: 'Flood', createdAt: '2026-09-19T00:00:00.000Z' }),
    request('REQ-high', { urgency: 'High', disaster: 'FLOOD' }),
    request('REQ-urgent', { urgency: 'Urgent', disaster: 'Fire', status: 'Under Verification' }),
  ]);

  assert.equal(group.urgency, 'Urgent');
  assert.equal(group.approvedCount, 3);
  assert.equal(group.pendingCount, 2);
  assert.deepEqual(new Set(Array.from(group.disasters, disaster => disaster.trim().toLowerCase())), new Set(['typhoon', 'flood', 'fire']));
  assert.equal(group.disasters.length, 3);
  assert.equal(new Date(group.oldestAt).getTime(), Date.parse('2026-09-01T00:00:00.000Z'));
  assert.deepEqual(ids(group.requests), ['REQ-urgent', 'REQ-high', 'REQ-medium', 'REQ-normal', 'REQ-low']);
});

test('groups prioritize urgency, then oldest need, with stable alphabetical ties', () => {
  const dashboard = loadDashboard();
  const groups = dashboard.groupDonorRequests([
    request('REQ-normal', { barangay: 'Babag', urgency: 'Normal', createdAt: '2026-08-01T00:00:00.000Z' }),
    request('REQ-high-later', { barangay: 'Apas', urgency: 'High', createdAt: '2026-09-19T00:00:00.000Z' }),
    request('REQ-high-earlier', { barangay: 'Tisa', urgency: 'High', createdAt: '2026-09-18T00:00:00.000Z' }),
    request('REQ-urgent-water', { barangay: 'Lahug', category: 'Water', urgency: 'Urgent' }),
    request('REQ-urgent-food', { barangay: 'Lahug', category: 'Food', urgency: 'Urgent' }),
    request('REQ-urgent-apas', { barangay: 'Apas', category: 'Water', urgency: 'Urgent' }),
  ]);

  assert.deepEqual(Array.from(groups, group => `${group.barangay}/${group.category}`), [
    'Apas/Water', 'Lahug/Food', 'Lahug/Water', 'Tisa/Food', 'Apas/Food', 'Babag/Food',
  ]);
});

test('empty and invalid request dates do not produce epoch dates or disturb valid-date ordering', () => {
  const dashboard = loadDashboard();
  assert.equal(dashboard.groupDonorRequests([]).length, 0);
  const [group] = dashboard.groupDonorRequests([
    request('REQ-invalid', { createdAt: 'not-a-date' }),
    request('REQ-empty', { createdAt: '' }),
    request('REQ-null', { createdAt: null }),
    request('REQ-missing', { createdAt: undefined }),
    request('REQ-valid', { createdAt: '2026-09-12T00:00:00.000Z' }),
  ]);

  assert.equal(new Date(group.oldestAt).getTime(), Date.parse('2026-09-12T00:00:00.000Z'));
  assert.equal(group.requests[0].id, 'REQ-valid');
  const [undated] = dashboard.groupDonorRequests([
    request('REQ-b', { createdAt: null }),
    request('REQ-a', { createdAt: 'invalid' }),
  ]);
  assert.equal(undated.oldestAt, null);
  assert.deepEqual(ids(undated.requests), ['REQ-a', 'REQ-b']);
});

test('consolidation preserves original household records and input ordering', () => {
  const dashboard = loadDashboard();
  const records = [
    request('REQ-z', { barangay: ' apas ', category: 'food', urgency: 'Low' }),
    request('REQ-a', { urgency: 'Urgent' }),
  ];
  const before = structuredClone(records);
  records.forEach(Object.freeze);
  Object.freeze(records);

  const groups = dashboard.groupDonorRequests(records);

  assert.deepEqual(records, before);
  assert.deepEqual(ids(groups[0].requests), ['REQ-a', 'REQ-z']);
  assert.deepEqual(ids(records), ['REQ-z', 'REQ-a']);
});

test('browse renders one card with the twenty-household total and applies both filters', () => {
  const dashboard = loadDashboard();
  const records = [
    ...Array.from({ length: 20 }, (_, index) => request(`REQ-${index}`)),
    request('REQ-other-category', { category: 'Water' }),
    request('REQ-other-barangay', { barangay: 'Lahug' }),
  ];
  const html = dashboard.browseList(records, { barangay: 'Apas', category: 'Food' });

  assert.equal((html.match(/<article\b/g) || []).length, 1);
  assert.match(html, /1 group &bull; 20 requests/);
  assert.match(html, /<strong>20<\/strong> households/);
  assert.match(html, /20 approved/);
  assert.match(html, /View requests/);
  assert.doesNotMatch(html, /Water assistance|Lahug/);
});

test('browse escapes record-provided labels and explains unidentified household counts', () => {
  const dashboard = loadDashboard();
  const html = dashboard.browseList([
    request('REQ-1', {
      barangay: '<img src=x onerror=alert(1)>',
      category: 'Food "special" <script>alert(1)</script>',
      disaster: '<svg onload=alert(1)>',
      urgency: '<em>Urgent</em>',
      householdId: '',
      status: 'Under Verification',
    }),
  ]);

  assert.doesNotMatch(html, /<img|<script|<svg onload|<em>Urgent/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&quot;special&quot;/);
  assert.match(html, /&lt;svg onload=alert\(1\)&gt;/);
  assert.match(html, /0<\/strong> identified households/);
  assert.match(html, /1 request has no household identification/);
  assert.match(html, /1 under verification/);
});
