'use strict';

const TABLES = new Set(['requests', 'donations']);

function referenceDate(timestamp) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return '19700101';
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}${values.month}${values.day}`;
}

function formatReference(prefix, date, sequence) {
  return `${prefix}-${date}-${String(sequence).padStart(3, '0')}`;
}

function nextReferenceCode(db, table, prefix, date) {
  if (!TABLES.has(table)) throw new Error('Unsupported transaction reference table.');
  const references = db.prepare(`SELECT reference_code FROM ${table} WHERE reference_code LIKE ?`)
    .all(`${prefix}-${date}-%`);
  const maxSequence = references.reduce((max, row) => {
    const match = new RegExp(`^${prefix}-${date}-(\\d+)$`).exec(row.reference_code || '');
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  return formatReference(prefix, date, maxSequence + 1);
}

module.exports = { formatReference, nextReferenceCode, referenceDate };
