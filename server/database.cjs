'use strict';
const { DatabaseSync } = require('node:sqlite');
const { mkdirSync } = require('node:fs');
const { dirname, resolve } = require('node:path');
const { formatReference, referenceDate } = require('./transaction-references.cjs');

function openDatabase(filename) {
  if (filename !== ':memory:') mkdirSync(dirname(resolve(filename)), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      profile TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
    CREATE TABLE IF NOT EXISTS password_resets (
      email TEXT PRIMARY KEY COLLATE NOCASE,
      challenge_id TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS residency_documents (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      mime_type TEXT NOT NULL,
      content BLOB NOT NULL,
      uploaded_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS rate_limits (
      key TEXT PRIMARY KEY,
      count INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY,
      reference_code TEXT UNIQUE,
      household_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      household TEXT NOT NULL,
      barangay TEXT NOT NULL,
      contact TEXT,
      category TEXT NOT NULL,
      disaster TEXT NOT NULL,
      urgency TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL,
      location TEXT DEFAULT '',
      gps TEXT DEFAULT '',
      gps_accuracy REAL,
      gps_captured_at TEXT,
      photos TEXT NOT NULL DEFAULT '[]',
      rejection_reason TEXT,
      approved_at TEXT,
      approved_by TEXT,
      reviewed_by TEXT,
      pledged_at TEXT,
      pledged_by TEXT,
      fulfilled_at TEXT,
      fulfilled_by_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS requests_household ON requests(household_id);
    CREATE INDEX IF NOT EXISTS requests_barangay ON requests(barangay);
    CREATE INDEX IF NOT EXISTS requests_status ON requests(status);
    CREATE TABLE IF NOT EXISTS request_messages (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
      sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      sender_name TEXT NOT NULL,
      sender_role TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS request_messages_thread ON request_messages(request_id, created_at, id);
    CREATE TABLE IF NOT EXISTS donations (
      id TEXT PRIMARY KEY,
      reference_code TEXT UNIQUE,
      donor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      request_id TEXT REFERENCES requests(id) ON DELETE CASCADE,
      donor TEXT NOT NULL,
      barangay TEXT NOT NULL,
      type TEXT NOT NULL,
      amount TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT,
      reviewed_by TEXT,
      reviewed_by_id TEXT,
      approved_at TEXT,
      rejected_at TEXT,
      rejection_reason TEXT,
      completed_at TEXT,
      cancelled_at TEXT,
      expired_at TEXT
    );
    CREATE INDEX IF NOT EXISTS donations_donor ON donations(donor_id);
    CREATE INDEX IF NOT EXISTS donations_request ON donations(request_id);
    CREATE INDEX IF NOT EXISTS donations_barangay_status ON donations(barangay, status);
    CREATE TABLE IF NOT EXISTS donation_messages (
      id TEXT PRIMARY KEY,
      donation_id TEXT NOT NULL REFERENCES donations(id) ON DELETE CASCADE,
      sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      sender_name TEXT NOT NULL,
      sender_role TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS donation_messages_thread ON donation_messages(donation_id, created_at, id);
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      read_at TEXT
    );
    CREATE INDEX IF NOT EXISTS notifications_user_unread ON notifications(user_id, read_at, created_at);
  `);
  const requestColumns = new Set(db.prepare('PRAGMA table_info(requests)').all().map(column => column.name));
  for (const [name, type] of [['pledged_at', 'TEXT'], ['pledged_by', 'TEXT'], ['fulfilled_by_id', 'TEXT']]) {
    if (!requestColumns.has(name)) db.exec(`ALTER TABLE requests ADD COLUMN ${name} ${type}`);
  }
  for (const table of ['requests', 'donations']) {
    const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name));
    if (!columns.has('reference_code')) db.exec(`ALTER TABLE ${table} ADD COLUMN reference_code TEXT`);
    const prefix = table === 'requests' ? 'REQ' : 'DON';
    const rows = db.prepare(`SELECT id, created_at, reference_code FROM ${table} ORDER BY created_at, id`).all();
    const sequences = new Map();
    const updateReference = db.prepare(`UPDATE ${table} SET reference_code = ? WHERE id = ?`);
    for (const row of rows) {
      const date = referenceDate(row.created_at);
      const current = new RegExp(`^${prefix}-${date}-(\\d+)$`).exec(row.reference_code || '');
      if (current) {
        sequences.set(date, Math.max(sequences.get(date) || 0, Number(current[1])));
      } else if (!row.reference_code) {
        const sequence = (sequences.get(date) || 0) + 1;
        sequences.set(date, sequence);
        updateReference.run(formatReference(prefix, date, sequence), row.id);
      }
    }
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${table}_reference_code ON ${table}(reference_code)`);
  }
  return db;
}

module.exports = { openDatabase };
