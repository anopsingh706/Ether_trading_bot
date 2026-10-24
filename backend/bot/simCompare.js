// bot/simCompare.js
// ─────────────────────────────────────────────────────────────────────────────
// Read-only side-by-side report of every simulation run (BotState docs "sim-*").
// Touches only sim documents — never the live state or the real order ledger.
//   Usage:  npm run sim:compare
// ─────────────────────────────────────────────────────────────────────────────
process.env.BOT_SIM = 'true';
const axios = require('axios');
const botConn = require('./db');
const BotState = require('./models/BotState');

(async () => {
  await botConn.asPromise();
  // 'sim-singleton' = the old fee-free test profile (npm run sim) — not comparable, so skipped
  const docs = await BotState.find({ key: /^sim-/, $nor: [{ key: 'sim-singleton' }] }).lean();
  if (!docs.length) { console.log('No runs yet — start one with e.g. npm run sim:instant'); process.exit(0); }

  let price = null;
  try {
    const r = await axios.get('https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT', { timeout: 10000 });
    price = Number(r.data.price);
  } catch { /* equity falls back to cash only */ }

  const rows = docs.map((s) => {
    const equity = (s.simUsdt || 0) + (s.simWeth || 0) * (price || 0);
    const rt = s.roundTrips || 0;
    return {
      run: s.key.replace(/^sim-/, ''),
      equity, pnl: s.cumulativePnl || 0, rt,
      winPct: rt ? Math.round(((s.wins || 0) / rt) * 100) : 0,
      gas: s.simGasUsd || 0,
      holding: s.position === 'IN_WETH',
      since: s.createdAt ? new Date(s.createdAt).toISOString().slice(0, 16).replace('T', ' ') : '?',
    };
  }).sort((a, b) => b.equity - a.equity);

  console.log(`\nSimulation runs (ETH ${price ? '$' + price.toFixed(2) : 'price unavailable'})\n`);
  console.log('run           equity     realized   trades  win%   gas     now       started (UTC)');
  for (const r of rows) {
    console.log(
      `${r.run.padEnd(12)}  $${r.equity.toFixed(2).padStart(8)}  ${(r.pnl >= 0 ? '+' : '') + r.pnl.toFixed(2).padStart(8)}  ` +
      `${String(r.rt).padStart(6)}  ${String(r.winPct).padStart(3)}%  $${r.gas.toFixed(2).padStart(5)}  ${r.holding ? 'in ETH ' : 'in cash'}  ${r.since}`
    );
  }
  console.log('\nOnly compare runs started at the same time — different start times saw different markets.');
  process.exit(0);
})().catch((e) => { console.error('💥', e.message || e); process.exit(1); });
