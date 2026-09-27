// bot/manualTrade.js
// ─────────────────────────────────────────────────────────────────────────────
// Standalone one-off manual BUY/SELL — reuses the EXACT SAME execution engine,
// wallet, DB state, and safety logic the live bot uses (bot/execution.js), so a
// manual trade is recorded and tracked identically to an automatic one.
//
// ⚠️ Only run this while the live bot process (npm run bot) is STOPPED — running
// both at once risks a double-buy since they'd share the same wallet/state.
//
//   Usage:
//     node bot/manualTrade.js buy
//     node bot/manualTrade.js sell
// ─────────────────────────────────────────────────────────────────────────────
const cfg = require('./config');
const botConn = require('./db');
const state = require('./state');
const execution = require('./execution');
const UniswapFeed = require('./uniswapFeed');
const logger = require('./logger');

const side = (process.argv[2] || '').toUpperCase();

(async () => {
  if (side !== 'BUY' && side !== 'SELL') {
    console.error('Usage: node bot/manualTrade.js buy|sell');
    process.exit(1);
  }
  if (cfg.SIM_MODE) {
    console.error('BOT_SIM is true in this environment — refusing to run a "manual trade" in sim mode. Unset it for a real trade.');
    process.exit(1);
  }

  await botConn.asPromise();
  console.log(`✅ [bot-db] connected → db "${botConn.name}"`);

  const locked = await state.acquireLock();
  if (!locked) {
    console.error('⛔ Another process holds the trade lock (is the live bot still running?). Aborting.');
    process.exit(1);
  }

  try {
    const s = await state.loadOrInit();
    console.log(`   current position: ${s.position} | anchor ${s.anchorPrice ?? '—'}`);

    if (side === 'BUY' && s.position !== 'IN_USDT') {
      console.error(`⛔ Refusing to BUY — position is already ${s.position}, not IN_USDT.`);
      return;
    }
    if (side === 'SELL' && s.position !== 'IN_WETH') {
      console.error(`⛔ Refusing to SELL — position is ${s.position}, not IN_WETH.`);
      return;
    }

    // One-shot on-chain price read (same pool the trade will execute against).
    const feed = new UniswapFeed();
    await feed._resolvePool();
    await feed._readPrice('init');
    const price = feed.lastPrice;
    if (!price) { console.error('⛔ Could not read a live pool price. Aborting.'); return; }
    console.log(`   live pool price: ${price.toFixed(2)}`);

    console.log(`\n🖐️  Executing MANUAL ${side} @ ~${price.toFixed(2)}…\n`);
    logger.tradeTableHeader();
    const updated = await execution.execute(side, s, price, 'manual', null);
    if (!updated) {
      console.error('⛔ Trade did not execute (see warning above — likely a balance/dust check failed).');
      return;
    }
    logger.tableFooter();
    console.log(`\n✅ Done. New position: ${updated.position}${updated.entryPrice ? ` @ entry ${updated.entryPrice.toFixed(2)}` : ''}`);
    console.log('   Restart the live bot (npm run bot) now to resume automatic trading from this state.');
  } finally {
    await state.releaseLock();
    await botConn.close();
  }
})().catch((e) => {
  console.error('💥 manual trade failed:', e.message || e);
  process.exit(1);
});
