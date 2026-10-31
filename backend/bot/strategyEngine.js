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
const circuitBreaker = require('./circuitBreaker');

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
    this._lastRsiLog = 0;
    this.lastRsi = null;     // last RSI check (exposed for the status line)
    this._revertUntil = 0;   // gas-burn guard: no swap attempts until this time after an execution error
    this._lastBackoffLog = 0;
    this._lastBeLog = 0;
    this.lastBE = null;      // current break-even level (exposed for the status line)
    this._uwLow = null;      // Layer 2: drawdown low since entry/last swing (in-memory)
    this._uwPeak = null;     // Layer 2: rebound peak since the low (in-memory)
    this._regimeSince = null; // 'regime' exit: when the current underwater downtrend began
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
  //
  // ATR-adaptive mode (BOT_ATR_ENTRY_MULT/BOT_ATR_EXIT_MULT > 0): once ATR is warm, the
  // trigger Δ = ATR × mult — this REPLACES the fixed threshold (not just a floor), so a
  // calm market gets a smaller trigger and a wild market gets a bigger one. The fixed
  // BOT_ENTRY_THRESHOLD/BOT_EXIT_THRESHOLD only apply as a fallback while ATR warms up.
  _entryDelta(anchor) {
    let d = cfg.THRESHOLD_MODE === 'percent' ? (anchor * cfg.ENTRY_THRESHOLD) / 100 : cfg.ENTRY_THRESHOLD;
    if (cfg.ATR_ENTRY_MULT > 0 && this.volume) {
      const a = this.volume.atr();
      if (a.ready) d = a.atr * cfg.ATR_ENTRY_MULT;
    }
    return d;
  }
  _exitDelta(anchor) {
    let d = cfg.THRESHOLD_MODE === 'percent' ? (anchor * cfg.EXIT_THRESHOLD) / 100 : cfg.EXIT_THRESHOLD;
    if (cfg.ATR_EXIT_MULT > 0 && this.volume) {
      const a = this.volume.atr();
      if (a.ready) d = a.atr * cfg.ATR_EXIT_MULT;
    }
    return d;
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

  // 'breakeven' exit mode: NEVER sell below the BE floor — hold underwater until price
  // recovers (no small red exits). Above the floor, trail the peak with the floor as a
  // hard minimum. The ONLY losses this mode realizes: the deep disaster stop, and (with
  // Layer 1) micro-losses within the ε-band. Layer 2 (optional) swing-repairs deep
  // drawdowns so the floor itself ratchets down.
  async _beExit(p, rawPrice, trend) {
    const s = this.state;
    const be = this.beLevel();
    this.lastBE = be;

    if (be == null) { // no cost basis (recovered position without a BUY record) → classic trailing
      if (p <= s.anchorPrice - this._exitDelta(s.anchorPrice)) await this._act('SELL', p);
      return;
    }

    // Layer 1: ε-tolerance — exits allowed at ≥ BE×(1−ε), so a rebound that misses BE
    // by cents still banks (worst case ≈ −$0.01–0.02) instead of riding a drawdown.
    const floor = be * (1 - cfg.BE_TOLERANCE_PCT / 100);

    // 1) disaster stop — bounded catastrophe valve, checked on the RAW price vs the
    //    ORIGINAL campaign entry (swing-repairs don't move it).
    if (cfg.DISASTER_STOP_PCT > 0 && s.entryPrice != null) {
      const dropPct = ((s.entryPrice - rawPrice) / s.entryPrice) * 100;
      if (dropPct >= cfg.DISASTER_STOP_PCT) {
        logger.warn(`DISASTER STOP: −${dropPct.toFixed(2)}% vs entry ${s.entryPrice.toFixed(2)} — cutting (the only large loss breakeven mode realizes)`);
        await this._act('SELL', p, 'disaster');
        return;
      }
    }

    // 2) armed (peak ≥ floor): trail the peak, floored at BE−ε
    if (s.anchorPrice >= floor) {
      const trail = s.anchorPrice - this._exitDelta(s.anchorPrice);
      if (trail >= floor && p <= trail) { await this._act('SELL', p); return; } // profit-take
      if (p <= floor) await this._act('SELL', p, 'breakeven');                  // faded → out at ≈BE
      return;
    }

    // 3) underwater — 'instant' / 'timestop' / 'regime' cut here; 'breakeven' holds.
    if (cfg.EXIT_MODE !== 'breakeven') {
      const cut = this._underwaterCut(rawPrice, trend);
      if (cut) {
        logger.note(`Underwater cut (${cut.tag}): ${cut.detail} — selling`);
        await this._act('SELL', p, cut.tag);
      }
      return;
    }

    // 'breakeven' — HOLD (no loss exits)…
    // Layer 2 (optional, ⚠️ backtest net-negative): in a DEEP drawdown, sell a big
    // rebound that reverses, to re-buy the next dip → more ETH on the same basis →
    // beLevel() ratchets down. Gated hard: min-drop, wide deltas, cooldown, cycle cap.
    if (cfg.UW_SWING && !cfg.SIM_MODE) {
      if (this._uwLow == null || rawPrice < this._uwLow) {
        this._uwLow = rawPrice; this._uwPeak = null;        // new low voids the old rebound
      } else if (this._uwLow <= be * (1 - cfg.UW_MIN_DROP_PCT / 100)
                 && (s.swingCount || 0) < cfg.SW_MAX
                 && (!s.lastSwingAt || Date.now() - new Date(s.lastSwingAt).getTime() >= cfg.SW_COOL_MS)) {
        if (this._uwPeak == null || rawPrice > this._uwPeak) this._uwPeak = rawPrice;
        else if (this._uwPeak >= this._uwLow + cfg.SW_REB && rawPrice <= this._uwPeak - cfg.SW_REV) {
          logger.note(`Swing-sell: rebound ${this._uwLow.toFixed(2)}→${this._uwPeak.toFixed(2)} reversed to ${rawPrice.toFixed(2)} — selling to re-buy lower (BE ${be.toFixed(2)})`);
          await this._act('SELL', p, 'swing-sell');
          return;
        }
      }
    }

    const now = Date.now();
    if (now - this._lastBeLog > 300000) {
      this._lastBeLog = now;
      const hrs = s.entryAt ? ((now - new Date(s.entryAt).getTime()) / 3600000).toFixed(1) : '?';
      logger.note(`Underwater ${hrs}h: holding for break-even ${be.toFixed(2)} (price ${rawPrice.toFixed(2)}) — no loss exits in breakeven mode`);
    }
  }

  // Underwater-cut rule for 'instant' / 'timestop' / 'regime'. "Underwater" = raw price
  // below the realized entry price (what we actually paid per ETH). Returns {tag, detail}
  // or null (keep holding).
  _underwaterCut(rawPrice, trend) {
    const s = this.state;
    if (s.entryPrice == null || rawPrice >= s.entryPrice) { this._regimeSince = null; return null; }
    const lossPct = ((s.entryPrice - rawPrice) / s.entryPrice) * 100;
    const where = `price ${rawPrice.toFixed(2)} < entry ${s.entryPrice.toFixed(2)} (−${lossPct.toFixed(2)}%)`;

    if (cfg.EXIT_MODE === 'instant') return { tag: 'instant-cut', detail: where };

    if (cfg.EXIT_MODE === 'timestop') {
      const hrs = s.entryAt ? (Date.now() - new Date(s.entryAt).getTime()) / 3600000 : 0;
      if (hrs >= cfg.TIME_STOP_H) return { tag: 'time-stop', detail: `${where}, held ${hrs.toFixed(1)}h ≥ ${cfg.TIME_STOP_H}h` };
      this._underwaterLog(`Underwater ${hrs.toFixed(1)}h: ${where} — time stop at ${cfg.TIME_STOP_H}h`);
      return null;
    }

    // 'regime': the trend must be down continuously for REGIME_CONFIRM_MS
    if (trend.ready && !trend.up) {
      if (this._regimeSince == null) this._regimeSince = Date.now();
      const downMs = Date.now() - this._regimeSince;
      if (downMs >= cfg.REGIME_CONFIRM_MS) {
        return { tag: 'regime', detail: `${where}, below MA ${trend.ma.toFixed(2)} for ${Math.round(downMs / 1000)}s` };
      }
    } else {
      this._regimeSince = null;
    }
    this._underwaterLog(`Underwater: ${where} — holding while the trend is not confirmed down`);
    return null;
  }

  _underwaterLog(msg) {
    const now = Date.now();
    if (now - this._lastBeLog > 300000) { this._lastBeLog = now; logger.note(msg); }
  }

  // Layer 2 sub-state: IN_SWING — campaign open, holding cash after a swing-sell.
  // Re-buy on a rebound off the swing low, or on the failsafe (price broke back above
  // the swing-sell by SW_REV → the dip thesis is dead; re-buy to cap basis damage).
  async _swingRebuy(p, rawPrice) {
    const s = this.state;
    // track the swing low on the trailing anchor (persisted like the IN_USDT trough)
    if (s.anchorPrice == null || p < s.anchorPrice) {
      s.anchorPrice = p;
      s.anchorUpdatedAt = new Date();
      await state.persistAnchor(s);
      return;
    }
    if (s.swingSellPrice != null && rawPrice >= s.swingSellPrice + cfg.SW_REV) {
      logger.note(`Swing failsafe: price ${rawPrice.toFixed(2)} broke above swing-sell ${s.swingSellPrice.toFixed(2)}+$${cfg.SW_REV} — re-buying now to cap basis damage`);
      await this._act('BUY', p, 'swing-buy-failsafe');
      return;
    }
    if (p >= s.anchorPrice + this._entryDelta(s.anchorPrice)) {
      // NOTE: entry gates (volume/trend/ATR) intentionally NOT applied — this is
      // position management inside an open campaign, not a fresh entry.
      await this._act('BUY', p, 'swing-buy');
    }
  }

  // Circuit-breaker gate for BUYS (an expired daily trip is cleared and persisted here).
  _cbBlocksBuy() {
    const wasTripped = !!this.state.cbTripped;
    const blocked = circuitBreaker.blocksBuy(this.state);
    if (wasTripped && !blocked) state.saveAfterTrade(this.state).catch(() => {});
    if (blocked) {
      const now = Date.now();
      if (now - (this._lastCbLog || 0) > 600000) {
        this._lastCbLog = now;
        logger.note(`Buy skipped: circuit breaker tripped (${this.state.cbReason}) — ${this.state.cbDetail}`);
      }
    }
    return blocked;
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

  // RSI momentum-confirmation gate for BUYS. Confirms the dip the entry trigger reacted
  // to was a genuine oversold move (RSI low → recently sold off hard) rather than a
  // random tick already back near/above neutral. Returns true if the buy is blocked.
  _rsiBlocksBuy() {
    if (!cfg.RSI_FILTER || !this.volume) return false;
    const r = this.volume.rsi();
    this.lastRsi = r;
    if (!r.ready) return false;                      // warming up → don't gate yet
    if (r.rsi <= cfg.RSI_MAX_ENTRY) return false;    // genuinely oversold → allow
    const now = Date.now();
    if (now - this._lastRsiLog > 30000) {
      this._lastRsiLog = now;
      logger.note(`Buy skipped: RSI ${r.rsi.toFixed(1)} > ${cfg.RSI_MAX_ENTRY} — bounce isn't from an oversold dip, likely noise`);
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
        if (this.isPaused && this.isPaused()) return; // paused from the dashboard → no new entries
        if (this._cbBlocksBuy()) return;         // circuit breaker: repeated losses → no new entries
        if (this._atrBlocksBuy()) return;        // anti-whipsaw: skip dead / low-volatility chop
        if (this._rsiBlocksBuy()) return;        // momentum confirmation: was this really an oversold dip?
        if (this._trendBlocksBuy(price, trend)) return;
        if (this._volumeBlocksBuy()) return;     // false-breakout filter (volume confirmation)
        await this._act('BUY', p);
      } else if (this._pendingEntry) {
        // Fell back below the trigger before confirming → it was a fake spike.
        logger.note(`Fake spike rejected: fell to ${p.toFixed(2)} below trigger ${this._pendingEntry.level.toFixed(2)} before confirming — staying in cash`);
        this._pendingEntry = null;
      }
    } else if (s.position === 'IN_SWING') {
      // Layer 2 sub-state: waiting to re-buy after a swing-sell (campaign open).
      await this._swingRebuy(p, price);
    } else {
      // IN_WETH: track the peak (new high) on the SMOOTHED price.
      if (s.anchorPrice == null || p > s.anchorPrice) {
        s.anchorPrice = p;
        s.anchorUpdatedAt = new Date();
        await state.persistAnchor(s);
        return;
      }

      // BREAK-EVEN family (breakeven/instant/timestop/regime) replaces protective exits
      // + trailing below BE entirely.
      if (cfg.FLOOR_EXIT_MODES.includes(cfg.EXIT_MODE)) {
        await this._beExit(p, price, trend);
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

  // Dashboard emergency sell: exit the whole open position now, through the normal
  // execution path (lock, slippage protection, escalating exit retries).
  async manualSell(price) {
    if (!this.state || this.state.position !== 'IN_WETH') return false;
    await this._act('SELL', price || this.state.anchorPrice, 'manual-sell');
    return this.state.position !== 'IN_WETH';
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
    // A DB outage here must NOT leave busy=true — that silently froze the engine (every
    // later tick returned early) after a Mongo disconnect. Retry shortly instead.
    let locked;
    try {
      locked = await state.acquireLock();
    } catch (e) {
      this.busy = false;
      this._revertUntil = Date.now() + 10000; // no swap was sent → short pause, not the 60s gas backoff
      logger.warn(`[engine] trade lock unavailable (DB: ${(e.message || e).toString().slice(0, 120)}) — skipping, retry in 10s`);
      return;
    }
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
      if (updated) {
        this.state = updated;
        this._uwLow = null; this._uwPeak = null; this._regimeSince = null; // position changed → fresh drawdown trackers
      }
      if (this.state && this.state.slippageHalt) {
        this.halted = true;
        logger.warn('TRADING HALTED after a bad fill (SLIPPAGE_HALT). Restart the bot to resume.');
      }
    } catch (e) {
      this._revertUntil = Date.now() + cfg.REVERT_BACKOFF_MS;
      this.lastError = { at: new Date(), side, msg: (e.message || e).toString().slice(0, 200) }; // shown on the dashboard
      logger.warn(`[engine] execution error (backing off ${Math.round(cfg.REVERT_BACKOFF_MS / 1000)}s): ` + (e.message || e).toString().slice(0, 300));
    } finally {
      // the lock self-expires after 2 min, so a failed release is safe to just log
      await state.releaseLock().catch((e) => logger.warn('[engine] lock release failed (expires in 2 min): ' + (e.message || e).toString().slice(0, 120)));
      this.busy = false;
    }
  }
}

module.exports = StrategyEngine;
