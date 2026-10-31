// dashboard/makeUser.js — npm run dash:user
// Asks for a username, role and password (typed hidden) and prints the .env lines
// to add. The password itself is never stored — only its scrypt hash.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const readline = require('readline');
const crypto = require('crypto');
const { hashPassword } = require('./passwords');

function ask(q, hidden = false) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = (s) => { if (s.includes(q)) rl.output.write(s); else rl.output.write('*'); };
    rl.question(q, (a) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(a.trim()); });
  });
}

(async () => {
  const role = (await ask('Role — admin (can pause/sell) or viewer (read-only)? [admin/viewer]: ')).toLowerCase();
  if (!['admin', 'viewer'].includes(role)) { console.log('Please type admin or viewer.'); process.exit(1); }
  const user = await ask('Username: ');
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(user)) { console.log('Username: 3-32 letters/digits/._-'); process.exit(1); }
  const pw = await ask('Password (min 12 chars, hidden): ', true);
  if (pw.length < 12) { console.log('Use at least 12 characters.'); process.exit(1); }
  const pw2 = await ask('Repeat password: ', true);
  if (pw !== pw2) { console.log('Passwords do not match.'); process.exit(1); }
  const R = role.toUpperCase();
  console.log('\nAdd these lines to backend/.env (replace any old ones for this role):\n');
  console.log(`DASH_${R}_USER=${user}`);
  console.log(`DASH_${R}_HASH=${await hashPassword(pw)}`);
  if (!process.env.DASH_SECRET) console.log(`\n# once only (signs login sessions — keep secret):\nDASH_SECRET=${crypto.randomBytes(32).toString('base64url')}`);
  console.log('\nThen: pm2 restart eather-dash');
})();
