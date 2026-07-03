// bot/dex.js
// ─────────────────────────────────────────────────────────────────────────────
// Real swaps on Uniswap v3 (Polygon) via SwapRouter02, with QuoterV2 quoting and
// REAL min-output slippage protection (amountOutMinimum). Every step is logged so
// the transaction flow is visible on the console (approve → quote → submit →
// confirm → gas), with Polygonscan links.
//
//   BUY  = USDC.e → WETH      SELL = WETH → USDC.e
// ─────────────────────────────────────────────────────────────────────────────
const { ethers } = require('ethers');
const axios = require('axios');
const cfg = require('./config');
const logger = require('./logger');

// Live POL/USD for accurate gas-cost display (cached 10 min; falls back to config).
let _polCache = { price: cfg.POL_PRICE_USD, ts: 0 };
async function polPriceUSD() {
  if (Date.now() - _polCache.ts < 600000) return _polCache.price;
  for (const sym of ['POLUSDT', 'MATICUSDT']) {
    try {
      const r = await axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${sym}`, { timeout: 6000 });
      const p = parseFloat(r.data && r.data.price);
      if (p > 0) { _polCache = { price: p, ts: Date.now() }; return p; }
    } catch (_) { /* try next symbol / fallback */ }
  }
  return _polCache.price;
}

// SwapRouter02 (no per-call deadline in the struct)
const ROUTER_ABI = [
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)',
];
// QuoterV2 — nonpayable, but callable read-only via staticCall
const QUOTER_ABI = [
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)',
];
const ERC20_ABI = [
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
];

const SCAN = 'https://polygonscan.com/tx/';

class Dex {
  constructor() {
    this.provider = new ethers.JsonRpcProvider(cfg.RPC_HTTP);
    const pk = (process.env.PRIVATE_KEY || '').trim();
    this.wallet = new ethers.Wallet(pk.startsWith('0x') ? pk : '0x' + pk, this.provider);
    this.router = new ethers.Contract(cfg.UNISWAP_ROUTER, ROUTER_ABI, this.wallet);
    this.quoter = new ethers.Contract(cfg.UNISWAP_QUOTER, QUOTER_ABI, this.provider);
    this.usdc = new ethers.Contract(cfg.USDC_ADDRESS, ERC20_ABI, this.wallet);
    this.weth = new ethers.Contract(cfg.WETH_ADDRESS, ERC20_ABI, this.wallet);
  }

  get address() { return this.wallet.address; }

  async balances() {
    const [pol, usdc, weth] = await Promise.all([
      this.provider.getBalance(this.wallet.address),
      this.usdc.balanceOf(this.wallet.address),
      this.weth.balanceOf(this.wallet.address),
    ]);
    return { pol, usdc, weth };
  }

  async quoteExactIn(tokenIn, tokenOut, amountIn) {
    const params = { tokenIn, tokenOut, amountIn, fee: cfg.POOL_FEE, sqrtPriceLimitX96: 0n };
    const res = await this.quoter.quoteExactInputSingle.staticCall(params);
    return res[0]; // amountOut (bigint)
  }

  async _ensureAllowance(token, amountIn, sym) {
    const cur = await token.allowance(this.wallet.address, cfg.UNISWAP_ROUTER);
    if (cur >= amountIn) return;
    logger.line(`🔑 [dex] approving ${sym} for Uniswap router (one-time)…`);
    const tx = await token.approve(cfg.UNISWAP_ROUTER, ethers.MaxUint256);
    logger.line(`   approve tx: ${tx.hash}  →  ${SCAN}${tx.hash}`);
    await tx.wait();
    logger.line('   ✅ approval confirmed');
  }

  _gasUSD(receipt, polUsd) {
    try {
      const price = receipt.gasPrice ?? 0n;
      const pol = parseFloat(ethers.formatEther(receipt.gasUsed * price));
      return parseFloat((pol * polUsd).toFixed(6));
    } catch { return 0; }
  }

  // side: 'BUY' (USDC.e→WETH) | 'SELL' (WETH→USDC.e). amountIn = bigint in tokenIn units.
  // slippageTolerance: fraction (0.0015 = 0.15%); caller may widen it in fast markets.
  async swap(side, amountIn, slippageTolerance = cfg.SLIPPAGE_TOLERANCE) {
    const isBuy = side === 'BUY';
    const tokenIn = isBuy ? cfg.USDC_ADDRESS : cfg.WETH_ADDRESS;
    const tokenOut = isBuy ? cfg.WETH_ADDRESS : cfg.USDC_ADDRESS;
    const tokenInC = isBuy ? this.usdc : this.weth;
    const inDec = isBuy ? cfg.USDT_DECIMALS : cfg.WETH_DECIMALS;
    const outDec = isBuy ? cfg.WETH_DECIMALS : cfg.USDT_DECIMALS;
    const inSym = isBuy ? 'USDC.e' : 'WETH';
    const outSym = isBuy ? 'WETH' : 'USDC.e';

    logger.line(`\n🔄 [dex] ${side}: ${ethers.formatUnits(amountIn, inDec)} ${inSym} → ${outSym}  (Uniswap fee ${cfg.POOL_FEE})`);

    // 1) quote + min-output (slippage protection)
    const quoted = await this.quoteExactIn(tokenIn, tokenOut, amountIn);
    const minOut = (quoted * BigInt(Math.floor((1 - slippageTolerance) * 10000))) / 10000n;
    logger.line(`   quote : ~${ethers.formatUnits(quoted, outDec)} ${outSym} | minOut ${ethers.formatUnits(minOut, outDec)} (slip ${(slippageTolerance * 100).toFixed(2)}%)`);

    // 2) approve if needed
    await this._ensureAllowance(tokenInC, amountIn, inSym);

    // 3) execute
    const params = {
      tokenIn, tokenOut, fee: cfg.POOL_FEE, recipient: this.wallet.address,
      amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n,
    };
    logger.line('   submitting swap…');
    const tx = await this.router.exactInputSingle(params);
    logger.line(`   swap tx: ${tx.hash}  →  ${SCAN}${tx.hash}`);
    const receipt = await tx.wait();
    const gas = this._gasUSD(receipt, await polPriceUSD());
    const ok = receipt.status === 1;
    logger.line(`   ${ok ? '✅ confirmed' : '❌ reverted'} in block ${receipt.blockNumber} | gas ~$${gas}`);
    return { success: ok, txHash: tx.hash, gasCostUSD: gas };
  }
}

module.exports = Dex;
