// bot/lpBacktest.js
// ─────────────────────────────────────────────────────────────────────────────
// LP PAPER-MODEL (hybrid validation) — replays REAL hourly price + volume of the
// native USDC/WETH 0.05% pool on Polygon (GeckoTerminal OHLCV) and simulates a
// concentrated Uniswap v3 position with full v3 math:
//
//   • fee income   = ourShare × hourVolumeUSD × 0.05%  (only while price in range,
//                    pro-rated by candle overlap; share = L_ours/(L_pool + L_ours)
//                    with L_pool read LIVE on-chain, assumed constant historically)
//   • IL           = implicit in the v3 position value function (piecewise √P math)
//   • rebalances   = withdraw + re-center when price exits the range (swap cost + gas)
//   • regime gates = LP only in "chop" (vol below ~median) and not in a downtrend
//                    (close ≥ 24h MA) — the hybrid design: bot owns spikes, LP owns chop
//
// STANDALONE + READ-ONLY: no DB, no wallet, no imports from the live bot. It cannot
// affect the running v2 bot in any way.
//
// ⚠️ Honest limits (read before believing a number):
//   • L_pool (active liquidity) is TODAY's on-chain reading assumed constant across
//     history and price levels — real active LPs move; our share is overstated when
//     they concentrate. The HAIRCUT parameter (default: capture only 35% of modeled
//     fees) is the honesty knob; the haircut=1 row is a theoretical CEILING.
//   • Volume is attributed at candle granularity; JIT liquidity / MEV not modeled.
//   • Use for RELATIVE policy comparison + order-of-magnitude income, not promises.
//
//   Usage:  node bot/lpBacktest.js [--days 30] [--capital 1000] [--haircut 0.35]
// ─────────────────────────────────────────────────────────────────────────────
require('dotenv').config();
const axios = require('axios');

const POOL = '0xa4d8c89f0c20efbe54cba9e7e7a7e509056228d9'; // native USDC/WETH 0.05%
const FEE = 0.0005;
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : d; };

const DAYS     = arg('days', 30);
const CAPITAL  = arg('capital', 1000);
const HAIRCUT  = arg('haircut', 0.35);   // fraction of modeled fees actually captured
const SWAP_C   = 0.00055;                // cost of swapping (fee+impact) during transitions
const GAS_TX   = 0.02;                   // gas per enter/exit/rebalance (Polygon, NFPM ops)
const L_POOL_FALLBACK = 30964;           // human-normalized active L (read live when possible)

// ── data ──────────────────────────────────────────────────────────────────────
async function fetchHourly(days) {
  const want = days * 24, out = [];
  let before = Math.floor(Date.now() / 1000);
  while (out.length < want) {
    const limit = Math.min(1000, want - out.length);
    const url = `https://api.geckoterminal.com/api/v2/networks/polygon_pos/pools/${POOL}/ohlcv/hour?aggregate=1&limit=${limit}&currency=usd&token=quote&before_timestamp=${before}`;
    const r = await axios.get(url, { timeout: 20000 });
    const rows = r.data.data.attributes.ohlcv_list; // newest-first [ts,o,h,l,c,volUSD]
    if (!rows || !rows.length) break;
    out.push(...rows);
    before = rows[rows.length - 1][0] - 1;
    await new Promise((res) => setTimeout(res, 2200)); // GT rate limit ~30/min
  }
  return out.reverse().map((k) => ({ ts: k[0], o: k[1], h: k[2], l: k[3], c: k[4], v: k[5] }));
}

async function liveActiveL() {
  try {
    const { ethers } = require('ethers');
    const p = new ethers.JsonRpcProvider(process.env.POLYGON_RPC_URL);
    const pool = new ethers.Contract(POOL, ['function liquidity() view returns (uint128)'], p);
    return Number(await pool.liquidity()) / 1e12; // human normalization for WETH(18)/USDC(6)
  } catch { return L_POOL_FALLBACK; }
}

// ── Uniswap v3 position math (X = WETH, Y = USDC, P = USDC per WETH) ──────────
const sq = Math.sqrt;
function mintL(V, P, Pa, Pb) { return V / (2 * sq(P) - sq(Pa) - P / sq(Pb)); }
function posValue(L, P, Pa, Pb) {
  if (P <= Pa) return L * (1 / sq(Pa) - 1 / sq(Pb)) * P;   // 100% WETH
  if (P >= Pb) return L * (sq(Pb) - sq(Pa));               // 100% USDC
  return L * (sq(P) - sq(Pa)) + L * (1 / sq(P) - 1 / sq(Pb)) * P;
}

// ── one policy replay ─────────────────────────────────────────────────────────
// mode: 'always' (LP whenever possible) | 'gated' (chop + not-downtrend only)
function replay(candles, widthPct, mode, Lpool, haircut = HAIRCUT) {
  const w = widthPct / 100;
  // regime signals: 24h MA (trend) + 14h ATR% vs its window median (volatility)
  const atr = new Array(candles.length).fill(null);
  const ma = new Array(candles.length).fill(null);
  const atrRaw = [];
  for (let i = 1; i < candles.length; i++) {
    const pc = candles[i - 1].c;
    atrRaw.push(Math.max(candles[i].h - candles[i].l, Math.abs(candles[i].h - pc), Math.abs(candles[i].l - pc)));
    if (atrRaw.length >= 14) {
      const s = atrRaw.slice(-14).reduce((a, b) => a + b, 0) / 14;
      atr[i] = (s / candles[i].c) * 100;
    }
    if (i >= 24) ma[i] = candles.slice(i - 23, i + 1).reduce((a, k) => a + k.c, 0) / 24;
  }
  const atrVals = atr.filter((x) => x != null).sort((a, b) => a - b);
  const atrMedian = atrVals[Math.floor(atrVals.length / 2)] || 0.5;
  const VOL_MAX = atrMedian * 1.5; // "chop" = below 1.5× median hourly ATR

  let cash = CAPITAL, L = 0, Pa = 0, Pb = 0, inLP = false;
  let fees = 0, costs = 0, transitions = 0, rebalances = 0, hoursIn = 0;
  let peak = CAPITAL, maxDD = 0;

  const enter = (P) => { const c = cash * SWAP_C / 2 + GAS_TX; L = mintL(cash - c, P, P * (1 - w), P * (1 + w)); Pa = P * (1 - w); Pb = P * (1 + w); costs += c; cash = 0; inLP = true; transitions++; };
  const exit = (P) => { cash = posValue(L, P, Pa, Pb) - (posValue(L, P, Pa, Pb) * SWAP_C / 2 + GAS_TX); costs += posValue(L, P, Pa, Pb) * SWAP_C / 2 + GAS_TX; L = 0; inLP = false; transitions++; };

  for (let i = 25; i < candles.length; i++) {
    const k = candles[i];
    const regimeOK = mode === 'always' ? true : (atr[i] != null && ma[i] != null && atr[i] < VOL_MAX && k.c >= ma[i] * 0.995);

    if (!inLP) {
      if (regimeOK) enter(k.c);
    } else {
      // fee accrual for this hour: candle overlap with our range, pro-rated
      const lo = Math.max(k.l, Pa), hi = Math.min(k.h, Pb);
      if (hi > lo) {
        const f = k.h > k.l ? (hi - lo) / (k.h - k.l) : 1;   // fraction of the hour spent in our range
        const share = L / (Lpool + L);                        // our slice of active liquidity
        fees += haircut * share * k.v * FEE * f;              // haircut × share × volume × 0.05% × overlap
      }
      if (!regimeOK) { exit(k.c); }
      else if (k.c <= Pa || k.c >= Pb) { exit(k.c); rebalances++; if (regimeOK) enter(k.c); }
    }
    if (inLP) hoursIn++;
    const eq = (inLP ? posValue(L, k.c, Pa, Pb) : cash) + fees;
    peak = Math.max(peak, eq); maxDD = Math.max(maxDD, peak - eq);
  }
  const last = candles[candles.length - 1].c;
  const final = (inLP ? posValue(L, last, Pa, Pb) : cash) + fees;
  return { final, net: final - CAPITAL, fees, costs, transitions, rebalances, pctIn: Math.round((hoursIn / (candles.length - 25)) * 100), maxDD };
}

// ── main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`⏬ fetching ${DAYS}d hourly OHLCV for native USDC/WETH 0.05% (GeckoTerminal)…`);
  const candles = await fetchHourly(DAYS);
  const Lpool = await liveActiveL();
  const first = candles[0], last = candles[candles.length - 1];
  const ethRet = (last.c / first.c - 1) * 100;
  const totVol = candles.reduce((a, k) => a + k.v, 0);
  console.log(`   ${candles.length}h | ${new Date(first.ts * 1000).toISOString().slice(0, 10)} → ${new Date(last.ts * 1000).toISOString().slice(0, 10)} | ETH ${first.c.toFixed(0)}→${last.c.toFixed(0)} (${ethRet.toFixed(1)}%)`);
  console.log(`   pool volume ${(totVol / 1e6).toFixed(1)}M USD (${(totVol / DAYS / 1000).toFixed(0)}k/day) | active L(live) ${Math.round(Lpool)} | capital $${CAPITAL} | fee-capture haircut ${HAIRCUT}`);
  console.log(`   baselines: hold USDC = +0.00 | hold 50/50 = ${(CAPITAL * ethRet / 200).toFixed(2)}\n`);

  const row = (label, r) =>
    console.log(`${label.padEnd(30)} net ${(r.net >= 0 ? '+' : '') + r.net.toFixed(2).padStart(8)}  (fees ${r.fees.toFixed(2).padStart(7)} − costs ${r.costs.toFixed(2).padStart(6)} ± IL)  inLP ${String(r.pctIn).padStart(3)}%  rebal ${String(r.rebalances).padStart(3)}  maxDD ${r.maxDD.toFixed(2)}`);

  for (const width of [0.5, 1, 2, 5, 10]) {
    row(`always-in  ±${width}%`, replay(candles, width, 'always', Lpool));
    row(`regime-gated ±${width}%`, replay(candles, width, 'gated', Lpool));
  }
  console.log('\n── theoretical CEILING (haircut = 1.0, ±1% gated) — do NOT plan on this ──');
  row('ceiling ±1% gated', replay(candles, 1, 'gated', Lpool, 1));
  process.exit(0);
})().catch((e) => { console.error('💥', e.message || e); process.exit(1); });
