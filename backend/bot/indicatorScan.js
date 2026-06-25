// bot/indicatorScan.js — READ-ONLY. Computes ATR(14) + ADX(14) for ETH so we can see,
// with live numbers, whether volatility/trend-strength filters fit our scalp. No trading.
//   Run:  node bot/indicatorScan.js   (INTERVAL=5m LIMIT=200 PERIOD=14 overridable)
require('dotenv').config();
const axios = require('axios');
const cfg = require('./config');

const SYMBOL = (process.env.IND_SYMBOL || cfg.REST_SYMBOL || 'ETHUSDT');
const INTERVAL = (process.env.IND_INTERVAL || cfg.VOLUME_INTERVAL || '5m');
const LIMIT = Number(process.env.IND_LIMIT || 250);
const P = Number(process.env.IND_PERIOD || 14);

// Wilder smoothing: first value = sum of first P, then prev - prev/P + cur.
function wilder(arr, p) {
  const out = new Array(arr.length).fill(null);
  let sum = 0;
  for (let i = 0; i < p && i < arr.length; i++) sum += arr[i];
  out[p - 1] = sum;
  for (let i = p; i < arr.length; i++) out[i] = out[i - 1] - out[i - 1] / p + arr[i];
  return out;
}

(async () => {
  const url = `https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=${INTERVAL}&limit=${LIMIT}`;
  const { data } = await axios.get(url, { timeout: 10000 });
  const H = data.map((k) => +k[2]), L = data.map((k) => +k[3]), C = data.map((k) => +k[4]);
  const n = data.length;

  const TR = [], pDM = [], mDM = [];
  for (let i = 1; i < n; i++) {
    const up = H[i] - H[i - 1], dn = L[i - 1] - L[i];
    pDM.push(up > dn && up > 0 ? up : 0);
    mDM.push(dn > up && dn > 0 ? dn : 0);
    TR.push(Math.max(H[i] - L[i], Math.abs(H[i] - C[i - 1]), Math.abs(L[i] - C[i - 1])));
  }
  const trS = wilder(TR, P), pS = wilder(pDM, P), mS = wilder(mDM, P);
  const DX = [];
  for (let i = 0; i < TR.length; i++) {
    if (trS[i] == null || trS[i] === 0) { DX.push(null); continue; }
    const pDI = 100 * pS[i] / trS[i], mDI = 100 * mS[i] / trS[i];
    DX.push((pDI + mDI) === 0 ? 0 : 100 * Math.abs(pDI - mDI) / (pDI + mDI));
  }
  const dxClean = DX.map((v, i) => ({ v, i })).filter((x) => x.v != null);
  const dxVals = dxClean.map((x) => x.v);
  const adxArr = wilder(dxVals, P).map((s) => (s == null ? null : s / P)); // ADX = Wilder avg of DX
  const adx = adxArr[adxArr.length - 1];

  const last = TR.length - 1;
  const atr = trS[last] / P;
  const price = C[n - 1];
  const pDIl = 100 * pS[last] / trS[last], mDIl = 100 * mS[last] / trS[last];
  const regime = adx >= 25 ? 'TRENDING' : adx < 20 ? 'RANGING (chop)' : 'transitional';
  const dir = pDIl > mDIl ? 'up' : 'down';

  console.log(`\n📐 ${SYMBOL} ${INTERVAL} — ATR/ADX(${P}) over last ${n} candles\n`);
  console.log(`  price            : ${price.toFixed(2)}`);
  console.log(`  ATR(${P})          : $${atr.toFixed(2)}  (${(atr / price * 100).toFixed(3)}% of price)`);
  console.log(`  ADX(${P})          : ${adx.toFixed(1)}   → ${regime}`);
  console.log(`  +DI / -DI        : ${pDIl.toFixed(1)} / ${mDIl.toFixed(1)}  → direction ${dir}`);
  console.log(`\n  your fixed $${cfg.ENTRY_THRESHOLD} entry = ${(cfg.ENTRY_THRESHOLD / atr).toFixed(2)}× ATR  |  exit $${cfg.EXIT_THRESHOLD} = ${(cfg.EXIT_THRESHOLD / atr).toFixed(2)}× ATR`);
  console.log(`  round-trip cost floor ~0.11% = $${(price * 0.0011).toFixed(2)}  →  ATR is ${(atr / (price * 0.0011)).toFixed(1)}× the cost floor`);
  console.log(`\n  rule-of-thumb: ADX>25 trade trend · ADX<20 stand aside · entry≈1×ATR, stop≈1.5×ATR\n`);
  process.exit(0);
})().catch((e) => { console.error('indicator scan error:', e.message); process.exit(1); });
