// bot/scanner.js  —  READ-ONLY cross-venue price-gap scanner (no wallet, no swaps, no spending)
// ─────────────────────────────────────────────────────────────────────────────
// Watches the ETH/USDC price on several venues at the same instant and reports the
// GAP between them, and whether any gap is big enough to beat trading costs. This
// tells us — without risking a rupee — whether a real arbitrage EDGE exists.
//
//   Venues: Binance (CEX, reference) · Uniswap v3 (0.05%) · Quickswap v2 (0.30%) · Sushiswap v2 (0.30%)
//   "DEX↔DEX" arb (both legs in one wallet) is the realistically tradeable one.
//
//   Run:  node bot/scanner.js         (Ctrl+C to stop)
//         set SCAN_SAMPLES=10 first to auto-stop after N samples.
// ─────────────────────────────────────────────────────────────────────────────
require('dotenv').config();
const { ethers } = require('ethers');
const axios = require('axios');
const cfg = require('./config');

const provider = new ethers.JsonRpcProvider(cfg.RPC_HTTP);
const WETH = cfg.WETH_ADDRESS;
const USDC = cfg.USDC_ADDRESS;
const INTERVAL = Number(process.env.SCAN_INTERVAL_MS || 4000);
const SAMPLES = Number(process.env.SCAN_SAMPLES || 0); // 0 = run forever
// round-trip arb cost between a v3 (0.05%) and a v2 (0.30%) DEX, ignoring tiny gas:
const ARB_COST_PCT = Number(process.env.SCAN_ARB_COST_PCT || 0.35);

const V3_FACTORY_ABI = ['function getPool(address,address,uint24) view returns (address)'];
const V3_POOL_ABI = ['function slot0() view returns (uint160 sqrtPriceX96,int24 t,uint16 a,uint16 b,uint16 c,uint8 d,bool e)', 'function token0() view returns (address)'];
const V2_FACTORY_ABI = ['function getPair(address,address) view returns (address)'];
const V2_PAIR_ABI = ['function getReserves() view returns (uint112 r0,uint112 r1,uint32 t)', 'function token0() view returns (address)'];

const V2_DEXES = [
  { name: 'Quickswap', factory: '0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32', fee: 0.30 },
  { name: 'Sushiswap', factory: '0xc35DADB65012eC5796536bD9864eD8773aBc74C4', fee: 0.30 },
];

let v3Pool = null, v3WethIsT0 = false;
const v2Pairs = []; // {name, contract, wethIsT0, fee}

async function setup() {
  const f = new ethers.Contract(cfg.UNISWAP_V3_FACTORY, V3_FACTORY_ABI, provider);
  const addr = await f.getPool(WETH, USDC, cfg.POOL_FEE);
  if (addr && addr !== ethers.ZeroAddress) {
    v3Pool = new ethers.Contract(addr, V3_POOL_ABI, provider);
    v3WethIsT0 = (await v3Pool.token0()).toLowerCase() === WETH.toLowerCase();
    console.log(`Uniswap v3  pool ${addr} (fee ${cfg.POOL_FEE})`);
  }
  for (const d of V2_DEXES) {
    try {
      const fac = new ethers.Contract(d.factory, V2_FACTORY_ABI, provider);
      const p = await fac.getPair(WETH, USDC);
      if (!p || p === ethers.ZeroAddress) { console.log(`${d.name}: no WETH/USDC.e pair`); continue; }
      const c = new ethers.Contract(p, V2_PAIR_ABI, provider);
      const wethIsT0 = (await c.token0()).toLowerCase() === WETH.toLowerCase();
      v2Pairs.push({ name: d.name, contract: c, wethIsT0, fee: d.fee });
      console.log(`${d.name} v2 pair ${p}`);
    } catch (e) { console.log(`${d.name}: ${e.message}`); }
  }
}

async function v3Price() {
  if (!v3Pool) return null;
  try {
    const s = await v3Pool.slot0();
    const r = Number(s.sqrtPriceX96) / 2 ** 96;
    const pRaw = r * r, f = 10 ** (cfg.WETH_DECIMALS - cfg.USDT_DECIMALS);
    return v3WethIsT0 ? pRaw * f : f / pRaw;
  } catch { return null; }
}
async function v2Price(p) {
  try {
    const res = await p.contract.getReserves();
    const r0 = Number(res.r0), r1 = Number(res.r1);
    const wethRes = (p.wethIsT0 ? r0 : r1) / 1e18;
    const usdcRes = (p.wethIsT0 ? r1 : r0) / 1e6;
    if (wethRes < 0.01) return null; // too thin to be meaningful
    return usdcRes / wethRes;
  } catch { return null; }
}
async function binancePrice() {
  try {
    const r = await axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${cfg.REST_SYMBOL}`, { timeout: 6000 });
    return parseFloat(r.data.price);
  } catch { return null; }
}

const f2 = (n) => (n == null ? '   —   ' : n.toFixed(2));
let n = 0, bestDexGap = 0, beats = 0;

async function tick() {
  const [bin, uni, ...v2s] = await Promise.all([binancePrice(), v3Price(), ...v2Pairs.map(v2Price)]);
  const dexPrices = [['Uni', uni], ...v2Pairs.map((p, i) => [p.name.slice(0, 4), v2s[i]])].filter(x => x[1] != null);

  let row = `${new Date().toTimeString().slice(0, 8)} | Binance ${f2(bin)} | Uni ${f2(uni)}`;
  v2Pairs.forEach((p, i) => { row += ` | ${p.name.slice(0, 4)} ${f2(v2s[i])}`; });

  // best DEX↔DEX gap (the realistically arb-able one)
  if (dexPrices.length >= 2) {
    const vals = dexPrices.map(x => x[1]);
    const hi = Math.max(...vals), lo = Math.min(...vals);
    const gapPct = ((hi - lo) / lo) * 100;
    if (gapPct > bestDexGap) bestDexGap = gapPct;
    const net = gapPct - ARB_COST_PCT;
    const ok = net > 0;
    if (ok) beats++;
    row += ` || DEXgap ${gapPct.toFixed(3)}% (net ${net >= 0 ? '+' : ''}${net.toFixed(3)}% vs ${ARB_COST_PCT}% cost) ${ok ? '✅ EDGE' : '✗'}`;
  }
  console.log(row);

  n++;
  if (SAMPLES > 0 && n >= SAMPLES) finish();
}

function finish() {
  console.log('\n─ scan summary ───────────────────────────────');
  console.log(`samples            : ${n}`);
  console.log(`best DEX↔DEX gap   : ${bestDexGap.toFixed(3)}%`);
  console.log(`arb cost threshold : ${ARB_COST_PCT}%`);
  console.log(`samples with edge  : ${beats}/${n}  ${beats === 0 ? '→ no profitable gap observed' : ''}`);
  process.exit(0);
}

(async () => {
  console.log('🔍 cross-venue scanner (read-only) — Ctrl+C to stop\n');
  await setup();
  console.log('');
  await tick();
  const timer = setInterval(tick, INTERVAL);
  process.on('SIGINT', () => { clearInterval(timer); finish(); });
})().catch((e) => { console.error(e.message); process.exit(1); });
