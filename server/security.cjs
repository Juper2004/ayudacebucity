'use strict';
const { randomBytes, createHash, createHmac, scrypt, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');
const deriveKey = promisify(scrypt);
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = await deriveKey(password, salt, 32, SCRYPT);
  return `scrypt$${salt}$${hash.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [algorithm, salt, hash] = String(stored).split('$');
  if (algorithm !== 'scrypt' || !/^[a-f0-9]{32}$/.test(salt) || !/^[a-f0-9]{64}$/.test(hash)) return false;
  const actual = await deriveKey(password, salt, 32, SCRYPT);
  return timingSafeEqual(actual, Buffer.from(hash, 'hex'));
}

function digest(value) { return createHash('sha256').update(value).digest('hex'); }
function codeDigest(secret, email, challengeId, code) {
  return createHmac('sha256', secret).update(JSON.stringify([email, challengeId, code])).digest('hex');
}
function equalDigest(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
function validEmail(email) { return typeof email === 'string' && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }
function validPassword(password) { return typeof password === 'string' && password.trim().length >= 8 && password.length <= 128; }
module.exports = { hashPassword, verifyPassword, digest, codeDigest, equalDigest, validEmail, validPassword };
