const assert = require('node:assert/strict');
const test = require('node:test');
const { jsPDF } = require('jspdf');
const { applyPlugin } = require('jspdf-autotable');
const { buildSummary, createPdf } = require('../report-pdf.js');

applyPlugin(jsPDF);

const GENERATED_AT = '2026-09-23T00:00:00.000Z';
const CATEGORIES = ['Food', 'Water', 'Medical', 'Shelter', 'Utility'];
const BARANGAYS = ['Apas', 'Lahug', 'Tisa'];
const count = (rows, label) => rows.find(row => row.label === label)?.count ?? 0;
const sum = rows => rows.reduce((total, row) => total + row.count, 0);

function summarize(input = {}) {
  return buildSummary({
    generatedAt: new Date(GENERATED_AT),
    categories: CATEGORIES,
    barangays: BARANGAYS,
    ...input,
  });
}

test('empty summary exports finite zero metrics and no barangay activity', () => {
  const summary = summarize();
  assert.deepEqual(summary.metrics, {
    totalRequests: 0,
    fulfilled: 0,
    fulfilmentRate: 0,
    pending: 0,
    escalated: 0,
    activeContributions: 0,
    totalDonations: 0,
  });
  assert.equal(sum(summary.requestStatuses), 0);
  assert.equal(sum(summary.donationStatuses), 0);
  assert.equal(sum(summary.unmetNeeds), 0);
  assert.deepEqual(summary.barangays, []);
  assert.equal(summary.invalidPendingDates, 0);
  assert.equal(summary.generatedAt, GENERATED_AT);
  assert.ok(summary.dateLabel.length > 0);
});

test('mixed status aggregates preserve dashboard semantics and reconcile unknown records', () => {
  const requests = [
    { status: 'Under Verification', category: 'Food', barangay: 'Tisa', createdAt: '2026-09-19T00:00:00.000Z' },
    { status: 'Approved', category: 'Food', barangay: 'Apas' },
    { status: 'Pledged', category: 'Water', barangay: 'Apas' },
    { status: 'Fulfilled', category: 'Medical', barangay: 'Tisa' },
    { status: 'Rejected', category: 'Shelter', barangay: 'Apas' },
    { status: 'Legacy status', category: 'Legacy category', barangay: 'Legacy barangay' },
    { status: '', category: '', barangay: '' },
  ];
  const donations = [
    { status: 'Reserved', requestId: 'REQ-1' },
    { status: 'Completed', requestId: 'REQ-2' },
    { status: 'Expired', requestId: 'REQ-3' },
    { status: 'Cancelled', requestId: 'REQ-4' },
    { status: 'Pending Approval', requestId: null },
    { status: 'Approved', requestId: null },
    { status: 'Rejected', requestId: null },
    { status: 'Legacy status' },
  ];
  const summary = summarize({ requests, donations });

  assert.deepEqual(summary.metrics, {
    totalRequests: 7,
    fulfilled: 1,
    fulfilmentRate: 14,
    pending: 1,
    escalated: 1,
    activeContributions: 1,
    totalDonations: 8,
  });
  assert.equal(sum(summary.requestStatuses), requests.length);
  assert.equal(sum(summary.donationStatuses), donations.length);
  assert.equal(count(summary.requestStatuses, 'Other / unspecified'), 2);
  assert.equal(count(summary.donationStatuses, 'Other / unspecified'), 1);
  assert.equal(count(summary.donationStatuses, 'Pending Approval'), 1);
  assert.equal(count(summary.donationStatuses, 'Approved'), 1);
  assert.equal(count(summary.unmetNeeds, 'Food'), 2);
  assert.equal(count(summary.unmetNeeds, 'Water'), 1);
  assert.equal(count(summary.unmetNeeds, 'Medical'), 0);
  assert.equal(count(summary.unmetNeeds, 'Shelter'), 0);
  assert.equal(count(summary.unmetNeeds, 'Other / unspecified'), 2);
  assert.equal(sum(summary.unmetNeeds), 5);
  assert.deepEqual(summary.barangays, [
    { name: 'Apas', total: 3, pending: 0, fulfilled: 0, escalated: 0 },
    { name: 'Other / unspecified', total: 2, pending: 0, fulfilled: 0, escalated: 0 },
    { name: 'Tisa', total: 2, pending: 1, fulfilled: 1, escalated: 1 },
  ]);
  assert.equal(summary.barangays.reduce((total, row) => total + row.total, 0), requests.length);
});

test('escalation starts at exactly 72 hours and invalid pending dates are reported', () => {
  const now = Date.parse(GENERATED_AT);
  const atAge = age => new Date(now - age).toISOString();
  const threshold = 72 * 60 * 60 * 1000;
  const requests = [
    { status: 'Under Verification', createdAt: atAge(threshold) },
    { status: 'Under Verification', createdAt: atAge(threshold - 1) },
    { status: 'Under Verification', createdAt: atAge(threshold + 1) },
    { status: 'Under Verification', createdAt: 'invalid date' },
    { status: 'Under Verification' },
    { status: 'Under Verification', createdAt: atAge(-threshold) },
    { status: 'Approved', createdAt: atAge(threshold * 2) },
    { status: 'Fulfilled', createdAt: 'invalid date' },
  ];
  const summary = summarize({ requests });
  assert.equal(summary.metrics.pending, 6);
  assert.equal(summary.metrics.escalated, 2);
  assert.equal(summary.invalidPendingDates, 2);
  assert.equal(summary.barangays[0].pending, 6);
  assert.equal(summary.barangays[0].escalated, 2);
});

test('filename uses the Philippines calendar date across a UTC midnight boundary', () => {
  const summary = summarize({ generatedAt: new Date('2026-09-22T18:30:00.000Z') });
  assert.equal(summary.generatedAt, '2026-09-22T18:30:00.000Z');
  assert.equal(summary.filename, 'ayuda-cebu-dsws-summary-2026-09-23.pdf');
});

test('summary calculation does not mutate source records or the supplied date', () => {
  const requests = Object.freeze([
    Object.freeze({ status: 'Pledged', category: 'Food', barangay: 'Apas', createdAt: GENERATED_AT }),
  ]);
  const donations = Object.freeze([
    Object.freeze({ status: 'Reserved', requestId: 'REQ-1', amount: '25 food packs' }),
  ]);
  const generatedAt = new Date(GENERATED_AT);
  const before = JSON.stringify({ requests, donations, generatedAt });
  summarize({ requests, donations, generatedAt });
  assert.equal(JSON.stringify({ requests, donations, generatedAt }), before);
});

test('real PDF is downloadable, paginates all barangays, and omits sensitive details', () => {
  const barangays = Array.from({ length: 80 }, (_, index) => `Barangay ${String(index + 1).padStart(2, '0')}`);
  const requests = barangays.map((barangay, index) => ({
    id: `REQ-${index}`,
    status: 'Under Verification',
    category: CATEGORIES[index % CATEGORIES.length],
    barangay,
    createdAt: '2026-09-19T00:00:00.000Z',
    household: 'PRIVATE HOUSEHOLD SENTINEL',
    contact: 'PRIVATE CONTACT SENTINEL',
    location: 'PRIVATE ADDRESS SENTINEL',
    gps: 'PRIVATE GPS SENTINEL',
    description: 'PRIVATE DESCRIPTION SENTINEL',
    photos: ['PRIVATE PHOTO SENTINEL'],
  }));
  const donations = [{
    status: 'Reserved',
    donor: 'PRIVATE DONOR SENTINEL',
    amount: 'PRIVATE AMOUNT SENTINEL',
  }];
  const summary = summarize({ requests, donations, barangays });
  const doc = createPdf(summary, jsPDF);
  assert.ok(doc.getNumberOfPages() > 1, 'large barangay summaries span multiple pages');
  const bytes = Buffer.from(doc.output('arraybuffer'));
  assert.equal(bytes.subarray(0, 5).toString('ascii'), '%PDF-');
  assert.match(bytes.toString('latin1'), /%%EOF\s*$/);
  const text = doc.internal.pages.flat().join('\n');
  assert.match(text, /AYUDA CEBU/);
  assert.match(text, /Barangay 01/);
  assert.match(text, /Barangay 80/);
  assert.doesNotMatch(text, /PRIVATE .*? SENTINEL/);
});
