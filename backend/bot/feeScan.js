// bot/feeScan.js — READ-ONLY fee-tier comparison (no wallet, no swaps, no spending)
// ─────────────────────────────────────────────────────────────────────────────
// Answers ONE question: for OUR actual trade size, which Uniswap v3 fee tier gives
// the best real fill? It quotes a round trip (USDC.e→WETH→USDC.e) through QuoterV2
// on every tier, so the number reflects fee + price-impact for our size, not theory.
//
//   Run:  node bot/feeScan.js            (optionally SIZE_USDC=24)
// ─────────────────────────────────────────────────────────────────────────────
require('dotenv').config();
const { ethers } = require('ethers');
const cfg = require('./config');

const provider = new ethers.JsonRpcProvider(cfg.RPC_HTTP);
const WETH = cfg.WETH_ADDRESS;
const SIZE_USDC = Number(process.env.SIZE_USDC || 24);
const TIERS = [100, 500, 3000, 10000]; // 0.01% / 0.05% / 0.30% / 1.00%
// Two USDCs on Polygon: bridged USDC.e (what the wallet holds) and native USDC.
const QUOTES = [
  { sym: 'USDC.e', addr: cfg.USDC_ADDRESS },
  { sym: 'USDC  ', addr: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359' },
];

const FACTORY_ABI = ['function getPool(address,address,uint24) view returns (address)'];
const POOL_ABI = [
  'function liquidity() view returns (uint128)',
  'function token0() view returns (address)',
];
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)', 'function symbol() view returns (string)'];
const QUOTER_ABI = ['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 a,uint32 b,uint256 c)'];

const factory = new ethers.Contract(cfg.UNISWAP_V3_FACTORY, FACTORY_ABI, provider);
const quoter = new ethers.Contract(cfg.UNISWAP_QUOTER, QUOTER_ABI, provider);
const weth = new ethers.Contract(WETH, ERC20_ABI, provider);

async function quote(tokenIn, tokenOut, amountIn, fee) {
  const p = { tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n };
  const r = await quoter.quoteExactInputSingle.staticCall(p);
  return r[0];
}

(async () => {
  console.log(`🔬 Uniswap v3 WETH/USDC fee-tier scan (Polygon) — round trip on ${SIZE_USDC} USDC\n`);
  const amountIn = ethers.parseUnits(String(SIZE_USDC), cfg.USDT_DECIMALS);

  for (const q of QUOTES) {
    console.log(`── WETH / ${q.sym.trim()} (${q.addr.slice(0,8)}…) ──────────────────────────────`);
    const usdc = new ethers.Contract(q.addr, ERC20_ABI, provider);
    for (const fee of TIERS) {
      const addr = await factory.getPool(WETH, q.addr, fee);
      if (!addr || addr === ethers.ZeroAddress) { console.log(`  fee ${String(fee).padStart(5)} (${(fee/10000).toFixed(2)}%) : ❌ no pool`); continue; }
      const pool = new ethers.Contract(addr, POOL_ABI, provider);
      let wBal = 0n, uBal = 0n;
      try { [wBal, uBal] = await Promise.all([weth.balanceOf(addr), usdc.balanceOf(addr)]); } catch {}
      const wTvl = parseFloat(ethers.formatUnits(wBal, cfg.WETH_DECIMALS));
      const uTvl = parseFloat(ethers.formatUnits(uBal, cfg.USDT_DECIMALS));

      let rtLine = 'quote failed (no in-range liquidity)';
      try {
        const wethOut = await quote(q.addr, WETH, amountIn, fee);   // leg 1: USDC -> WETH
        const usdcBack = await quote(WETH, q.addr, wethOut, fee);   // leg 2: WETH -> USDC
        const back = parseFloat(ethers.formatUnits(usdcBack, cfg.USDT_DECIMALS));
        const costPct = ((SIZE_USDC - back) / SIZE_USDC) * 100;     // total round-trip cost for OUR size
        const px = SIZE_USDC / parseFloat(ethers.formatUnits(wethOut, cfg.WETH_DECIMALS));
        rtLine = `px ~${px.toFixed(2)} | round-trip ${back.toFixed(4)} → cost ${costPct.toFixed(3)}%`;
      } catch (_) {}

      console.log(`  fee ${String(fee).padStart(5)} (${(fee/10000).toFixed(2)}%) : ${addr.slice(0,10)}… | TVL ~${wTvl.toFixed(2)} WETH / ${uTvl.toFixed(0)} ${q.sym.trim()} | ${rtLine}`);
    }
  }
  console.log('\nLower round-trip cost % = cheaper for us. Theoretical fee floor = 2× the tier %.');
  process.exit(0);
})().catch((e) => { console.error('scan error:', e.message); process.exit(1); });
