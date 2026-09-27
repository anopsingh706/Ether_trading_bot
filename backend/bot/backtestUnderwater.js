// bot/backtestUnderwater.js
// ─────────────────────────────────────────────────────────────────────────────
// STANDALONE comparison tool. Does NOT touch the live bot in any way — no import
// of strategyEngine.js / config.js / execution.js / runner.js, no DB, no wallet,
// no RPC. Safe to run anytime, including while the real bot is trading.
//
// Replays historical Binance klines through THREE ways of handling an underwater
// (losing) position, all sharing the SAME entry logic — ATR-adaptive entry/exit
// sizing + RSI oversold confirmation + trend + volume gates, mirroring the
// current live .env — so the only variable being tested is the exit side:
//
//   'be'      — CURRENT LIVE behaviour: hold underwater forever (no loss exits);
//               only the disaster stop can ever realize a loss.
//   'instant' — sell the instant price dips below the raw entry price, then let
//               the normal entry logic re-buy on the next confirmed bounce.
//   'decay'   — patience window (hold like 'be'), then the acceptable loss grows
//               gradually toward the disaster level the longer it stays stuck —
//               but only fires while the trend is down AND RSI isn't already
//               turning up (so it doesn't sell into an active bounce).
//
// ⚠️ Same honest limits as bot/backtest.js: Binance 1m candles stand in for the
// Uniswap pool price, and 4 synthetic ticks/candle can't capture every wiggle.
// Use this for RELATIVE comparison between the three modes, not exact P&L.
//
//   Usage:
//     node bot/backtestUnderwater.js                → 30 days, compare all 3
//     node bot/backtestUnderwater.js --days 90
//     node bot/backtestUnderwater.js --patience 48 --decay 120 --disaster 5
// ─────────────────────────────────────────────────────────────────────────────
require('dotenv').config();
const axios = require('axios');

const num = (v, d) => (v !== undefined && v !== '' && !isNaN(Number(v)) ? Number(v) : d);
const arg = (name, d) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : d;
};

const DAYS     = arg('days', 30);
const endArg = process.argv.indexOf('--end');
const END_TS = endArg >= 0 && process.argv[endArg + 1] ? new Date(process.argv[endArg + 1] + 'T23:59:59Z').getTime() : Date.now();
const SYMBOL   = (process.env.BOT_VOLUME_SYMBOL || 'ethusdt').toUpperCase();
const INTERVAL = process.env.BOT_VOLUME_INTERVAL || '1m'; // assumed = 1 minute below (candle index diff = minutes)
const CAPITAL  = num(process.env.BT_CAPITAL, 22.6);
const COST_LEG = num(process.env.BT_COST_LEG_PCT, 0.055) / 100; // 0.05% LP fee + ~impact
const GAS_USD  = num(process.env.BT_GAS_USD, 0.005);

// Entry logic mirrors the CURRENT LIVE setup (bot/config.js defaults + .env).
const P = {
  atrEntryMult:   num(process.env.BOT_ATR_ENTRY_MULT, 1.5),
  atrExitMult:    num(process.env.BOT_ATR_EXIT_MULT, 1),
  atrPeriod:      num(process.env.BOT_ATR_PERIOD, 14),
  entryFallback:  num(process.env.BOT_ENTRY_THRESHOLD, 2), // only used while ATR is warming up
  exitFallback:   num(process.env.BOT_EXIT_THRESHOLD, 2),
  rsiOn:          String(process.env.BOT_RSI_FILTER || 'true').toLowerCase() === 'true',
  rsiPeriod:      num(process.env.BOT_RSI_PERIOD, 14),
  rsiMaxEntry:    num(process.env.BOT_RSI_MAX_ENTRY, 40),
  trendOn:        String(process.env.BOT_TREND_FILTER || 'true').toLowerCase() === 'true',
  trendWin:       Math.max(2, Math.round(num(process.env.BOT_TREND_WINDOW_MS, 900000) / 60000)),
  volOn:          String(process.env.BOT_VOLUME_FILTER || 'true').toLowerCase() === 'true',
  volMult:        num(process.env.BOT_VOLUME_MULT, 1.5),
  volWindow:      num(process.env.BOT_VOLUME_WINDOW, 20),
  beBuffer:       num(process.env.BOT_BE_BUFFER_PCT, 0.1) / 100,
  disasterPct:    arg('disaster', 5),
  decayPatienceH: arg('patience', 48),   // hours of full patience before decay starts
  decayWindowH:   arg('decay', 120),     // hours after patience for decay to reach the disaster level
};

// ── historical klines (paginated, same approach as bot/backtest.js) ──────────
async function fetchKlines(days) {
  const perDay = { '1m': 1440, '5m': 288, '15m': 96 }[INTERVAL] || 1440;
  const want = days * perDay;
  const out = [];
  let end = END_TS;
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

// ── one replay over the candle series for a given underwater-handling mode ───
function replay(candles, exitMode) {
  const warm = Math.max(P.volWindow, P.atrPeriod, P.trendWin, P.rsiPeriod) + 2;
  let pos = 'CASH', cash = CAPITAL, qty = 0, entryFill = null, entryCost = null, campGas = 0;
  let anchor = null, entryIdx = 0, maxHoldMin = 0;
  let trades = 0, wins = 0, net = 0, gas = 0, fees = 0;
  let equity = CAPITAL, peakEq = CAPITAL, maxDD = 0;
  let beLevel = null;
  const exits = {};

  const volOK = (i) => {
    if (!P.volOn) return true;
    const recent = candles[i - 1].v;
    let s = 0; for (let j = i - 1 - P.volWindow; j < i - 1; j++) s += candles[j].v;
    const ma = s / P.volWindow;
    return ma > 0 ? recent >= P.volMult * ma : true;
  };
  const atrDollar = (i) => {
    let s = 0;
    for (let j = i - P.atrPeriod; j < i; j++) {
      const pc = candles[j - 1].c;
      s += Math.max(candles[j].h - candles[j].l, Math.abs(candles[j].h - pc), Math.abs(candles[j].l - pc));
    }
    return s / P.atrPeriod;
  };
  const trendMA = (i) => {
    let s = 0; for (let j = i - P.trendWin; j < i; j++) s += candles[j].c;
    return s / P.trendWin;
  };
  const rsiAt = (i) => {
    let gains = 0, losses = 0;
    for (let j = i - P.rsiPeriod; j < i; j++) {
      const diff = candles[j].c - candles[j - 1].c;
      if (diff >= 0) gains += diff; else losses -= diff;
    }
    const avgGain = gains / P.rsiPeriod, avgLoss = losses / P.rsiPeriod;
    if (avgLoss === 0) return 100;
    return 100 - 100 / (1 + avgGain / avgLoss);
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
    beLevel = null; campGas = 0;
  };
  const recomputeBE = () => { beLevel = ((entryCost + campGas + GAS_USD) / (qty * (1 - COST_LEG))) * (1 + P.beBuffer); };

  for (let i = warm; i < candles.length; i++) {
    const k = candles[i];
    const ticks = k.c >= k.o ? [k.o, k.l, k.h, k.c] : [k.o, k.h, k.l, k.c];
    const vOK = volOK(i);
    const ma = P.trendOn ? trendMA(i) : null;
    const entryDelta = P.atrEntryMult > 0 ? atrDollar(i) * P.atrEntryMult : P.entryFallback;
    const exitDelta  = P.atrExitMult  > 0 ? atrDollar(i) * P.atrExitMult  : P.exitFallback;
    const rsiNow  = P.rsiOn ? rsiAt(i)     : null;
    const rsiPrev = P.rsiOn ? rsiAt(i - 1) : null;

    for (const t of ticks) {
      if (pos === 'CASH') {
        if (anchor == null || t < anchor) { anchor = t; continue; }
        const trigger = anchor + entryDelta;
        if (t >= trigger) {
          if (P.trendOn && t < ma) continue;
          if (P.rsiOn && rsiNow > P.rsiMaxEntry) continue;
          if (!vOK) continue;
          const level = trigger;
          const fill = level * (1 + COST_LEG);
          qty = (cash - GAS_USD) / fill;
          fees += (cash - GAS_USD) * COST_LEG / (1 + COST_LEG); gas += GAS_USD;
          entryFill = fill; entryCost = cash; campGas = GAS_USD;
          recomputeBE();
          entryIdx = i; anchor = level;
          cash = 0; pos = 'LONG';
        }
        continue;
      }

      // pos === 'LONG' — anchor tracks the peak since entry (all modes trail the same way above BE)
      if (anchor == null || t > anchor) anchor = t;
      if (P.disasterPct > 0 && ((entryFill - t) / entryFill) * 100 >= P.disasterPct) { sell(t, 'disaster', i); continue; }

      if (exitMode === 'instant') {
        // NEW idea: cut the instant price is below what we paid — no patience at all.
        if (t < entryFill) { sell(t, 'instant-cut', i); continue; }
        if (anchor >= beLevel) {
          const trail = anchor - exitDelta;
          if (trail >= beLevel && t <= trail) sell(trail, 'reversal', i);
          else if (t <= beLevel) sell(beLevel, 'breakeven', i);
        }
        continue;
      }

      if (exitMode === 'decay') {
        if (anchor >= beLevel) {
          const trail = anchor - exitDelta;
          if (trail >= beLevel && t <= trail) sell(trail, 'reversal', i);
          else if (t <= beLevel) sell(beLevel, 'breakeven', i);
          continue;
        }
        const hoursHeld = (i - entryIdx) / 60; // 1m candles → minutes → hours
        if (hoursHeld > P.decayPatienceH) {
          const progress = Math.min(1, (hoursHeld - P.decayPatienceH) / P.decayWindowH);
          const allowedLossPct = progress * P.disasterPct;
          const decayFloor = entryFill * (1 - allowedLossPct / 100);
          const trendDown = P.trendOn ? t < ma : true;          // require confirmed weakness
          const rsiRising = P.rsiOn ? rsiNow > rsiPrev : false; // skip if momentum already turning up
          if (t <= decayFloor && trendDown && !rsiRising) sell(t, 'decay', i);
        }
        continue;
      }

      // exitMode === 'be'  (CURRENT LIVE baseline — never realize a loss except disaster)
      if (anchor >= beLevel) {
        const trail = anchor - exitDelta;
        if (trail >= beLevel && t <= trail) sell(trail, 'reversal', i);
        else if (t <= beLevel) sell(beLevel, 'breakeven', i);
      }
    }

    equity = pos === 'LONG' ? qty * k.c : cash;
    peakEq = Math.max(peakEq, equity); maxDD = Math.max(maxDD, peakEq - equity);
  }

  let stuck = null;
  if (pos !== 'CASH') {
    const last = candles[candles.length - 1].c;
    equity = qty * last * (1 - COST_LEG);
    maxHoldMin = Math.max(maxHoldMin, candles.length - 1 - entryIdx);
    stuck = { unrealized: equity - entryCost, sinceH: ((candles.length - 1 - entryIdx) / 60).toFixed(1) };
  }
  return { trades, wins, net, fees, gas, maxDD, endFlat: pos === 'CASH', maxHoldMin, stuck, exits };
}

// ── main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`⏬ fetching ${DAYS}d of ${SYMBOL} ${INTERVAL} klines from Binance…`);
  const candles = await fetchKlines(DAYS);
  const first = candles[0], last = candles[candles.length - 1];
  console.log(`   ${candles.length} candles | ${new Date(first.ts).toISOString().slice(0, 16)} → ${new Date(last.ts).toISOString().slice(0, 16)}`);
  console.log(`   price ${first.c.toFixed(2)} → ${last.c.toFixed(2)} (${((last.c / first.c - 1) * 100).toFixed(2)}%) | capital $${CAPITAL}`);
  console.log(`   entry (same for all 3): ATR×${P.atrEntryMult}/${P.atrExitMult} sizing | RSI≤${P.rsiMaxEntry} | trend+volume gates`);
  console.log(`   disaster stop ${P.disasterPct}% | decay: ${P.decayPatienceH}h patience → full disaster by +${P.decayWindowH}h underwater\n`);

  const fmtRow = (label, r) => {
    const wr = r.trades ? Math.round((r.wins / r.trades) * 100) : 0;
    const hold = r.maxHoldMin >= 60 ? (r.maxHoldMin / 60).toFixed(1) + 'h' : r.maxHoldMin + 'm';
    const stuckStr = r.stuck ? `  ⚠️STUCK ${r.stuck.sinceH}h unreal ${r.stuck.unrealized.toFixed(2)}` : '';
    return `${label.padEnd(10)} RT ${String(r.trades).padStart(4)}  win ${String(wr).padStart(3)}%  net ${(r.net >= 0 ? '+' : '') + r.net.toFixed(2).padStart(7)}  fees ${r.fees.toFixed(2).padStart(6)}  maxDD ${r.maxDD.toFixed(2).padStart(6)}  maxHold ${hold.padStart(6)}  ${r.endFlat ? 'flat   ' : 'HOLDING'}${stuckStr}  ${JSON.stringify(r.exits)}`;
  };

  console.log('── comparison (identical entries — only underwater handling differs) ──');
  const modes = ['be', 'instant', 'decay'];
  const results = {};
  for (const m of modes) {
    results[m] = replay(candles, m);
    console.log(fmtRow(m, results[m]));
  }

  console.log('\n── ranked by realized net P&L ──');
  modes
    .map((m) => ({ m, net: results[m].net }))
    .sort((a, b) => b.net - a.net)
    .forEach((x, idx) => console.log(`  ${idx + 1}. ${x.m.padEnd(8)} net ${(x.net >= 0 ? '+' : '') + x.net.toFixed(2)} USDC`));

  process.exit(0);
})().catch((e) => { console.error('💥', e.message || e); process.exit(1); });
