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
  constructor(feed, volumeFeed = null) {
    this.feed = feed;
    this.volume = volumeFeed;   // Binance volume source for the false-breakout filter
    this._lastVolLog = 0;
    this.lastVolume = null;      // last volume check (exposed for the status line)
    this.state = null;
    this.busy = false;    // in-memory re-entrancy guard while a swap is in flight
    this.halted = false;  // set if SLIPPAGE_HALT trips on a bad fill
    this._lastGuardLog = 0;
    this._lastTrendLog = 0;
    this._lastExitLog = 0;
    this._lastAtrLog = 0;
    this.lastAtr = null;     // last ATR check (exposed for the status line)
    this._revertUntil = 0;   // gas-burn guard: no swap attempts until this time after an execution error
    this._lastBackoffLog = 0;
    this._lastBeLog = 0;
    this.lastBE = null;      // current break-even level (exposed for the status line)
    this.ema = null;        // #1: smoothed decision price (EMA); null until first tick
    this._emaTs = 0;
    this.priceHist = [];                                    // rolling {p, ts} for the trend MA
    this.lastTrend = { ready: false, ma: null, up: false }; // exposed for the status line
    this._pendingEntry = null;                              // a breakout being confirmed (anti fake-spike)
  }

  async init() {
    this.state = await state.loadOrInit();
    console.log(
      `🤖 [engine] ready | mode=${cfg.SIM_MODE ? 'SIM' : 'LIVE'} | ` +
      `entry +${cfg.ENTRY_THRESHOLD}/exit -${cfg.EXIT_THRESHOLD} (${cfg.THRESHOLD_MODE})${cfg.SMOOTHING ? ' | EMA ' + Math.round(cfg.SMOOTHING_MS / 1000) + 's' : ''} | position=${this.state.position} | ` +
      `anchor=${this.state.anchorPrice ?? '—'}`
    );
  }

  // #3 — thresholds in price terms (absolute USD, or % of the anchor): a WIDER
  // entry confirmation and a TIGHTER trailing exit.
  _entryDelta(anchor) {
    let d = cfg.THRESHOLD_MODE === 'percent' ? (anchor * cfg.ENTRY_THRESHOLD) / 100 : cfg.ENTRY_THRESHOLD;
    // ATR-adaptive: widen the trigger when the market is volatile so we don't enter on
    // sub-volatility noise (only active when BOT_ATR_ENTRY_MULT > 0).
    if (cfg.ATR_ENTRY_MULT > 0 && this.volume) {
      const a = this.volume.atr();
      if (a.ready) d = Math.max(d, a.atr * cfg.ATR_ENTRY_MULT);
    }
    return d;
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

  // Break-even sell LEVEL for the open position: the pool price at which selling all
  // entryWeth returns entryUsdt after the LP fee, plus BE_BUFFER_PCT margin (covers
  // both gas legs + rounding, so a "breakeven" exit nets ≥ 0, not −$0.02).
  beLevel() {
    const s = this.state;
    if (s.entryUsdt == null || !(s.entryWeth > 0)) return null;
    const fee = cfg.POOL_FEE / 1e6; // 500 → 0.0005
    return (s.entryUsdt * (1 + cfg.BE_BUFFER_PCT / 100)) / (s.entryWeth * (1 - fee));
  }

  // 'breakeven' exit mode: NEVER sell below break-even — hold underwater until price
  // recovers (no small red exits). Above BE, trail the peak with the BE as a hard
  // floor. The ONLY loss this mode realizes is the deep disaster stop (raw price),
  // which keeps a structural crash bounded instead of freezing the bot indefinitely.
  async _beExit(p, rawPrice) {
    const s = this.state;
    const be = this.beLevel();
    this.lastBE = be;

    if (be == null) { // no cost basis (recovered position without a BUY record) → classic trailing
      if (p <= s.anchorPrice - this._exitDelta(s.anchorPrice)) await this._act('SELL', p);
      return;
    }

    // 1) disaster stop — bounded catastrophe valve, checked on the RAW price
    if (cfg.DISASTER_STOP_PCT > 0 && s.entryPrice != null) {
      const dropPct = ((s.entryPrice - rawPrice) / s.entryPrice) * 100;
      if (dropPct >= cfg.DISASTER_STOP_PCT) {
        logger.warn(`DISASTER STOP: −${dropPct.toFixed(2)}% vs entry ${s.entryPrice.toFixed(2)} — cutting (the only loss breakeven mode realizes)`);
        await this._act('SELL', p, 'disaster');
        return;
      }
    }

    // 2) underwater — the peak has never reached break-even → HOLD, sell nothing
    if (s.anchorPrice < be) {
      const now = Date.now();
      if (now - this._lastBeLog > 300000) {
        this._lastBeLog = now;
        const hrs = s.entryAt ? ((now - new Date(s.entryAt).getTime()) / 3600000).toFixed(1) : '?';
        logger.note(`Underwater ${hrs}h: holding for break-even ${be.toFixed(2)} (price ${rawPrice.toFixed(2)}) — no loss exits in breakeven mode`);
      }
      return;
    }

    // 3) armed (peak ≥ BE): trail the peak, floored at break-even
    const trail = s.anchorPrice - this._exitDelta(s.anchorPrice);
    if (trail >= be && p <= trail) { await this._act('SELL', p); return; } // profit-take
    if (p <= be) await this._act('SELL', p, 'breakeven');                  // faded back → out at BE-or-better
  }

  // Volume confirmation gate for BUYS. Returns true if the buy is blocked (low volume
  // = likely fake breakout). Instant check (no chase) against the Binance volume MA.
  _volumeBlocksBuy() {
    if (!cfg.VOLUME_FILTER || !this.volume) return false;
    const v = this.volume.check(cfg.VOLUME_MULT);
    this.lastVolume = v;
    if (!v.active) { // warming up → don't gate yet
      const now = Date.now();
      if (now - this._lastVolLog > 60000) {
        this._lastVolLog = now;
        logger.note(`Volume filter warming up (${v.n}/${cfg.VOLUME_WINDOW} candles) — not gating yet`);
      }
      return false;
    }
    if (v.ok) return false; // enough volume behind the move → allow
    const now = Date.now();
    if (now - this._lastVolLog > 30000) {
      this._lastVolLog = now;
      logger.note(`Buy skipped: low volume ${v.recent.toFixed(0)} < ${cfg.VOLUME_MULT}× avg ${v.ma.toFixed(0)} ${cfg.VOLUME_SYMBOL.toUpperCase()}/${cfg.VOLUME_INTERVAL} — likely a fake breakout`);
    }
    return true;
  }

  // ATR volatility gate for BUYS. Block entries when the market is too quiet for a move
  // to clear the round-trip cost (anti-whipsaw). Returns true if the buy is blocked.
  _atrBlocksBuy() {
    if (!cfg.ATR_FILTER || !this.volume) return false;
    const a = this.volume.atr();
    this.lastAtr = a;
    if (!a.ready) return false;                     // warming up → don't gate yet
    if (a.atrPct >= cfg.ATR_MIN_PCT) return false;  // enough volatility → allow
    const now = Date.now();
    if (now - this._lastAtrLog > 300000) {          // 5-min throttle — the status line shows it live anyway
      this._lastAtrLog = now;
      logger.note(`ATR filter: volatility ${a.atrPct.toFixed(3)}% < min ${cfg.ATR_MIN_PCT}% — market too quiet, staying in cash`);
    }
    return true;
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
        if (this._atrBlocksBuy()) return;        // anti-whipsaw: skip dead / low-volatility chop
        if (this._trendBlocksBuy(price, trend)) return;
        if (this._volumeBlocksBuy()) return;     // false-breakout filter (volume confirmation)
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

      // BREAK-EVEN exit mode replaces protective exits + trailing below BE entirely.
      if (cfg.EXIT_MODE === 'breakeven') {
        await this._beExit(p, price);
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

    // Revert backoff: a reverted swap still pays full gas, so after an execution error
    // wait REVERT_BACKOFF_MS instead of re-firing every tick into the same fast market.
    if (Date.now() < this._revertUntil) {
      const now = Date.now();
      if (now - this._lastBackoffLog > 15000) {
        this._lastBackoffLog = now;
        logger.note(`Revert backoff: waiting ${Math.ceil((this._revertUntil - now) / 1000)}s before the next swap attempt`);
      }
      return;
    }
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
      // live 1m ATR (if available) lets execution widen the min-output in fast markets
      const a = this.volume ? this.volume.atr() : null;
      const atrPct = a && a.ready ? a.atrPct : null;
      const updated = await execution.execute(side, this.state, price, reason, atrPct);
      if (updated) this.state = updated;
      if (this.state && this.state.slippageHalt) {
        this.halted = true;
        logger.warn('TRADING HALTED after a bad fill (SLIPPAGE_HALT). Restart the bot to resume.');
      }
    } catch (e) {
      this._revertUntil = Date.now() + cfg.REVERT_BACKOFF_MS;
      logger.warn(`[engine] execution error (backing off ${Math.round(cfg.REVERT_BACKOFF_MS / 1000)}s): ` + (e.message || e).toString().slice(0, 300));
    } finally {
      await state.releaseLock();
      this.busy = false;
    }
  }
}

module.exports = StrategyEngine;
