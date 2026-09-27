// bot/simExecution.js
// ─────────────────────────────────────────────────────────────────────────────
// SIMULATION (paper) execution — used only when cfg.SIM_MODE is true.
//
// No wallet, no private key, no on-chain transaction. Instead, every BUY/SELL is
// priced with the REAL Uniswap QuoterV2 for the actual trade size, so the fill
// already includes:
//     • the 0.05% LP fee (cfg.POOL_FEE), and
//     • the price impact of that exact trade size on the live pool,
// then a REAL gas estimate is deducted (QuoterV2's gasEstimate × live gas price ×
// live POL/USD). The trade runs against a virtual SIM_CAPITAL balance held on the
// (isolated) sim BotState document.
//
// Accounting is identical to the live path: it reuses execution.finalize(), so the
// net-of-fee, net-of-gas P&L, the order record, and the ledger row are computed by
// the same code that the real bot uses — the simulation is a faithful mirror.
//
//   BUY  = spend all virtual USDC.e → WETH      SELL = sell all virtual WETH → USDC.e
//
// Invariant (always all-in, starts flat at SIM_CAPITAL): when flat (IN_USDT) the
// virtual cash equals SIM_CAPITAL + realized cumulativePnl. We set it from that
// after each SELL so the running balance and the P&L can never drift apart.
// ─────────────────────────────────────────────────────────────────────────────
const { ethers } = require('ethers');
const axios = require('axios');
const cfg = require('./config');
const logger = require('./logger');
const { finalize } = require('./execution');
const state = require('./state');

// QuoterV2 — nonpayable, called read-only via staticCall (returns gasEstimate too).
const QUOTER_ABI = [
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)',
];

// Read-only context (provider + quoter). No signer → cannot send a transaction.
let _ctx = null;
function ctx() {
  if (_ctx) return _ctx;
  const provider = new ethers.JsonRpcProvider(cfg.RPC_HTTP);
  const quoter = new ethers.Contract(cfg.UNISWAP_QUOTER, QUOTER_ABI, provider);
  _ctx = { provider, quoter };
  return _ctx;
}

// Live POL/USD for realistic gas costing (cached 10 min; falls back to config).
let _pol = { price: cfg.POL_PRICE_USD, ts: 0 };
async function polPriceUSD() {
  if (Date.now() - _pol.ts < 600000) return _pol.price;
  for (const sym of ['POLUSDT', 'MATICUSDT']) {
    try {
      const r = await axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${sym}`, { timeout: 6000 });
      const p = parseFloat(r.data && r.data.price);
      if (p > 0) { _pol = { price: p, ts: Date.now() }; return p; }
    } catch (_) { /* try next symbol / fallback */ }
  }
  return _pol.price;
}

async function quote(tokenIn, tokenOut, amountIn) {
  const { quoter } = ctx();
  const params = { tokenIn, tokenOut, amountIn, fee: cfg.POOL_FEE, sqrtPriceLimitX96: 0n };
  const res = await quoter.quoteExactInputSingle.staticCall(params);
  return { amountOut: res[0], gasEstimate: res[3] };
}

async function gasUSD(gasEstimate) {
  try {
    const { provider } = ctx();
    const fd = await provider.getFeeData();
    const gasPrice = fd.gasPrice ?? fd.maxFeePerGas ?? 0n;
    const units = cfg.SIM_GAS_UNITS > 0 ? BigInt(cfg.SIM_GAS_UNITS) : (gasEstimate || 0n);
    const pol = parseFloat(ethers.formatEther(units * gasPrice));
    return parseFloat((pol * (await polPriceUSD())).toFixed(6));
  } catch { return 0; }
}

async function execSim(side, s, price, reason) {
  // lazily seed the virtual balances on first use
  if (s.simUsdt == null) s.simUsdt = cfg.SIM_CAPITAL;
  if (s.simWeth == null) s.simWeth = 0;
  const extreme = s.anchorPrice;

  if (side === 'BUY') {
    // Position size: fixed notional (cuts price impact) or all-in when TRADE_USD = 0.
    const cash = cfg.TRADE_USD > 0 ? Math.min(s.simUsdt, cfg.TRADE_USD) : s.simUsdt;
    if (!(cash > 0)) { logger.warn('[sim] BUY skipped — no virtual USDC.e'); return null; }

    let quantity, gas;
    if (cfg.SIM_NO_FEES) {
      // Frictionless fill at the signal price — no LP fee, no impact, no gas.
      quantity = cash / price;
      gas = 0;
    } else {
      const amountIn = ethers.parseUnits(cash.toFixed(cfg.USDT_DECIMALS), cfg.USDT_DECIMALS);
      const q = await quote(cfg.USDC_ADDRESS, cfg.WETH_ADDRESS, amountIn);
      gas = await gasUSD(q.gasEstimate);
      quantity = parseFloat(ethers.formatUnits(q.amountOut, cfg.WETH_DECIMALS)); // WETH received (fee + impact already applied)
    }
    const amount = cash;                                                            // USDC.e spent = cost basis
    const realized = quantity > 0 ? amount / quantity : price;

    // virtual balances (direct tracking — works for partial AND all-in sizing):
    // spend `cash`, pay gas from cash, receive WETH.
    s.simUsdt = s.simUsdt - cash - gas;
    s.simWeth = (s.simWeth || 0) + quantity;
    s.simGasUsd = (s.simGasUsd || 0) + gas;

    logger.line(`\n🧪 [sim] BUY ${amount.toFixed(2)} USDC.e → ${quantity.toFixed(6)} WETH @ ${realized.toFixed(2)} | ${cfg.SIM_NO_FEES ? 'frictionless — no fee/impact/gas' : `LP fee+impact in quote | gas ~$${gas}`}`);
    return finalize('BUY', s, price, extreme, amount, quantity, realized, { sim: true, gas, tx: null, reason });
  }

  // SELL — close the whole position (we only ever hold one).
  const wethBal = s.simWeth;
  if (!(wethBal > 0)) { logger.warn('[sim] SELL skipped — no virtual WETH'); return null; }

  let proceeds, gas;
  if (cfg.SIM_NO_FEES) {
    // Frictionless fill at the signal price — no LP fee, no impact, no gas.
    proceeds = wethBal * price;
    gas = 0;
  } else {
    const amountIn = ethers.parseUnits(wethBal.toFixed(cfg.WETH_DECIMALS), cfg.WETH_DECIMALS);
    const q = await quote(cfg.WETH_ADDRESS, cfg.USDC_ADDRESS, amountIn);
    gas = await gasUSD(q.gasEstimate);
    proceeds = parseFloat(ethers.formatUnits(q.amountOut, cfg.USDT_DECIMALS)); // USDC.e out (fee + impact already applied)
  }
  const quantity = wethBal;
  const realized = quantity > 0 ? proceeds / quantity : price;

  // virtual balances: receive proceeds, pay gas, clear WETH.
  s.simWeth = 0;
  s.simUsdt = (s.simUsdt || 0) + proceeds - gas;
  s.simGasUsd = (s.simGasUsd || 0) + gas;

  logger.line(`\n🧪 [sim] SELL ${quantity.toFixed(6)} WETH → ${proceeds.toFixed(2)} USDC.e @ ${realized.toFixed(2)} | ${cfg.SIM_NO_FEES ? 'frictionless — no fee/impact/gas' : `LP fee+impact in quote | gas ~$${gas}`}`);
  // finalize computes net P&L (gross − both legs' gas) for the ledger/metrics.
  return finalize('SELL', s, price, extreme, proceeds, quantity, realized, { sim: true, gas, tx: null, reason });
}

module.exports = { execSim };
