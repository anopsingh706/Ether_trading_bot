// dashboard/passwords.js — scrypt password hashing (Node built-in, no dependencies)
// Format: scrypt$N$r$p$<salt b64>$<hash b64>
const crypto = require('crypto');

const N = 16384, R = 8, P = 1, LEN = 32;
const scrypt = (pw, salt, n, r, p) => new Promise((resolve, reject) =>
  crypto.scrypt(pw, salt, LEN, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? reject(e) : resolve(k))));

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

// Always does one full scrypt, even for an unknown user (hash=null), so response
// time doesn't reveal which usernames exist.
const DUMMY = `scrypt$${N}$${R}$${P}$${Buffer.alloc(16).toString('base64')}$${Buffer.alloc(LEN).toString('base64')}`;
async function verifyPassword(pw, stored) {
  const parts = String(stored || DUMMY).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, salt, want] = parts;
  const got = await scrypt(pw, Buffer.from(salt, 'base64'), Number(n), Number(r), Number(p));
  const wantBuf = Buffer.from(want, 'base64');
  return !!stored && got.length === wantBuf.length && crypto.timingSafeEqual(got, wantBuf);
}

module.exports = { hashPassword, verifyPassword };
