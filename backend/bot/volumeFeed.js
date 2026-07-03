// bot/volumeFeed.js
// ─────────────────────────────────────────────────────────────────────────────
// Volume confirmation source for the breakout/false-breakout filter.
//
// The Uniswap pool (slot0) gives PRICE only — no volume. Binance leads ETH price
// discovery and its volume is the truest "is this move real?" signal, so we read a
// Binance kline (candlestick) WebSocket stream and track the per-candle base-asset
// volume. No RPC load (pure WebSocket) — safe after the Infura rate-limit issue.
//
// We keep the last (WINDOW+1) CLOSED-candle volumes and answer:
//   "is the latest closed candle's volume ≥ multiplier × the trailing volume MA?"
// A genuine breakout has volume behind it; a fake spike usually doesn't.
// ─────────────────────────────────────────────────────────────────────────────
const EventEmitter = require('events');
const WebSocket = require('ws');
const axios = require('axios');
const cfg = require('./config');

class VolumeFeed extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.stopped = false;
    this.reconnectDelay = 1000;
    this.maxReconnectDelay = 30000;
    this.closedVolumes = [];   // last (WINDOW+1) CLOSED-candle base volumes (ETH)
    this.currentVolume = null; // in-progress candle volume (display only)
    this.lastClosedTs = 0;
    this.closedCandles = [];   // last (ATR_PERIOD+1) CLOSED OHLC candles for ATR
  }

  start() {
    this.stopped = false;
    this._seed().catch(() => {}); // best-effort REST backfill so the filters are ready immediately (no warm-up)
    this._connect();
  }

  // Backfill the last N CLOSED candles from Binance REST so the volume + ATR filters
  // are active from the first tick instead of waiting ~WINDOW/PERIOD minutes to warm up.
  async _seed() {
    const limit = Math.max(cfg.VOLUME_WINDOW, cfg.ATR_PERIOD) + 2;
    const url = `https://api.binance.com/api/v3/klines?symbol=${cfg.VOLUME_SYMBOL.toUpperCase()}&interval=${cfg.VOLUME_INTERVAL}&limit=${limit}`;
    const r = await axios.get(url, { timeout: 8000 });
    const rows = Array.isArray(r.data) ? r.data : [];
    const closed = rows.slice(0, -1); // drop the in-progress (last) candle
    if (!closed.length) return;
    this.closedVolumes = closed.map((k) => parseFloat(k[5])).slice(-(cfg.VOLUME_WINDOW + 1));
    this.closedCandles = closed.map((k) => ({ h: parseFloat(k[2]), l: parseFloat(k[3]), c: parseFloat(k[4]) })).slice(-(cfg.ATR_PERIOD + 1));
    this.lastClosedTs = Date.now();
    console.log(`📊 [volume] REST-seeded ${closed.length} ${cfg.VOLUME_INTERVAL} candles — volume + ATR ready immediately`);
  }

  stop() {
    this.stopped = true;
    if (this.ws) { try { this.ws.terminate(); } catch (_) {} }
  }

  _connect() {
    const url = `wss://stream.binance.com:9443/ws/${cfg.VOLUME_SYMBOL}@kline_${cfg.VOLUME_INTERVAL}`;
    console.log('📊 [volume] connecting:', url);
    this.ws = new WebSocket(url);

    this.ws.on('open', () => { console.log('✅ [volume] kline stream open'); this.reconnectDelay = 1000; });

    this.ws.on('message', (raw) => {
      try {
        const k = JSON.parse(raw).k;
        if (!k) return;
        this.currentVolume = parseFloat(k.v); // in-progress candle volume
        if (k.x) {                              // candle CLOSED → record it
          this.closedVolumes.push(parseFloat(k.v));
          const max = cfg.VOLUME_WINDOW + 1;
          while (this.closedVolumes.length > max) this.closedVolumes.shift();
          // OHLC for ATR (high / low / close)
          this.closedCandles.push({ h: parseFloat(k.h), l: parseFloat(k.l), c: parseFloat(k.c) });
          const cmax = cfg.ATR_PERIOD + 1;
          while (this.closedCandles.length > cmax) this.closedCandles.shift();
          this.lastClosedTs = Date.now();
        }
      } catch (_) { /* ignore malformed frame */ }
    });

    this.ws.on('close', () => {
      if (this.stopped) return;
      console.warn(`⚠️ [volume] stream closed — reconnecting in ${this.reconnectDelay}ms`);
      setTimeout(() => this._connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
    });

    this.ws.on('error', (e) => { console.error('❌ [volume] ws error:', e.message); try { this.ws.close(); } catch (_) {} });
  }

  // Is there volume behind the move — ≥ multiplier × the trailing MA (baseline)?
  // SPIKE-AWARE: a sudden breakout's volume lands in the IN-PROGRESS candle first, so
  // we take max(latest closed, live candle). Only the closed-candle check would be one
  // candle late and block exactly the fast moves it exists to confirm. The live candle
  // is partial, so it can only help when activity is already genuinely above average.
  // Returns { active, ok, recent, ma, n }. active=false while warming up (don't gate).
  check(multiplier) {
    const n = this.closedVolumes.length;
    if (n < cfg.VOLUME_MIN_SAMPLES) return { active: false, ok: true, recent: this.currentVolume, ma: null, n };
    const recent = Math.max(this.closedVolumes[n - 1], this.currentVolume || 0);
    const prior = this.closedVolumes.slice(0, n - 1);   // baseline excludes the spike candle
    const ma = prior.reduce((s, v) => s + v, 0) / prior.length;
    const ok = ma > 0 ? recent >= multiplier * ma : true;
    return { active: true, ok, recent, ma, n };
  }

  // Average True Range over the last ATR_PERIOD CLOSED candles. True Range per candle
  // = max(high−low, |high−prevClose|, |low−prevClose|). Returns { ready, atr, atrPct, n }.
  // atrPct = ATR as a % of the latest close (volatility independent of price level).
  atr() {
    const c = this.closedCandles;
    const need = cfg.ATR_PERIOD + 1; // need a prior close for the first TR
    if (c.length < need) return { ready: false, atr: null, atrPct: null, n: c.length };
    let sum = 0;
    for (let i = 1; i < c.length; i++) {
      const prevClose = c[i - 1].c;
      const tr = Math.max(
        c[i].h - c[i].l,
        Math.abs(c[i].h - prevClose),
        Math.abs(c[i].l - prevClose)
      );
      sum += tr;
    }
    const atr = sum / (c.length - 1);
    const lastClose = c[c.length - 1].c;
    const atrPct = lastClose > 0 ? (atr / lastClose) * 100 : null;
    return { ready: true, atr, atrPct, n: c.length };
  }
}

module.exports = VolumeFeed;
