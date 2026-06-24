// bot/execution.js
// ─────────────────────────────────────────────────────────────────────────────
// Executes a BUY (ENTER market) or SELL (EXIT market).
//
//   BUY  → spend all USDT for WETH; record cost basis (entryUsdt/entryPrice/entryWeth).
//   SELL → sell all WETH for USDT; NET PROFIT = usdtReceived − entryUsdt (the round trip).
//
//   Execution is always LIVE: a real Uniswap v3 swap; realized price from on-chain
//   balance deltas. (Dry-run / paper mode was removed.)
//
// Edge cases handled here:
//   • Enter with no USDT / Exit with no WETH  → logged, no trade, position unchanged
//   • First-ever exit with no cost basis      → profit recorded as null ("—")
//   • Division-by-zero on realized rate       → falls back to trigger price
//   • The trailing extreme (peak/bottom) that triggered the trade is captured BEFORE
//     the anchor is reset, and stored on the order + shown in the ledger.
// realized_rate is always USDT per WETH. GST is applied & recorded on every trade.
// ─────────────────────────────────────────────────────────────────────────────
const { ethers } = require('ethers');
const cfg = require('./config');
const BotOrder = require('./models/BotOrder');
const Counter = require('./models/Counter');
const state = require('./state');
const logger = require('./logger');

let _dex = null;
function getDex() {
  if (_dex) return _dex;
  const Dex = require('./dex');
  _dex = new Dex();
  return _dex;
}

// Original GST formula: 0.005% of notional, then 18% GST on that.
function gstOnUsdt(usdt) { return usdt * (0.005 / 100) * 0.18; }

// ── Shared finalize: update state + metrics, persist order, print ledger row ────
async function finalize(side, s, price, extreme, amount, quantity, realized, meta) {
  let profit = null;
  let profitPct = null;
  let grossProfit = null;

  if (side === 'BUY') {
    // ENTER the market — remember what this position cost us (incl. the entry's gas).
    s.entryUsdt = amount;
    s.entryWeth = quantity;
    s.entryPrice = realized;
    s.entryGas = meta.gas || 0;
    s.entryAt = new Date();
    s.position = 'IN_WETH';
  } else {
    // EXIT the market — realize the round-trip profit NET of gas (both legs).
    if (s.entryUsdt != null) {
      grossProfit = amount - s.entryUsdt;
      const roundTripGas = (s.entryGas || 0) + (meta.gas || 0); // entry leg + this exit leg
      profit = grossProfit - roundTripGas;                       // NET — the honest number
      profitPct = s.entryUsdt > 0 ? (profit / s.entryUsdt) * 100 : null;
      s.cumulativePnl = (s.cumulativePnl || 0) + profit;
      s.roundTrips = (s.roundTrips || 0) + 1;
      if (profit >= 0) s.wins = (s.wins || 0) + 1;
      else s.losses = (s.losses || 0) + 1;
    } else {
      logger.note('SELL with no recorded entry — profit unknown for this trade');
    }
    // clear cost basis
    s.entryUsdt = null; s.entryWeth = null; s.entryPrice = null; s.entryGas = null; s.entryAt = null;
    s.position = 'IN_USDT';
  }

  // reset the trailing anchor to the trade price (new extreme starts here)
  s.anchorPrice = price; s.anchorUpdatedAt = new Date();
  s.lastActionPrice = price; s.lastActionAt = new Date();

  // OD-5: slippage detect-and-alert. We can't enforce a min-output on the current
  // contract, so we measure how far the realized fill drifted from the decision
  // price and warn (optionally halt). In dry-run realized === price → 0 bps.
  const slippageBps = price > 0 ? Math.abs(realized - price) / price * 10000 : 0;
  if (slippageBps > cfg.SLIPPAGE_ALERT_BPS) {
    logger.warn(`SLIPPAGE ALERT: ${side} filled @ ${realized.toFixed(2)} vs decision ${price.toFixed(2)} = ${slippageBps.toFixed(1)} bps (tolerance ${cfg.SLIPPAGE_ALERT_BPS})`);
    if (cfg.SLIPPAGE_HALT) { s.slippageHalt = true; logger.warn('SLIPPAGE_HALT is ON → trading will stop after this trade.'); }
  }

  const code = await Counter.next('bot_order_code');
  await BotOrder.create({
    order_code: code,
    side: side === 'BUY' ? 1 : 2,
    currency1: side === 'BUY' ? 'USDT' : 'WETH',
    currency2: side === 'BUY' ? 'WETH' : 'USDT',
    amount,
    quantity,
    realized_rate: realized,
    rate: realized,
    chainlink_rate: meta.chainlink || 0,
    trigger_price: price,
    anchor_price: extreme,
    profit,
    profit_gross: grossProfit,
    profit_pct: profitPct,
    exit_reason: side === 'SELL' ? (meta.reason || 'profit-take') : null, // why a SELL fired
    gas_fee: meta.gas || 0,
    gst_charge: gstOnUsdt(amount),
    gst_applied: true,
    special: 0,
    route: cfg.PRICE_SOURCE === 'uniswap' ? 'UNISWAP' : 'AMM',
    slippage_bps: slippageBps,
    dry_run: false,
    tx_hash: meta.tx || null,
    status: 1,
  });

  await state.saveAfterTrade(s);

  logger.printTrade({
    code,
    time: new Date(),
    side,
    trigger: price,
    extreme,
    usdt: amount,
    weth: quantity,
    profit,
    profitPct,
    cumPnl: s.cumulativePnl || 0,
  });

  return s;
}

// ── LIVE (real Uniswap v3 swaps via SwapRouter02) ────────────────────────────
async function execLive(side, s, price, reason) {
  const extreme = s.anchorPrice;
  const dex = getDex();
  const before = await dex.balances();

  // ── Reconcile: trust the wallet, not the stored position flag. Prevents acting
  //    on a stale/incorrect position and the resulting retry spam (e.g. position
  //    says IN_WETH but the wallet has no WETH). ─────────────────────────────────
  const WETH_DUST = ethers.parseUnits('0.0003', cfg.WETH_DECIMALS); // ~$0.5
  const USDC_DUST = ethers.parseUnits('1', cfg.USDT_DECIMALS);      // $1
  if (side === 'SELL' && before.weth <= WETH_DUST) {
    state.reconcileToCash(s); await state.saveAfterTrade(s);
    logger.warn('No WETH to sell — wallet is flat. Position reconciled to IN_USDT.');
    return null;
  }
  if (side === 'BUY' && before.usdc <= USDC_DUST) {
    if (before.weth > WETH_DUST) {
      await state.reconcileToWeth(s); await state.saveAfterTrade(s);
      logger.warn('No USDC to buy but wallet holds WETH. Position reconciled to IN_WETH.');
    } else {
      logger.warn('Cannot ENTER — wallet has no USDC.e and no WETH.');
    }
    return null;
  }

  if (side === 'BUY') {
    if (before.pol <= 0n) { logger.warn('Cannot ENTER — no POL in wallet for gas'); return null; }

    const res = await dex.swap('BUY', before.usdc); // spend all USDC.e → WETH
    if (!res.success) { logger.warn('BUY swap failed/reverted'); return null; }

    const after = await dex.balances();
    const wethDelta = after.weth > before.weth ? after.weth - before.weth : 0n;
    const amount = parseFloat(ethers.formatUnits(before.usdc, cfg.USDT_DECIMALS));
    const quantity = parseFloat(ethers.formatUnits(wethDelta, cfg.WETH_DECIMALS));
    const realized = quantity > 0 ? amount / quantity : price;
    return finalize('BUY', s, price, extreme, amount, quantity, realized, { dry: false, gas: res.gasCostUSD, tx: res.txHash, reason });
  } else {
    if (before.pol <= 0n) { logger.warn('Cannot EXIT — no POL in wallet for gas'); return null; }

    const res = await dex.swap('SELL', before.weth); // sell all WETH → USDC.e
    if (!res.success) { logger.warn('SELL swap failed/reverted'); return null; }

    const after = await dex.balances();
    const usdcDelta = after.usdc > before.usdc ? after.usdc - before.usdc : 0n;
    const amount = parseFloat(ethers.formatUnits(usdcDelta, cfg.USDT_DECIMALS));
    const quantity = parseFloat(ethers.formatUnits(before.weth, cfg.WETH_DECIMALS));
    const realized = quantity > 0 ? amount / quantity : price;
    return finalize('SELL', s, price, extreme, amount, quantity, realized, { dry: false, gas: res.gasCostUSD, tx: res.txHash, reason });
  }
}

async function execute(side, s, price, reason) {
  return execLive(side, s, price, reason);
}

module.exports = { execute };
