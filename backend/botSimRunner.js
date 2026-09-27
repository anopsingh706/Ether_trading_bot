// botSimRunner.js  (simulation entry point)
// ─────────────────────────────────────────────────────────────────────────────
// Launches the trading engine in SIMULATION (paper) mode — no wallet, no private
// key, no on-chain transactions, no real funds. It uses the real-time Uniswap
// price feed and the real QuoterV2 to price each fill (0.05% LP fee + price impact)
// plus a live gas estimate, trading a virtual $1000 (BOT_SIM_CAPITAL) balance.
//
// Sets the sim flags BEFORE config.js is required (config reads env at load time),
// so this works identically on Windows/PowerShell and POSIX shells without cross-env.
//
//   Run:   node botSimRunner.js   (or: npm run sim)
//   Tune:  BOT_SIM_CAPITAL, BOT_SIM_TX_TARGET, BOT_SIM_MAX_TX, BOT_ENTRY_THRESHOLD…
// ─────────────────────────────────────────────────────────────────────────────
process.env.BOT_SIM = 'true';
if (!process.env.BOT_SIM_CAPITAL)   process.env.BOT_SIM_CAPITAL = '1000';
if (!process.env.BOT_SIM_TX_TARGET) process.env.BOT_SIM_TX_TARGET = '1000';

// ── Test profile: pure raw-tick $0.05/$0.05 trailing reversal, ALL filters OFF ──
// Pinned here (not in .env) so the live bot (`npm run bot`) is unaffected. These take
// precedence over .env (dotenv never overrides an already-set var); a real shell env
// var still wins, so you can still override any single knob ad hoc.
const test = {
  BOT_THRESHOLD_MODE:  'absolute', // $ thresholds, not percent
  BOT_ENTRY_THRESHOLD: '0.05',     // BUY when raw price rises $0.05 off the low
  BOT_EXIT_THRESHOLD:  '0.05',     // SELL when raw price falls $0.05 off the high
  BOT_SMOOTHING:       'false',    // EMA OFF → decide on RAW ticks
  BOT_VOLUME_FILTER:   'false',    // no volume confirmation
  BOT_TREND_FILTER:    'false',    // no uptrend-only gate
  BOT_TREND_EXIT:      'false',    // no MA-flip exit
  BOT_ENTRY_CONFIRM_MS:'0',        // no fake-spike confirm window
  BOT_COOLDOWN_MS:     '0',        // no re-entry cooldown
  BOT_MIN_NET_PROFIT:  '0',        // no profit guard — pure reversal
  BOT_STOP_LOSS_PCT:   '0',        // no protective stop — pure reversal
  BOT_EXIT_MODE:       'classic',  // pure trailing reversal (sell on -0.05 off peak); NOT breakeven-hold
  BOT_UW_SWING:        'false',     // no underwater swing-repair
  // ── Fee-free compounding mode (user request 2026-07-08) ──────────────────────
  BOT_SIM_NO_FEES:     'true',      // fill at signal price: NO LP fee, NO impact, NO gas (the "+$950" model)
  BOT_PRICE_SOURCE:    'binance',   // signal from Binance WS → zero RPC, cannot touch the live bot
};
for (const [k, v] of Object.entries(test)) {
  if (!process.env[k]) process.env[k] = v;
}

if (String(process.env.BOT_SIM_NO_FEES).toLowerCase() === 'true') {
  console.warn('\n⚠️  ⚠️  FEES DISABLED (BOT_SIM_NO_FEES=true) — fills are frictionless at the signal price.');
  console.warn('    This is the OLD fee-blind paper model. Results are NOT realistic — real fees');
  console.warn('    (0.05% LP + impact + gas) would erase them. Use for pure-strategy timing only.\n');
}

require('./bot/runner');
