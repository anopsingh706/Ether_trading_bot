// bot/state.js
// ─────────────────────────────────────────────────────────────────────────────
// Helpers for loading / initialising / persisting the single BotState document.
// Anchor updates happen on every favourable tick, so we THROTTLE those DB writes;
// trade outcomes (with cost basis + metrics) are always persisted immediately.
// ─────────────────────────────────────────────────────────────────────────────
const cfg = require('./config');
const BotState = require('./models/BotState');
const BotOrder = require('./models/BotOrder');

const STATE_KEY = 'singleton';

// Recover the open position's cost basis from the most recent BUY order. Used on
// resume and when reconciling a desynced position so the next SELL can still
// compute profit.
async function recoverEntryFromLastBuy(s) {
  const lastBuy = await BotOrder.findOne({ side: 1 }).sort({ createdAt: -1 });
  if (lastBuy) {
    s.entryUsdt = lastBuy.amount;
    s.entryWeth = lastBuy.quantity;
    s.entryPrice = lastBuy.realized_rate;
    s.entryGas = lastBuy.gas_fee || 0;
    s.entryAt = lastBuy.createdAt;
    console.log(`🩹 [state] recovered cost basis from BUY #${lastBuy.order_code} (${lastBuy.amount} USDT)`);
  } else {
    console.log('⚠️ [state] holding WETH but no prior BUY found — next SELL profit will be unknown');
  }
}

// Reconcile the in-memory position to match reality (the caller persists via
// saveAfterTrade). reconcileToCash = we are flat (no WETH); reconcileToWeth = we
// actually hold WETH (recover its cost basis). Both reset the trailing anchor.
function reconcileToCash(s) {
  s.position = 'IN_USDT';
  s.entryUsdt = null; s.entryWeth = null; s.entryPrice = null; s.entryGas = null; s.entryAt = null;
  s.anchorPrice = null; s.anchorUpdatedAt = null;
}
async function reconcileToWeth(s) {
  s.position = 'IN_WETH';
  s.anchorPrice = null; s.anchorUpdatedAt = null;
  await recoverEntryFromLastBuy(s);
}

async function loadOrInit() {
  let s = await BotState.findOne({ key: STATE_KEY });

  if (!s) {
    s = await BotState.create({
      key: STATE_KEY,
      position: 'IN_USDT',
      anchorPrice: null,
      threshold: cfg.THRESHOLD,
    });
    console.log('🆕 [state] initialised fresh state');
    return s;
  }

  console.log('🔁 [state] resumed existing state from DB');

  // EDGE CASE: resumed while holding WETH but with no recorded cost basis
  // (e.g. state created before profit tracking existed). Recover it from the
  // last BUY order so the next SELL can still compute profit.
  if (s.position === 'IN_WETH' && (s.entryUsdt == null || s.entryPrice == null)) {
    await recoverEntryFromLastBuy(s);
    await s.save();
  }

  // RE-ANCHOR ON RESTART: a persisted peak/bottom can be hours/days stale after a
  // stop. Trading off it would fire a wrong entry/exit the instant the feed returns
  // (e.g. "buy" just because price is above yesterday's level). Clearing it makes the
  // FIRST live tick re-lock the trailing extreme to the CURRENT price. Position and
  // cost basis (entry*) are preserved — only the trailing reference resets.
  if (s.anchorPrice != null) {
    console.log(`🔄 [state] re-anchoring: clearing stale ${s.position === 'IN_WETH' ? 'peak' : 'bottom'} ${s.anchorPrice} → will re-lock to first live price`);
    s.anchorPrice = null;
    s.anchorUpdatedAt = null;
  }

  return s;
}

let _lastAnchorPersist = 0;
async function persistAnchor(s) {
  const now = Date.now();
  if (now - _lastAnchorPersist < cfg.PERSIST_THROTTLE_MS) return;
  _lastAnchorPersist = now;
  await BotState.updateOne(
    { key: STATE_KEY },
    { $set: { anchorPrice: s.anchorPrice, anchorUpdatedAt: s.anchorUpdatedAt } }
  );
}

async function saveAfterTrade(s) {
  await BotState.updateOne(
    { key: STATE_KEY },
    {
      $set: {
        position: s.position,
        anchorPrice: s.anchorPrice,
        anchorUpdatedAt: s.anchorUpdatedAt,
        lastActionPrice: s.lastActionPrice,
        lastActionAt: s.lastActionAt,
        entryUsdt: s.entryUsdt,
        entryWeth: s.entryWeth,
        entryPrice: s.entryPrice,
        entryGas: s.entryGas,
        entryAt: s.entryAt,
        roundTrips: s.roundTrips,
        wins: s.wins,
        losses: s.losses,
        cumulativePnl: s.cumulativePnl,
      },
    }
  );
}

// Persistent cross-process execution lock — atomic acquire so a 2nd instance (or a
// crash-resume) cannot fire a second swap on the same wallet. A lock older than 2 min
// is treated as stale (previous process died mid-swap) and can be re-acquired.
async function acquireLock() {
  const staleBefore = new Date(Date.now() - 2 * 60 * 1000);
  const res = await BotState.findOneAndUpdate(
    { key: STATE_KEY, $or: [{ isExecuting: { $ne: true } }, { lockedAt: { $lt: staleBefore } }] },
    { $set: { isExecuting: true, lockedAt: new Date() } },
    { new: true }
  );
  return !!res; // true = we hold the lock; false = another instance is mid-trade
}
async function releaseLock() {
  await BotState.updateOne({ key: STATE_KEY }, { $set: { isExecuting: false, lockedAt: null } });
}

module.exports = { STATE_KEY, loadOrInit, persistAnchor, saveAfterTrade, acquireLock, releaseLock, reconcileToCash, reconcileToWeth };
