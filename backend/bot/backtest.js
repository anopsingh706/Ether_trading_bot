// bot/backtest.js
// ─────────────────────────────────────────────────────────────────────────────
// BACKTEST — replay the v1 strategy + anti-whipsaw gates over HISTORICAL Binance
// klines. Read-only: no DB, no wallet, no RPC. Fetches 1m candles via REST and
// replays the exact live logic:
//
//   trailing reversal (raw ticks, absolute Δ) + volume gate + ATR gate +
//   15-min-MA trend gate + hard stop-loss   (smoothing off, as in .env)
//
// Fills are costed per leg (LP fee + impact) + gas per swap, so results are
// net-of-cost like the live ledger. Candles are OHLC, so intra-candle ticks are
// synthesized (green: O→L→H→C, red: O→H→L→C) and fills happen AT the trigger
// level (the live 2s feed fills within a tick or two of the trigger).
//
// ⚠️ Honest limits: Binance candles stand in for the Uniswap pool price (they
// track within ~0.1%), and 4 synthetic ticks/candle can't capture every wiggle.
// Use this for RELATIVE comparison of configs, not exact P&L prediction.
//
//   Usage:
//     node bot/backtest.js                 → replay current .env config, 7 days
//     node bot/backtest.js --days 14      → longer window
//     node bot/backtest.js --sweep        → grid-search ATR floor × thresholds
//     env: BT_CAPITAL (22.6) BT_COST_LEG_PCT (0.055) BT_GAS_USD (0.005)
// ─────────────────────────────────────────────────────────────────────────────
require('dotenv').config();
const axios = require('axios');

const num = (v, d) => (v !== undefined && v !== '' && !isNaN(Number(v)) ? Number(v) : d);
const arg = (name, d) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : d;
};

// ── Parameters (defaults mirror the live .env) ────────────────────────────────
const DAYS        = arg('days', 7);
const SYMBOL      = (process.env.BOT_VOLUME_SYMBOL || 'ethusdt').toUpperCase();
const INTERVAL    = process.env.BOT_VOLUME_INTERVAL || '1m';
const CAPITAL     = num(process.env.BT_CAPITAL, 22.6);          // live wallet size
const COST_LEG    = num(process.env.BT_COST_LEG_PCT, 0.055) / 100; // fee 0.05% + ~0.005% impact at this size
const GAS_USD     = num(process.env.BT_GAS_USD, 0.005);        // per swap

const LIVE = {
  entry:      num(process.env.BOT_ENTRY_THRESHOLD, 1),
  exit:       num(process.env.BOT_EXIT_THRESHOLD, 1),
  volMult:    num(process.env.BOT_VOLUME_MULT, 1.5),
  volWindow:  num(process.env.BOT_VOLUME_WINDOW, 20),
  volOn:      String(process.env.BOT_VOLUME_FILTER || 'true').toLowerCase() === 'true',
  atrOn:      String(process.env.BOT_ATR_FILTER || 'true').toLowerCase() === 'true',
  atrPeriod:  num(process.env.BOT_ATR_PERIOD, 14),
  atrMinPct:  num(process.env.BOT_ATR_MIN_PCT, 0.12),
  trendOn:    String(process.env.BOT_TREND_FILTER || 'true').toLowerCase() === 'true',
  trendWin:   Math.max(2, Math.round(num(process.env.BOT_TREND_WINDOW_MS, 900000) / 60000)), // 15-min MA in 1m candles
  stopPct:    num(process.env.BOT_STOP_LOSS_PCT, 0.5),
  // exit mode: 'classic' (trail + stop-loss) | 'be' (break-even floor: never realize a
  // loss; hold underwater until price recovers to breakeven, then exit at BE-or-better;
  // only a deep disaster stop may realize a loss)
  exitMode:    process.argv.includes('--exit') ? process.argv[process.argv.indexOf('--exit') + 1] : 'classic',
  disasterPct: arg('disaster', 0),          // %; 0 = no disaster stop (be mode)
  beBuffer:    num(process.env.BT_BE_BUFFER, 0.0005), // extra margin above true breakeven
};

// ── Historical klines (paginated) ─────────────────────────────────────────────
async function fetchKlines(days) {
  const perDay = { '1m': 1440, '5m': 288, '15m': 96 }[INTERVAL] || 1440;
  const want = days * perDay;
  const out = [];
  let end = Date.now();
  while (out.length < want) {
    const limit = Math.min(1000, want - out.length);
    const url = `https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=${INTERVAL}&limit=${limit}&endTime=${end}`;
    const r = await axios.get(url, { timeout: 15000 });
    const rows = r.data;
    if (!rows.length) break;
    out.unshift(...rows.map((k) => ({ ts: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] })));
    end = rows[0][0] - 1;
  }
  return out.slice(0, -1); // drop the in-progress candle
}

// ── One replay over the candle series ─────────────────────────────────────────
function replay(candles, p) {
  const warm = Math.max(p.volWindow, p.atrPeriod, p.trendWin || 0) + 1;
  let pos = 'CASH', cash = CAPITAL, qty = 0, entryFill = null, entryCost = null;
  let anchor = null;
  let trades = 0, wins = 0, net = 0, gas = 0, fees = 0;
  let equity = CAPITAL, peakEq = CAPITAL, maxDD = 0;
  let beLevel = null, beArmed = false;   // break-even floor state ('be' exit mode)
  let entryIdx = 0, maxHoldMin = 0;      // longest time spent in one position (candles≈min)
  const exits = {};

  // rolling gate data as of the PREVIOUS closed candle (no lookahead)
  const volOK = (i) => {
    if (!p.volOn) return true;
    const recent = candles[i - 1].v;
    let s = 0; for (let j = i - 1 - p.volWindow; j < i - 1; j++) s += candles[j].v;
    const ma = s / p.volWindow;
    return ma > 0 ? recent >= p.volMult * ma : true;
  };
  const atrPct = (i) => {
    let s = 0;
    for (let j = i - p.atrPeriod; j < i; j++) {
      const pc = candles[j - 1].c;
      s += Math.max(candles[j].h - candles[j].l, Math.abs(candles[j].h - pc), Math.abs(candles[j].l - pc));
    }
    return ((s / p.atrPeriod) / candles[i - 1].c) * 100;
  };
  // adaptive downtrend guard (Option B): 15-min MA of closes as of the prev candle
  const trendMA = (i) => {
    let s = 0; for (let j = i - p.trendWin; j < i; j++) s += candles[j].c;
    return s / p.trendWin;
  };

  const sell = (level, reason, i) => {
    const fill = level * (1 - COST_LEG);
    const proceeds = qty * fill - GAS_USD;
    const pnl = proceeds - entryCost;
    fees += qty * level * COST_LEG; gas += GAS_USD;
    net += pnl; trades++; if (pnl >= 0) wins++;
    exits[reason] = (exits[reason] || 0) + 1;
    maxHoldMin = Math.max(maxHoldMin, i - entryIdx);
    cash = proceeds > 0 ? proceeds : 0; qty = 0; pos = 'CASH'; anchor = level;
    beLevel = null; beArmed = false;
  };

  for (let i = warm; i < candles.length; i++) {
    const k = candles[i];
    const ticks = k.c >= k.o ? [k.o, k.l, k.h, k.c] : [k.o, k.h, k.l, k.c];
    const vOK = volOK(i), aPct = p.atrOn ? atrPct(i) : null;
    const ma = p.trendOn ? trendMA(i) : null;

    for (const t of ticks) {
      if (pos === 'CASH') {
        if (anchor == null || t < anchor) { anchor = t; continue; }
        const trigger = anchor + p.entry;
        if (t >= trigger) {
          if (p.trendOn && t < ma) continue;                           // trend gate: no buys below the 15-min MA
          if (p.atrOn && aPct < p.atrMinPct) continue;                 // ATR gate
          if (!vOK) continue;                                          // volume gate
          const level = trigger;                                       // fill at the crossing
          const fill = level * (1 + COST_LEG);
          qty = (cash - GAS_USD) / fill;
          fees += (cash - GAS_USD) * COST_LEG / (1 + COST_LEG); gas += GAS_USD;
          entryFill = fill; entryCost = cash;
          // break-even sell LEVEL: qty × L × (1−fee) − gas ≥ entryCost  (+ small buffer)
          beLevel = ((entryCost + GAS_USD) / (qty * (1 - COST_LEG))) * (1 + p.beBuffer);
          beArmed = false; entryIdx = i;
          cash = 0; pos = 'LONG'; anchor = level;
        }
      } else if (p.exitMode === 'be') {
        // ── break-even floor exit: never realize a loss (except the disaster stop) ──
        if (anchor == null || t > anchor) anchor = t;
        if (p.disasterPct > 0 && ((entryFill - t) / entryFill) * 100 >= p.disasterPct) { sell(t, 'disaster', i); continue; }
        if (t >= beLevel) beArmed = true;               // recovered to breakeven → arm the floor
        if (!beArmed) continue;                          // underwater → HOLD, no selling
        const trail = anchor - p.exit;
        if (trail >= beLevel && t <= trail) sell(trail, 'reversal', i);       // ran higher → trail
        else if (t <= beLevel) sell(beLevel, 'breakeven', i);                 // fell back → out at BE
      } else {
        // ── classic exit: trailing Δ + hard stop-loss ──
        if (anchor == null || t > anchor) { anchor = t; continue; }
        if (p.stopPct > 0 && ((entryFill - t) / entryFill) * 100 >= p.stopPct) { sell(t, 'stop-loss', i); continue; }
        const trigger = anchor - p.exit;
        if (t <= trigger) sell(trigger, 'reversal', i);
      }
    }
    // honest equity mark every candle (in 'be' mode the pain is unrealized — count it)
    equity = pos === 'CASH' ? cash : qty * k.c;
    peakEq = Math.max(peakEq, equity); maxDD = Math.max(maxDD, peakEq - equity);
  }
  // mark-to-market if still holding at the end
  let stuck = null;
  if (pos === 'LONG') {
    const last = candles[candles.length - 1].c;
    equity = qty * last * (1 - COST_LEG);
    maxHoldMin = Math.max(maxHoldMin, candles.length - 1 - entryIdx);
    stuck = { unrealized: equity - entryCost, sinceMin: candles.length - 1 - entryIdx };
  }
  return { trades, wins, net, fees, gas, maxDD, equity, exits, endFlat: pos === 'CASH', maxHoldMin, stuck };
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`⏬ fetching ${DAYS}d of ${SYMBOL} ${INTERVAL} klines from Binance…`);
  const candles = await fetchKlines(DAYS);
  const first = candles[0], last = candles[candles.length - 1];
  const bh = CAPITAL * (last.c / first.c - 1) - 2 * (CAPITAL * COST_LEG + GAS_USD);
  console.log(`   ${candles.length} candles | ${new Date(first.ts).toISOString().slice(0, 16)} → ${new Date(last.ts).toISOString().slice(0, 16)}`);
  console.log(`   price ${first.c.toFixed(2)} → ${last.c.toFixed(2)} (${((last.c / first.c - 1) * 100).toFixed(2)}%) | capital $${CAPITAL} | cost/leg ${(COST_LEG * 100).toFixed(3)}% | gas $${GAS_USD}/swap`);
  console.log(`   buy&hold benchmark (1 round trip): ${bh >= 0 ? '+' : ''}${bh.toFixed(2)} USDC\n`);

  const fmtRow = (label, p, r) => {
    const wr = r.trades ? Math.round((r.wins / r.trades) * 100) : 0;
    const hold = r.maxHoldMin >= 60 ? (r.maxHoldMin / 60).toFixed(1) + 'h' : r.maxHoldMin + 'm';
    const stuckStr = r.stuck ? `  ⚠️STUCK ${(r.stuck.sinceMin / 60).toFixed(1)}h unreal ${r.stuck.unrealized.toFixed(2)}` : '';
    return `${label.padEnd(34)} RT ${String(r.trades).padStart(4)}  win ${String(wr).padStart(3)}%  net ${(r.net >= 0 ? '+' : '') + r.net.toFixed(2).padStart(7)}  fees ${r.fees.toFixed(2).padStart(6)}  maxDD ${r.maxDD.toFixed(2).padStart(5)}  maxHold ${hold.padStart(6)}  ${r.endFlat ? 'flat' : 'HOLDING'}${stuckStr}  ${JSON.stringify(r.exits)}`;
  };

  // 1) the CURRENT live config (exit mode from --exit, disaster stop from --disaster)
  console.log(`── current live config (exit: ${LIVE.exitMode}${LIVE.exitMode === 'be' ? ', disaster ' + (LIVE.disasterPct || 'off') : ''}) ──`);
  console.log(fmtRow(`entry/exit $${LIVE.entry}/$${LIVE.exit}`, LIVE, replay(candles, LIVE)));

  // 2) sweep mode: what would have worked?
  if (process.argv.includes('--sweep')) {
    console.log(`\n── sweep: ATR floor × thresholds × volume (trend ${LIVE.trendOn ? 'ON' : 'off'}, stop 0.5%) ──`);
    const rows = [];
    for (const atrMinPct of [0, 0.03, 0.05, 0.08, 0.12]) {
      for (const [entry, exit] of [[1, 1], [2.5, 1.5], [5, 3], [8, 5], [12, 8]]) {
        for (const volOn of [true, false]) {
          const p = { ...LIVE, entry, exit, atrOn: atrMinPct > 0, atrMinPct, volOn };
          const r = replay(candles, p);
          rows.push({ label: `Δ ${entry}/${exit}  ATR≥${atrMinPct}%  vol ${volOn ? 'on ' : 'off'}`, r });
        }
      }
    }
    rows.sort((a, b) => b.r.net - a.r.net);
    console.log('top 10 by net:');
    for (const x of rows.slice(0, 10)) console.log('  ' + fmtRow(x.label, null, x.r));
    console.log('bottom 3:');
    for (const x of rows.slice(-3)) console.log('  ' + fmtRow(x.label, null, x.r));
  }
  process.exit(0);
})().catch((e) => { console.error('💥', e.message || e); process.exit(1); });
