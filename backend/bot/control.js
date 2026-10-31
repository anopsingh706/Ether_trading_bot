// bot/control.js
// ─────────────────────────────────────────────────────────────────────────────
// The bot side of the dashboard. Talks ONLY through the bot's own BotState doc:
//   • heartbeat (every 10s): alive?, version, price, status line, last error
//   • commands  (polled every 3s), written by the dashboard:
//       ctlPaused            → no new buys (an open position is still managed)
//       ctlSellReqAt         → emergency sell of the open position, then pause
//       ctlCbResetReqAt      → clear a tripped circuit breaker
// The dashboard never touches the bot process or the wallet key — the bot carries
// out every command itself, with its normal safety checks (lock, slippage, retries).
// ─────────────────────────────────────────────────────────────────────────────
const pkg = require('../package.json');
const cfg = require('./config');
const BotState = require('./models/BotState');
const state = require('./state');
const circuitBreaker = require('./circuitBreaker');

const key = () => state.STATE_KEY;
let paused = false;
let pollTimer = null, hbTimer = null;
const isNewer = (req, done) => req && (!done || new Date(req) > new Date(done));

async function heartbeat(engine, feed) {
  await BotState.updateOne({ key: key() }, { $set: {
    hbAt: new Date(), hbStopped: false, hbPid: process.pid, hbVersion: pkg.version,
    hbMode: cfg.SIM_MODE ? 'sim' : 'live', hbChain: cfg.CHAIN_NAME, hbExitMode: cfg.EXIT_MODE,
    hbPrice: feed.lastPrice || null, hbStale: feed.isStale(), hbLine: engine.statusLine || null,
    hbLastError: engine.lastError || null,
  } });
}

async function poll(engine, feed) {
  const d = await BotState.findOne({ key: key() },
    { ctlPaused: 1, ctlSellReqAt: 1, ctlSellDoneAt: 1, ctlCbResetReqAt: 1, ctlCbResetDoneAt: 1 }).lean();
  if (!d) return;
  if (!!d.ctlPaused !== paused) console.log(d.ctlPaused ? '⏸  [control] PAUSED from the dashboard — no new buys' : '▶️  [control] RESUMED from the dashboard');
  paused = !!d.ctlPaused;

  if (isNewer(d.ctlCbResetReqAt, d.ctlCbResetDoneAt)) {
    circuitBreaker.reset(engine.state);
    await state.saveAfterTrade(engine.state);
    await BotState.updateOne({ key: key() }, { $set: { ctlCbResetDoneAt: new Date() } });
    console.log('✅ [control] circuit breaker reset from the dashboard');
  }

  if (isNewer(d.ctlSellReqAt, d.ctlSellDoneAt)) {
    if (engine.busy) return;                      // a swap is in flight — try again next poll
    let note;
    if (engine.state.position === 'IN_WETH') {
      console.log('🚨 [control] EMERGENCY SELL requested from the dashboard');
      await engine.manualSell(feed.lastPrice);
      if (engine.state.position === 'IN_WETH') {  // swap failed / backing off — keep the request, retry
        await BotState.updateOne({ key: key() }, { $set: { ctlSellNote: `attempt failed at ${new Date().toISOString()} — retrying` } });
        return;
      }
      note = 'sold';
    } else {
      note = 'nothing to sell (already in cash)';
    }
    paused = true;                                // emergency sell always leaves the bot paused
    await BotState.updateOne({ key: key() }, { $set: { ctlSellDoneAt: new Date(), ctlSellNote: note, ctlPaused: true } });
    console.log(`🚨 [control] emergency sell done (${note}) — bot is now PAUSED`);
  }
}

// Call AFTER engine.init() and BEFORE the price feed starts, so a saved pause is
// already in force when the first tick arrives.
function start(engine, feed) {
  paused = !!(engine.state && engine.state.ctlPaused);
  if (paused) console.warn('⏸  [control] bot is PAUSED (set from the dashboard) — no new buys until resumed');
  engine.isPaused = () => paused;
  const safe = (fn) => () => fn(engine, feed).catch(() => {}); // DB hiccups must never hurt trading
  pollTimer = setInterval(safe(poll), 3000);
  hbTimer = setInterval(safe(heartbeat), 10000);
  safe(heartbeat)();
}

async function stopped() {
  clearInterval(pollTimer); clearInterval(hbTimer);
  await BotState.updateOne({ key: key() }, { $set: { hbStopped: true, hbAt: new Date() } });
}

module.exports = { start, stopped, paused: () => paused, _poll: poll };
