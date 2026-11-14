// bot/repairTrades.js — npm run repair:trades [-- --apply]
// ─────────────────────────────────────────────────────────────────────────────
// Rebuilds the LIVE trade records from the blockchain: for every order with a tx
// hash it reads the receipt's ERC-20 Transfer events (what really left / arrived in
// the wallet), rewrites amount / quantity / price / profit, then recomputes the bot's
// totals (P/L, wins/losses) and clears a circuit-breaker trip caused by bad records.
//
// Default = DRY RUN (prints the corrections, writes nothing). --apply writes them,
// and refuses while the bot is running (it would overwrite the totals) —
// stop it first:  pm2 stop eather-bot  →  npm run repair:trades -- --apply  →  pm2 start eather-bot
// Read-only on-chain: needs no private key.
// ─────────────────────────────────────────────────────────────────────────────
const { ethers } = require('ethers');
const cfg = require('./config');
const botConn = require('./db');
const BotOrder = require('./models/BotOrder');
const BotState = require('./models/BotState');
const { STATE_KEY } = require('./state');
const circuitBreaker = require('./circuitBreaker');

const APPLY = process.argv.includes('--apply');
const TRANSFER = ethers.id('Transfer(address,address,uint256)');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function retry(fn) { for (let i = 0; ; i++) { try { return await fn(); } catch (e) { if (i >= 5) throw e; await sleep(1500 * (i + 1)); } } }
const f = (n, d = 2) => (n == null ? '—' : Number(n).toFixed(d));

(async () => {
  if (cfg.SIM_MODE) { console.log('This repairs LIVE records only (BOT_SIM is set).'); process.exit(1); }
  await botConn.asPromise();
  const provider = new ethers.JsonRpcProvider(cfg.RPC_HTTP, cfg.CHAIN_ID, { staticNetwork: true });
  const me = cfg.ADMIN_WALLET.toLowerCase(), USDC = cfg.USDC_ADDRESS.toLowerCase(), WETH = cfg.WETH_ADDRESS.toLowerCase();
  const orders = await BotOrder.find({ dry_run: { $ne: true } }).sort({ createdAt: 1 }).lean();
  console.log(`${orders.length} live orders in ${BotOrder.collection.collectionName} (${cfg.CHAIN_NAME}) — ${APPLY ? 'APPLYING corrections' : 'dry run (add --apply to write)'}\n`);

  const fixes = []; let buy = null; let cum = 0, wins = 0, losses = 0, trips = 0, changed = 0, missing = 0;
  for (const o of orders) {
    let usdcOut = 0n, usdcIn = 0n, wethOut = 0n, wethIn = 0n;
    const r = o.tx_hash ? await retry(() => provider.getTransactionReceipt(o.tx_hash)) : null;
    if (!r || r.status !== 1) { missing++; console.log(`  ⚠️ #${o.order_code} ${o.side === 1 ? 'BUY' : 'SELL'}: no successful receipt — left unchanged`); if (o.side === 1) buy = { amount: o.amount, gas: o.gas_fee || 0 }; continue; }
    for (const l of r.logs) {
      if (l.topics[0] !== TRANSFER || l.topics.length < 3) continue;
      const from = ('0x' + l.topics[1].slice(26)).toLowerCase(), to = ('0x' + l.topics[2].slice(26)).toLowerCase(), v = BigInt(l.data), t = l.address.toLowerCase();
      if (t === USDC && from === me) usdcOut += v; if (t === USDC && to === me) usdcIn += v;
      if (t === WETH && from === me) wethOut += v; if (t === WETH && to === me) wethIn += v;
    }
    const usdc = Number(ethers.formatUnits(o.side === 1 ? usdcOut : usdcIn, cfg.USDT_DECIMALS));
    const weth = Number(ethers.formatUnits(o.side === 1 ? wethIn : wethOut, cfg.WETH_DECIMALS));
    const set = { amount: usdc, quantity: weth, realized_rate: weth > 0 ? usdc / weth : o.realized_rate, rate: weth > 0 ? usdc / weth : o.rate };
    if (o.side === 1) {
      buy = { amount: usdc, gas: o.gas_fee || 0 };
    } else if (buy) {
      const gross = usdc - buy.amount;
      set.profit_gross = gross;
      set.profit = gross - buy.gas - (o.gas_fee || 0);
      set.profit_pct = buy.amount > 0 ? (set.profit / buy.amount) * 100 : null;
      cum += set.profit; trips++; if (set.profit >= 0) wins++; else losses++;
      buy = null;
    }
    const diff = Math.abs((o.amount || 0) - usdc) > 0.005 || Math.abs((o.quantity || 0) - weth) > 1e-7 || (set.profit != null && Math.abs((o.profit || 0) - set.profit) > 0.005);
    if (diff) {
      changed++;
      console.log(`  ✏️  #${o.order_code} ${o.side === 1 ? 'BUY ' : 'SELL'} ${new Date(o.createdAt).toISOString().slice(0, 16)}  ` +
        `usdc ${f(o.amount)}→${f(usdc)}  weth ${f(o.quantity, 5)}→${f(weth, 5)}${set.profit != null ? `  profit ${f(o.profit)}→${f(set.profit, 3)}` : ''}`);
    }
    fixes.push({ _id: o._id, set });
  }

  const s = await BotState.findOne({ key: STATE_KEY });
  console.log(`\n${changed} order(s) need correcting${missing ? `, ${missing} without a receipt` : ''}.`);
  console.log(`Totals: P/L ${f(s && s.cumulativePnl)} → ${f(cum, 3)} | round trips ${s && s.roundTrips} → ${trips} | W/L ${s && s.wins}/${s && s.losses} → ${wins}/${losses}`);
  if (s && s.cbTripped) console.log(`Circuit breaker: currently TRIPPED (${s.cbReason}: ${s.cbDetail}) → will be reset`);

  if (!APPLY) { console.log('\nDry run only — nothing written. To apply: pm2 stop eather-bot && npm run repair:trades -- --apply && pm2 start eather-bot'); process.exit(0); }

  const ageS = s && s.hbAt ? (Date.now() - new Date(s.hbAt).getTime()) / 1000 : Infinity;
  if (s && !s.hbStopped && ageS < 60) {
    console.log(`\n⛔ The bot is running (heartbeat ${Math.round(ageS)}s ago) — it would overwrite the corrected totals.\n   Stop it first: pm2 stop eather-bot   (then run this again, then: pm2 start eather-bot)`);
    process.exit(1);
  }
  for (const x of fixes) await BotOrder.updateOne({ _id: x._id }, { $set: x.set });
  if (s) {
    s.cumulativePnl = cum; s.roundTrips = trips; s.wins = wins; s.losses = losses;
    circuitBreaker.reset(s); // counters restart from the corrected P/L
    const last = orders[orders.length - 1], lastFix = fixes[fixes.length - 1];
    if (last && last.side === 1 && s.position === 'IN_WETH' && lastFix) { // open position: correct its cost basis too
      s.entryUsdt = lastFix.set.amount; s.entryWeth = lastFix.set.quantity; s.entryPrice = lastFix.set.realized_rate;
    }
    await s.save();
  }
  console.log(`\n✅ Applied: ${fixes.length} orders rewritten from the blockchain, totals recomputed, circuit breaker reset. Now: pm2 start eather-bot`);
  process.exit(0);
})().catch((e) => { console.error('💥', e.shortMessage || e.message || e); process.exit(1); });
