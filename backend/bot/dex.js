// bot/dex.js
// ─────────────────────────────────────────────────────────────────────────────
// Real swaps on the chain's Uniswap-v3-style DEX (Uniswap v3 on Polygon, PancakeSwap
// v3 on Base — see BOT_CHAIN) via a router-02 exactInputSingle, with QuoterV2 quoting and
// REAL min-output slippage protection (amountOutMinimum). Every step is logged so
// the transaction flow is visible on the console (approve → quote → submit →
// confirm → gas), with block-explorer links.
//
//   BUY  = USDC → WETH      SELL = WETH → USDC
// ─────────────────────────────────────────────────────────────────────────────
const { ethers } = require('ethers');
const axios = require('axios');
const cfg = require('./config');
const logger = require('./logger');
const rpc = require('./rpc');

// Live native-gas-token/USD (POL on Polygon, ETH on Base) for accurate gas costing
// (cached 10 min; falls back to config).
let _nativeCache = { price: cfg.NATIVE_PRICE_FALLBACK, ts: 0 };
async function nativePriceUSD() {
  if (Date.now() - _nativeCache.ts < 600000) return _nativeCache.price;
  for (const sym of cfg.NATIVE_TICKERS) {
    try {
      const r = await axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${sym}`, { timeout: 6000 });
      const p = parseFloat(r.data && r.data.price);
      if (p > 0) { _nativeCache = { price: p, ts: Date.now() }; return p; }
    } catch (_) { /* try next symbol / fallback */ }
  }
  return _nativeCache.price;
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

const SCAN = cfg.SCAN_TX_URL;
const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');

class Dex {
  constructor() {
    this.provider = rpc.provider({ log: (...a) => logger.line(...a) }); // failover list — trades survive a node outage
    const pk = (process.env.PRIVATE_KEY || '').trim();
    this.wallet = new ethers.Wallet(pk.startsWith('0x') ? pk : '0x' + pk, this.provider);
    this.router = new ethers.Contract(cfg.UNISWAP_ROUTER, ROUTER_ABI, this.wallet);
    this.quoter = new ethers.Contract(cfg.UNISWAP_QUOTER, QUOTER_ABI, this.provider);
    this.usdc = new ethers.Contract(cfg.USDC_ADDRESS, ERC20_ABI, this.wallet);
    this.weth = new ethers.Contract(cfg.WETH_ADDRESS, ERC20_ABI, this.wallet);
  }

  get address() { return this.wallet.address; }

  async balances() {
    const [native, usdc, weth] = await Promise.all([
      this.provider.getBalance(this.wallet.address),
      this.usdc.balanceOf(this.wallet.address),
      this.weth.balanceOf(this.wallet.address),
    ]);
    return { native, usdc, weth }; // native = gas token (POL / ETH)
  }

  async quoteExactIn(tokenIn, tokenOut, amountIn) {
    const params = { tokenIn, tokenOut, amountIn, fee: cfg.POOL_FEE, sqrtPriceLimitX96: 0n };
    const res = await this.quoter.quoteExactInputSingle.staticCall(params);
    return res[0]; // amountOut (bigint)
  }

  async _ensureAllowance(token, amountIn, sym) {
    const cur = await token.allowance(this.wallet.address, cfg.UNISWAP_ROUTER);
    if (cur >= amountIn) return;
    logger.line(`🔑 [dex] approving ${sym} for the ${cfg.DEX_NAME} router (one-time)…`);
    const tx = await token.approve(cfg.UNISWAP_ROUTER, ethers.MaxUint256);
    logger.line(`   approve tx: ${tx.hash}  →  ${SCAN}${tx.hash}`);
    await tx.wait();
    logger.line('   ✅ approval confirmed');
  }

  // Execution gas + (on OP-stack chains like Base) the L1 data fee, which the
  // receipt reports separately as l1Fee — ethers' receipt object doesn't expose it.
  async _gasUSD(receipt, nativeUsd) {
    try {
      let wei = receipt.gasUsed * (receipt.gasPrice ?? 0n);
      if (cfg.L1_FEE_ORACLE) {
        const raw = await this.provider.send('eth_getTransactionReceipt', [receipt.hash]).catch(() => null);
        if (raw && raw.l1Fee) wei += BigInt(raw.l1Fee);
      }
      return parseFloat((parseFloat(ethers.formatEther(wei)) * nativeUsd).toFixed(6));
    } catch { return 0; }
  }

  // Sum the ERC-20 Transfer events in a receipt: tokenIn leaving our wallet, tokenOut
  // arriving in it. Returns bigints, or null when no matching transfer is found.
  _walletFlows(receipt, tokenIn, tokenOut) {
    const me = this.wallet.address.toLowerCase();
    let amountIn = 0n, amountOut = 0n;
    for (const log of receipt.logs || []) {
      if (log.topics[0] !== TRANSFER_TOPIC || log.topics.length < 3) continue;
      const from = ('0x' + log.topics[1].slice(26)).toLowerCase();
      const to = ('0x' + log.topics[2].slice(26)).toLowerCase();
      const token = log.address.toLowerCase();
      if (token === tokenIn.toLowerCase() && from === me) amountIn += BigInt(log.data);
      if (token === tokenOut.toLowerCase() && to === me) amountOut += BigInt(log.data);
    }
    return { amountIn: amountIn > 0n ? amountIn : null, amountOut: amountOut > 0n ? amountOut : null };
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
    const inSym = isBuy ? cfg.USDC_SYMBOL : 'WETH';
    const outSym = isBuy ? 'WETH' : cfg.USDC_SYMBOL;

    logger.line(`\n🔄 [dex] ${side}: ${ethers.formatUnits(amountIn, inDec)} ${inSym} → ${outSym}  (${cfg.DEX_NAME} ${cfg.CHAIN_NAME}, fee ${cfg.POOL_FEE})`);

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
    const gas = await this._gasUSD(receipt, await nativePriceUSD());
    const ok = receipt.status === 1;
    logger.line(`   ${ok ? '✅ confirmed' : '❌ reverted'} in block ${receipt.blockNumber} | gas ~$${gas}`);
    // EXACT amounts from this swap's own Transfer events — not a balance re-read, which a
    // node one block behind answers with the PRE-swap balance (the 2026-11-01 "−$72" bug).
    const flows = ok ? this._walletFlows(receipt, tokenIn, tokenOut) : { amountIn: null, amountOut: null };
    return { success: ok, txHash: tx.hash, gasCostUSD: gas, amountIn: flows.amountIn, amountOut: flows.amountOut };
  }
}

module.exports = Dex;
