// bot/circuitBreaker.js
// ─────────────────────────────────────────────────────────────────────────────
// Stops NEW BUYS after repeated losses so a bad market can't drain the wallet one
// small loss at a time. It never blocks a SELL — an open position keeps its normal
// exits (regime / disaster stop …).
//
//   consecutive : CB_MAX_CONSEC_LOSSES losing round trips in a row   → manual reset
//   daily       : realized loss today (UTC) ≥ CB_MAX_DAILY_LOSS_USD   → clears next UTC day
//   drawdown    : realized P&L fell CB_MAX_DRAWDOWN_USD from its best → manual reset
//
// State lives on BotState (cb* fields) and is persisted with every trade, so a
// pm2 crash-restart cannot silently resume. Manual reset: the dashboard's
// "Reset breaker" button, or `npm run cb:reset` followed by a bot restart.
// ─────────────────────────────────────────────────────────────────────────────
const cfg = require('./config');

const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);
const usd = (n) => (n >= 0 ? '+' : '−') + '$' + Math.abs(n).toFixed(2);

// Call after every closed round trip (SELL with a known profit). Mutates s; the
// caller persists it. Returns the trip info if this trade tripped the breaker.
function onTradeClosed(s, profit) {
  if (profit == null) return null;
  const today = utcDay();
  if (s.cbDay !== today) { s.cbDay = today; s.cbDayPnl = 0; }
  s.cbDayPnl = (s.cbDayPnl || 0) + profit;
  s.cbConsecLosses = profit < 0 ? (s.cbConsecLosses || 0) + 1 : 0;
  s.cbPeakPnl = Math.max(s.cbPeakPnl || 0, s.cumulativePnl || 0);

  if (!cfg.CB_ENABLED || s.cbTripped) return null;
  let reason = null, detail = null;
  const drawdown = (s.cbPeakPnl || 0) - (s.cumulativePnl || 0);
  if (cfg.CB_MAX_CONSEC_LOSSES > 0 && s.cbConsecLosses >= cfg.CB_MAX_CONSEC_LOSSES) {
    reason = 'consecutive'; detail = `${s.cbConsecLosses} losing trades in a row`;
  } else if (cfg.CB_MAX_DAILY_LOSS_USD > 0 && s.cbDayPnl <= -cfg.CB_MAX_DAILY_LOSS_USD) {
    reason = 'daily'; detail = `lost $${(-s.cbDayPnl).toFixed(2)} today (limit $${cfg.CB_MAX_DAILY_LOSS_USD})`;
  } else if (cfg.CB_MAX_DRAWDOWN_USD > 0 && drawdown >= cfg.CB_MAX_DRAWDOWN_USD) {
    reason = 'drawdown'; detail = `P/L fell $${drawdown.toFixed(2)} from its best (limit $${cfg.CB_MAX_DRAWDOWN_USD})`;
  }
  if (!reason) return null;

  s.cbTripped = true; s.cbReason = reason; s.cbDetail = detail; s.cbTrippedAt = new Date();
  console.warn(`⛔ CIRCUIT BREAKER tripped (${reason}): ${detail} — no new buys (${reason === 'daily' ? 'clears at 00:00 UTC' : 'reset from the dashboard'})`);
  return { reason, detail };
}

// true = do not open a new position. Clears an expired 'daily' trip (caller persists).
function blocksBuy(s) {
  if (!cfg.CB_ENABLED || !s.cbTripped) return false;
  if (s.cbReason === 'daily' && s.cbDay !== utcDay()) {
    s.cbTripped = false; s.cbReason = null; s.cbDetail = null; s.cbTrippedAt = null;
    s.cbDay = utcDay(); s.cbDayPnl = 0;
    console.log('✅ circuit breaker: new UTC day — daily loss limit reset, buying allowed again');
    return false;
  }
  return true;
}

// clear a trip + counters (dashboard "Reset breaker" / npm run cb:reset). Mutates s.
function reset(s) {
  Object.assign(s, {
    cbTripped: false, cbReason: null, cbDetail: null, cbTrippedAt: null,
    cbConsecLosses: 0, cbDay: utcDay(), cbDayPnl: 0, cbPeakPnl: s.cumulativePnl || 0,
  });
}

function status(s) {
  if (!cfg.CB_ENABLED) return 'off';
  if (s.cbTripped) return `TRIPPED (${s.cbReason}): ${s.cbDetail}`;
  return `ok — ${s.cbConsecLosses || 0}/${cfg.CB_MAX_CONSEC_LOSSES || '∞'} losses in a row, today ${usd(s.cbDayPnl || 0)}`;
}

module.exports = { onTradeClosed, blocksBuy, reset, status, utcDay };
