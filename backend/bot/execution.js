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
const circuitBreaker = require('./circuitBreaker');
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

// Wallet dust thresholds (below these a side is considered empty → reconcile)
const WETH_DUST = ethers.parseUnits('0.0003', cfg.WETH_DECIMALS); // ~$0.5
const USDC_DUST = ethers.parseUnits('1', cfg.USDT_DECIMALS);      // $1

// Adaptive slippage tolerance: base in quiet markets; widened by live 1m ATR in fast
// ones (so protective minOut reverts don't repeat every tick and burn gas), hard-capped.
function slippageTol(atrPct) {
  let tol = cfg.SLIPPAGE_TOLERANCE;
  if (atrPct != null && cfg.SLIPPAGE_ATR_MULT > 0) {
    tol = Math.max(tol, (atrPct / 100) * cfg.SLIPPAGE_ATR_MULT);
  }
  return Math.min(tol, cfg.SLIPPAGE_MAX);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Escalating slippage ladder for EXIT retries: start at the normal adaptive tolerance,
// then widen linearly up to EXIT_SLIPPAGE_MAX across EXIT_RETRY_MAX attempts. Completing
// an exit near the peak beats dying to a tight minOut and chasing the market down.
function exitTolSteps(baseTol) {
  const max = cfg.EXIT_SLIPPAGE_MAX;
  const n = Math.max(1, cfg.EXIT_RETRY_MAX);
  if (n <= 1 || max <= baseTol) return [baseTol];
  const steps = [];
  for (let i = 0; i < n; i++) steps.push(baseTol + ((max - baseTol) * i) / (n - 1));
  return steps;
}

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
    s.swingCash = null; s.swingSellPrice = null; s.swingCount = 0; s.lastSwingAt = null; // fresh campaign
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
      circuitBreaker.onTradeClosed(s, profit); // may stop new buys (persisted below with the trade)
    } else {
      logger.note('SELL with no recorded entry — profit unknown for this trade');
    }
    // clear cost basis + campaign swing state
    s.entryUsdt = null; s.entryWeth = null; s.entryPrice = null; s.entryGas = null; s.entryAt = null;
    s.swingCash = null; s.swingSellPrice = null; s.swingCount = 0; s.lastSwingAt = null;
    s.position = 'IN_USDT';
  }

  // reset the trailing anchor to the trade price (new extreme starts here)
  s.anchorPrice = price; s.anchorUpdatedAt = new Date();
  s.lastActionPrice = price; s.lastActionAt = new Date();

  // OD-5: slippage detect-and-alert. We can't enforce a min-output on the current
  // contract, so we measure how far the realized fill drifted from the decision
  // price and warn (optionally halt). In dry-run realized === price → 0 bps.
  const slippageBps = price > 0 ? Math.abs(realized - price) / price * 10000 : 0;
  if (meta.estimated) {
    logger.warn(`${side} amounts are an ESTIMATE (could not be measured) — slippage check skipped; run npm run repair:trades to correct the record`);
  } else if (slippageBps > cfg.SLIPPAGE_ALERT_BPS) {
    logger.warn(`SLIPPAGE ALERT: ${side} filled @ ${realized.toFixed(2)} vs decision ${price.toFixed(2)} = ${slippageBps.toFixed(1)} bps (tolerance ${cfg.SLIPPAGE_ALERT_BPS})`);
    // never halt the simulation on slippage — fee/impact-driven drift is expected there
    if (cfg.SLIPPAGE_HALT && !meta.sim) { s.slippageHalt = true; logger.warn('SLIPPAGE_HALT is ON → trading will stop after this trade.'); }
  }

  // count this swap (BUY + SELL each count as one transaction) — drives the sim target.
  s.txCount = (s.txCount || 0) + 1;

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
    route: meta.sim ? 'UNISWAP-SIM' : (cfg.PRICE_SOURCE === 'uniswap' ? 'UNISWAP' : 'AMM'),
    slippage_bps: slippageBps,
    dry_run: !!meta.sim,
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

// What a confirmed swap actually moved. Primary: the exact amounts from the receipt's
// Transfer events (dex.swap). Fallback: a balance diff, re-read until the node has caught
// up — a node one block behind returns the PRE-swap balance, which once booked a real
// 72.23 USDC sell as "received 0" (−$72 fake loss + slippage halt). If it still can't be
// measured, return null so the caller books an ESTIMATE instead of an impossible trade.
async function settledAmounts(dex, before, res, inKey, outKey) {
  let inAmt = res.amountIn || null, outAmt = res.amountOut || null;
  for (let i = 0; !outAmt && i < 6; i++) {
    if (i) await sleep(2000);
    const after = await dex.balances().catch(() => null);
    if (after && after[outKey] > before[outKey]) {
      outAmt = after[outKey] - before[outKey];
      if (!inAmt && after[inKey] < before[inKey]) inAmt = before[inKey] - after[inKey];
    }
  }
  return { inAmt: inAmt || before[inKey], outAmt };
}
const feeFactor = () => 1 - cfg.POOL_FEE / 1e6;

// ── LIVE (real swaps on the chain's v3 DEX via router-02) ────────────────────────────
async function execLive(side, s, price, reason, atrPct) {
  const extreme = s.anchorPrice;
  const dex = getDex();
  const before = await dex.balances();
  const tol = slippageTol(atrPct);

  // ── Reconcile: trust the wallet, not the stored position flag. Prevents acting
  //    on a stale/incorrect position and the resulting retry spam (e.g. position
  //    says IN_WETH but the wallet has no WETH). ─────────────────────────────────
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
      logger.warn(`Cannot ENTER — wallet has no ${cfg.USDC_SYMBOL} and no WETH.`);
    }
    return null;
  }

  if (side === 'BUY') {
    if (before.native <= 0n) { logger.warn(`Cannot ENTER — no ${cfg.NATIVE_SYMBOL} in wallet for gas`); return null; }

    const res = await dex.swap('BUY', before.usdc, tol); // spend all USDC.e → WETH
    if (!res.success) { logger.warn('BUY swap failed/reverted'); return null; }

    const { inAmt, outAmt } = await settledAmounts(dex, before, res, 'usdc', 'weth');
    const amount = parseFloat(ethers.formatUnits(inAmt, cfg.USDT_DECIMALS));
    let quantity, estimated = false;
    if (outAmt) quantity = parseFloat(ethers.formatUnits(outAmt, cfg.WETH_DECIMALS));
    else { quantity = (amount / price) * feeFactor(); estimated = true; logger.warn(`BUY confirmed but WETH received could not be measured — booked an ESTIMATE (${quantity.toFixed(6)}). Check tx ${res.txHash}`); }
    const realized = amount / quantity;
    return finalize('BUY', s, price, extreme, amount, quantity, realized, { dry: false, gas: res.gasCostUSD, tx: res.txHash, reason, estimated });
  } else {
    if (before.native <= 0n) { logger.warn(`Cannot EXIT — no ${cfg.NATIVE_SYMBOL} in wallet for gas`); return null; }

    // EXIT-COMPLETION RETRY (asymmetric): a SELL must LAND. Retrying with the same tight
    // minOut just reverts again while price falls (the chase-down that dumped 1798→1766).
    // Escalate the slippage across fast retries, hard-capped, so the exit fills near the
    // peak. dex.swap re-quotes each attempt, so a wider tol is measured vs the fresh price.
    const steps = exitTolSteps(tol);
    let res = null;
    for (let i = 0; i < steps.length; i++) {
      try {
        res = await dex.swap('SELL', before.weth, steps[i]); // sell all WETH → USDC.e
        if (res.success) break;
      } catch (e) {
        const last = i + 1 >= steps.length;
        logger.warn(`EXIT attempt ${i + 1}/${steps.length} @ ${(steps[i] * 100).toFixed(2)}% slip reverted — ${last ? 'giving up (engine backs off)' : `retrying wider in ${Math.round(cfg.EXIT_RETRY_DELAY_MS / 1000)}s`}`);
        if (last) throw e;                    // exhausted → let the engine's REVERT_BACKOFF_MS take over
        await sleep(cfg.EXIT_RETRY_DELAY_MS);
      }
    }
    if (!res || !res.success) { logger.warn('SELL swap failed/reverted (all retries)'); return null; }

    const { inAmt, outAmt } = await settledAmounts(dex, before, res, 'weth', 'usdc');
    const quantity = parseFloat(ethers.formatUnits(inAmt, cfg.WETH_DECIMALS));
    let amount, estimated = false;
    if (outAmt) amount = parseFloat(ethers.formatUnits(outAmt, cfg.USDT_DECIMALS));
    else { amount = quantity * price * feeFactor(); estimated = true; logger.warn(`SELL confirmed but USDC received could not be measured — booked an ESTIMATE (${amount.toFixed(2)}). Check tx ${res.txHash}`); }
    const realized = amount / quantity;
    return finalize('SELL', s, price, extreme, amount, quantity, realized, { dry: false, gas: res.gasCostUSD, tx: res.txHash, reason, estimated });
  }
}

// ── Layer 2 swing legs (LIVE): real swaps that do NOT open/close the campaign ─────
// swing-SELL: dump all WETH mid-drawdown (campaign stays open, basis unchanged).
// swing-BUY : re-enter with the swing cash; entryWeth is REPLACED with the (larger)
//             quantity, so beLevel() ratchets down. entryUsdt/entryPrice/entryAt stay —
//             they are the ORIGINAL campaign basis (P&L + disaster reference).
async function writeSwingOrder(side, s, price, extreme, amount, quantity, realized, gas, tx, reason) {
  const code = await Counter.next('bot_order_code');
  await BotOrder.create({
    order_code: code,
    side: side === 'BUY' ? 1 : 2,
    currency1: side === 'BUY' ? 'USDT' : 'WETH',
    currency2: side === 'BUY' ? 'WETH' : 'USDT',
    amount, quantity,
    realized_rate: realized, rate: realized,
    trigger_price: price, anchor_price: extreme,
    profit: null, profit_gross: null, profit_pct: null,   // campaign still open — P&L on the final exit
    exit_reason: reason,
    gas_fee: gas || 0,
    gst_charge: gstOnUsdt(amount), gst_applied: true,
    slippage_bps: price > 0 ? Math.abs(realized - price) / price * 10000 : 0,
    special: 3, // marks a swing leg
    route: cfg.PRICE_SOURCE === 'uniswap' ? 'UNISWAP' : 'AMM',
    dry_run: false, tx_hash: tx || null, status: 1,
  });
  logger.printTrade({ code, time: new Date(), side, trigger: price, extreme, usdt: amount, weth: quantity, profit: null, profitPct: null, cumPnl: s.cumulativePnl || 0 });
  return code;
}

async function execSwingSell(s, price, atrPct) {
  const extreme = s.anchorPrice;
  const dex = getDex();
  const before = await dex.balances();
  if (before.weth <= WETH_DUST) {
    state.reconcileToCash(s); await state.saveAfterTrade(s);
    logger.warn('swing-sell: no WETH in wallet — reconciled to IN_USDT.');
    return null;
  }
  if (before.native <= 0n) { logger.warn(`swing-sell blocked — no ${cfg.NATIVE_SYMBOL} for gas`); return null; }

  const res = await dex.swap('SELL', before.weth, slippageTol(atrPct));
  if (!res.success) { logger.warn('swing-sell swap failed/reverted'); return null; }

  const sw = await settledAmounts(dex, before, res, 'weth', 'usdc');
  const quantity = parseFloat(ethers.formatUnits(sw.inAmt, cfg.WETH_DECIMALS));
  const amount = sw.outAmt ? parseFloat(ethers.formatUnits(sw.outAmt, cfg.USDT_DECIMALS)) : quantity * price * feeFactor();
  const realized = amount / quantity;

  s.position = 'IN_SWING';
  s.swingCash = amount;
  s.swingSellPrice = realized;
  s.swingCount = (s.swingCount || 0) + 1;
  s.lastSwingAt = new Date();
  s.entryGas = (s.entryGas || 0) + (res.gasCostUSD || 0); // campaign gas accumulates into the final net
  s.anchorPrice = price; s.anchorUpdatedAt = new Date();  // start tracking the swing low from here
  s.lastActionPrice = price; s.lastActionAt = new Date();
  s.txCount = (s.txCount || 0) + 1;
  await writeSwingOrder('SELL', s, price, extreme, amount, quantity, realized, res.gasCostUSD, res.txHash, 'swing-sell');
  await state.saveAfterTrade(s);
  logger.note(`Swing-sell done @ ${realized.toFixed(2)} — waiting to re-buy lower (cycle ${s.swingCount}/${cfg.SW_MAX})`);
  return s;
}

async function execSwingBuy(s, price, atrPct, reason) {
  const extreme = s.anchorPrice;
  const dex = getDex();
  const before = await dex.balances();
  if (before.usdc <= USDC_DUST) {
    if (before.weth > WETH_DUST) { await state.reconcileToWeth(s); await state.saveAfterTrade(s); logger.warn('swing-buy: wallet already holds WETH — reconciled to IN_WETH.'); }
    else logger.warn(`swing-buy blocked — wallet has no ${cfg.USDC_SYMBOL}`);
    return null;
  }
  if (before.native <= 0n) { logger.warn(`swing-buy blocked — no ${cfg.NATIVE_SYMBOL} for gas`); return null; }

  const res = await dex.swap('BUY', before.usdc, slippageTol(atrPct));
  if (!res.success) { logger.warn('swing-buy swap failed/reverted'); return null; }

  const sb = await settledAmounts(dex, before, res, 'usdc', 'weth');
  const amount = parseFloat(ethers.formatUnits(sb.inAmt, cfg.USDT_DECIMALS));
  const quantity = sb.outAmt ? parseFloat(ethers.formatUnits(sb.outAmt, cfg.WETH_DECIMALS)) : (amount / price) * feeFactor();
  const realized = amount / quantity;

  const prevQty = s.entryWeth;
  s.position = 'IN_WETH';
  s.entryWeth = quantity;                                  // replaced qty → beLevel() ratchets
  s.swingCash = null; s.swingSellPrice = null;
  s.entryGas = (s.entryGas || 0) + (res.gasCostUSD || 0);
  s.anchorPrice = price; s.anchorUpdatedAt = new Date();   // arming peak restarts here
  s.lastActionPrice = price; s.lastActionAt = new Date();
  s.txCount = (s.txCount || 0) + 1;
  await writeSwingOrder('BUY', s, price, extreme, amount, quantity, realized, res.gasCostUSD, res.txHash, reason || 'swing-buy');
  await state.saveAfterTrade(s);
  if (prevQty != null && quantity > 0) {
    const gainPct = ((quantity / prevQty) - 1) * 100;
    logger.note(`Swing-buy done @ ${realized.toFixed(2)} — ETH ${gainPct >= 0 ? '+' : ''}${gainPct.toFixed(2)}% vs before → break-even ratchets ${gainPct >= 0 ? 'DOWN' : 'UP'}`);
  }
  return s;
}

async function execute(side, s, price, reason, atrPct) {
  if (cfg.SIM_MODE) {
    const { execSim } = require('./simExecution'); // lazy: avoids loading a wallet/dex in sim
    return execSim(side, s, price, reason);
  }
  if (reason === 'swing-sell') return execSwingSell(s, price, atrPct);
  if (reason && reason.startsWith('swing-buy')) return execSwingBuy(s, price, atrPct, reason);
  return execLive(side, s, price, reason, atrPct);
}

module.exports = { _settledAmounts: settledAmounts, execute, finalize, slippageTol };
