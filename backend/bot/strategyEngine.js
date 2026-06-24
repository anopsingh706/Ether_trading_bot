// bot/strategyEngine.js
// ─────────────────────────────────────────────────────────────────────────────
// THE STRATEGY (trailing 0.05 reversal):
//
//   IN_USDT (waiting to buy):
//      track the LOWEST price (trough). When price rises Δ above the trough → BUY.
//   IN_WETH (waiting to sell):
//      track the HIGHEST price (peak). When price falls Δ below the peak → SELL.
//
//   → "buy as it starts rising, sell as it starts falling", strictly alternating.
//
// The anchor TRAILS the price in the favourable direction; a trade fires only on a
// Δ reversal, so sub-Δ noise never trades. State is driven by BotState.position,
// never by re-reading the last order.
// ─────────────────────────────────────────────────────────────────────────────
const cfg = require('./config');
const state = require('./state');
const execution = require('./execution');
const logger = require('./logger');

class StrategyEngine {
  constructor(feed) {
    this.feed = feed;
    this.state = null;
    this.busy = false;    // in-memory re-entrancy guard while a swap is in flight
    this.halted = false;  // set if SLIPPAGE_HALT trips on a bad fill
    this._lastGuardLog = 0;
    this._lastTrendLog = 0;
    this._lastExitLog = 0;
    this.ema = null;        // #1: smoothed decision price (EMA); null until first tick
    this._emaTs = 0;
    this.priceHist = [];                                    // rolling {p, ts} for the trend MA
    this.lastTrend = { ready: false, ma: null, up: false }; // exposed for the status line
    this._pendingEntry = null;                              // a breakout being confirmed (anti fake-spike)
  }

  async init() {
    this.state = await state.loadOrInit();
    console.log(
      `🤖 [engine] ready | mode=LIVE | ` +
      `entry +${cfg.ENTRY_THRESHOLD}/exit -${cfg.EXIT_THRESHOLD} (${cfg.THRESHOLD_MODE})${cfg.SMOOTHING ? ' | EMA ' + Math.round(cfg.SMOOTHING_MS / 1000) + 's' : ''} | position=${this.state.position} | ` +
      `anchor=${this.state.anchorPrice ?? '—'}`
    );
  }

  // #3 — thresholds in price terms (absolute USD, or % of the anchor): a WIDER
  // entry confirmation and a TIGHTER trailing exit.
  _entryDelta(anchor) {
    return cfg.THRESHOLD_MODE === 'percent' ? (anchor * cfg.ENTRY_THRESHOLD) / 100 : cfg.ENTRY_THRESHOLD;
  }
  _exitDelta(anchor) {
    return cfg.THRESHOLD_MODE === 'percent' ? (anchor * cfg.EXIT_THRESHOLD) / 100 : cfg.EXIT_THRESHOLD;
  }

  // #1 — EMA-smoothed decision price. Time-based, so irregular tick spacing (WSS
  // blocks + HTTPS polls) is handled correctly. Returns the raw price if smoothing
  // is off. A single noisy tick barely moves the EMA → no fake reversals.
  _smoothPrice(price) {
    if (!cfg.SMOOTHING) return price;
    const now = Date.now();
    if (this.ema == null) { this.ema = price; this._emaTs = now; return this.ema; }
    const dt = now - this._emaTs;
    this._emaTs = now;
    const alpha = 1 - Math.exp(-dt / cfg.SMOOTHING_MS);
    this.ema += alpha * (price - this.ema);
    return this.ema;
  }

  _cooldownActive() {
    if (!cfg.COOLDOWN_MS || !this.state.lastActionAt) return false;
    return Date.now() - new Date(this.state.lastActionAt).getTime() < cfg.COOLDOWN_MS;
  }

  // OD-2: only allow a SELL if the expected net result clears MIN_NET_PROFIT.
  // 0 = guard off (always sell on the reversal). >0 = hold rather than realise a
  // result below the minimum (this can hold a losing position — by design).
  _passesProfitGuard(price) {
    if (!cfg.MIN_NET_PROFIT || cfg.MIN_NET_PROFIT <= 0) return true;
    const s = this.state;
    if (s.entryWeth == null || s.entryUsdt == null) return true; // no cost basis → can't gate, allow
    const expectedNet = price * s.entryWeth - s.entryUsdt - (cfg.EST_COST_PER_TRADE || 0);
    if (expectedNet >= cfg.MIN_NET_PROFIT) return true;
    const now = Date.now();
    if (now - this._lastGuardLog > 30000) { // throttle so we don't spam every tick
      this._lastGuardLog = now;
      logger.note(`Profit guard: reversal hit, but expected net ${expectedNet.toFixed(2)} < min ${cfg.MIN_NET_PROFIT} USDC → holding`);
    }
    return false;
  }

  // Option B trend filter: rolling moving average; "uptrend" = price at/above the MA.
  _updateTrend(price) {
    const ts = Date.now();
    this.priceHist.push({ p: price, ts });
    const cutoff = ts - cfg.TREND_WINDOW_MS;
    while (this.priceHist.length && this.priceHist[0].ts < cutoff) this.priceHist.shift();
    const n = this.priceHist.length;
    if (n === 0) { this.lastTrend = { ready: false, ma: null, up: false }; return this.lastTrend; }
    const ma = this.priceHist.reduce((sum, x) => sum + x.p, 0) / n;
    this.lastTrend = { ready: n >= cfg.TREND_MIN_SAMPLES, ma, up: price >= ma };
    return this.lastTrend;
  }

  // Protective exits, evaluated while IN_WETH. These OVERRIDE the profit guard so a
  // long is CUT instead of bag-held through a downtrend — the symmetric partner to
  // the trend filter on entry. Profit-taking is handled separately (Δ-reversal +
  // MIN_NET_PROFIT), so small wins still bank. Returns {tag, detail} or null.
  _protectiveExit(price, trend) {
    const s = this.state;
    if (s.entryPrice == null) return null; // no cost basis → nothing to protect

    // 1) Hard stop-loss vs the entry price — caps the loss on any single trade.
    if (cfg.STOP_LOSS_PCT > 0) {
      const dropPct = ((s.entryPrice - price) / s.entryPrice) * 100; // +ve when underwater
      if (dropPct >= cfg.STOP_LOSS_PCT) {
        return { tag: 'stop-loss', detail: `-${dropPct.toFixed(2)}% vs entry ${s.entryPrice.toFixed(2)}` };
      }
    }

    // 2) Trend flip — the moving-average trend turned down while we hold. Usually
    //    fires before the hard stop, so losers are cut early (and a small winner is
    //    banked when momentum fades).
    if (cfg.TREND_EXIT && trend.ready && !trend.up) {
      return { tag: 'trend-down', detail: `price ${price.toFixed(2)} < MA ${trend.ma.toFixed(2)}` };
    }

    return null;
  }

  // Trend filter gate for BUYS (throttled log). Returns true if a buy is blocked.
  _trendBlocksBuy(price, trend) {
    if (!cfg.TREND_FILTER || (trend.ready && trend.up)) return false;
    const now = Date.now();
    if (now - this._lastTrendLog > 30000) {
      this._lastTrendLog = now;
      logger.note(!trend.ready
        ? `Trend filter warming up (${this.priceHist.length}/${cfg.TREND_MIN_SAMPLES} ticks) — staying in cash`
        : `Trend filter: downtrend (price ${price.toFixed(2)} < MA ${trend.ma.toFixed(2)}) — staying in cash`);
    }
    return true;
  }

  async onTick({ price }) {
    if (!this.state || this.busy || this.halted) return;
    if (this.feed.isStale()) return; // never act on stale data

    const trend = this._updateTrend(price);   // trend MA on the RAW price (unchanged)
    const p = this._smoothPrice(price);         // #1: smoothed decision price (EMA)
    const s = this.state;

    if (s.position === 'IN_USDT') {
      // Track the trough (new low) on the SMOOTHED price. A new low also voids any
      // breakout we were confirming (that move failed).
      if (s.anchorPrice == null || p < s.anchorPrice) {
        s.anchorPrice = p;
        s.anchorUpdatedAt = new Date();
        await state.persistAnchor(s);
        if (this._pendingEntry) this._pendingEntry = null;
        return;
      }

      const trigger = s.anchorPrice + this._entryDelta(s.anchorPrice);

      if (p >= trigger) {
        // Above the breakout level. FAKE-SPIKE FILTER: require the smoothed price to
        // HOLD above the trigger for ENTRY_CONFIRM_MS before buying. A pop that fades
        // back below the trigger (handled in the else branch) is skipped.
        if (cfg.ENTRY_CONFIRM_MS > 0) {
          if (!this._pendingEntry) {
            this._pendingEntry = { level: trigger, since: Date.now() };
            logger.note(`Breakout candidate ${p.toFixed(2)} ≥ ${trigger.toFixed(2)} — confirming ${Math.round(cfg.ENTRY_CONFIRM_MS / 1000)}s (fake-spike filter)…`);
            return;
          }
          if (Date.now() - this._pendingEntry.since < cfg.ENTRY_CONFIRM_MS) return; // still confirming
          this._pendingEntry = null; // held the full window → real breakout
        }
        if (this._trendBlocksBuy(price, trend)) return;
        await this._act('BUY', p);
      } else if (this._pendingEntry) {
        // Fell back below the trigger before confirming → it was a fake spike.
        logger.note(`Fake spike rejected: fell to ${p.toFixed(2)} below trigger ${this._pendingEntry.level.toFixed(2)} before confirming — staying in cash`);
        this._pendingEntry = null;
      }
    } else {
      // IN_WETH: track the peak (new high) on the SMOOTHED price.
      if (s.anchorPrice == null || p > s.anchorPrice) {
        s.anchorPrice = p;
        s.anchorUpdatedAt = new Date();
        await state.persistAnchor(s);
        return;
      }
      // PROTECTIVE EXIT — cut a losing/fading position (overrides the profit guard)
      // so we never bag-hold through a downtrend.
      const ex = this._protectiveExit(p, trend);
      if (ex) {
        const now = Date.now();
        if (now - this._lastExitLog > 15000) {
          this._lastExitLog = now;
          logger.note(`Protective exit (${ex.tag}): ${ex.detail} — cutting the position`);
        }
        await this._act('SELL', p, ex.tag);
        return;
      }

      // #3: TIGHT trailing profit exit — SELL when the smoothed price falls the
      // NARROW exit threshold off the peak (capture most of the move). Gated by
      // MIN_NET_PROFIT (set it to 0 so the tight exit can also cut failed bounces).
      if (p <= s.anchorPrice - this._exitDelta(s.anchorPrice)) {
        if (this._passesProfitGuard(p)) await this._act('SELL', p);
      }
    }
  }

  async _act(side, price, reason = null) {
    if (side === 'BUY' && this._cooldownActive()) return; // cooldown gates re-ENTRY only; never blocks a protective SELL
    this.busy = true;

    // Persistent cross-process lock: refuse to trade if another instance is mid-swap.
    const locked = await state.acquireLock();
    if (!locked) {
      this.busy = false;
      const now = Date.now();
      if (now - this._lastGuardLog > 30000) {
        this._lastGuardLog = now;
        logger.note('Another instance holds the trade lock — skipping this trade');
      }
      return;
    }

    try {
      const updated = await execution.execute(side, this.state, price, reason);
      if (updated) this.state = updated;
      if (this.state && this.state.slippageHalt) {
        this.halted = true;
        logger.warn('TRADING HALTED after a bad fill (SLIPPAGE_HALT). Restart the bot to resume.');
      }
    } catch (e) {
      logger.warn('[engine] execution error: ' + (e.message || e));
    } finally {
      await state.releaseLock();
      this.busy = false;
    }
  }
}

module.exports = StrategyEngine;
