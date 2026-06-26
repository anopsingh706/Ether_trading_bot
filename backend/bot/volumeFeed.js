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
    // Closed-candle OHLC for Wilder ATR (volatility) — same kline stream, no extra WS.
    this.closedHighs = [];
    this.closedLows = [];
    this.closedCloses = [];
    this.maxBars = Math.max(cfg.VOLUME_WINDOW + 1, cfg.ATR_PERIOD * 4 + 1); // keep enough for a stable ATR
    this.lastClosedTs = 0;
  }

  async start() {
    this.stopped = false;
    await this.seed();   // prefill closed-candle history from REST → filter active immediately
    this._connect();
  }

  // Prefill closed-candle volumes from Binance REST so the filter isn't blind for the
  // first VOLUME_MIN_SAMPLES candles after a restart (at 5m that was a 25-min window with
  // NO volume protection — exactly the gap that let an unconfirmed buy through).
  async seed() {
    try {
      const sym = cfg.VOLUME_SYMBOL.toUpperCase();
      const limit = Math.max(cfg.VOLUME_WINDOW + 1, cfg.ATR_PERIOD * 4 + 1);
      const url = `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${cfg.VOLUME_INTERVAL}&limit=${limit}`;
      const r = await axios.get(url, { timeout: 8000 });
      const rows = r.data || []; // kline: [openTime, o, h, l, c, v, ...]
      if (rows.length) {
        this.currentVolume = parseFloat(rows[rows.length - 1][5]); // in-progress candle (display)
        const closed = rows.slice(0, -1);                          // drop the in-progress candle
        this.closedVolumes = closed.map((k) => parseFloat(k[5])).slice(-(cfg.VOLUME_WINDOW + 1));
        this.closedHighs   = closed.map((k) => parseFloat(k[2])).slice(-this.maxBars);
        this.closedLows    = closed.map((k) => parseFloat(k[3])).slice(-this.maxBars);
        this.closedCloses  = closed.map((k) => parseFloat(k[4])).slice(-this.maxBars);
      }
      const a = this.atr();
      console.log(`📊 [volume] seeded ${this.closedVolumes.length} vol + ${this.closedCloses.length} OHLC ${cfg.VOLUME_INTERVAL} candles from REST — filters active immediately${a ? ` (ATR $${a.toFixed(2)})` : ''}`);
    } catch (e) {
      console.warn('⚠️ [volume] REST seed failed (will warm up live instead):', e.message);
    }
  }

  // Wilder ATR(period) over the closed-candle OHLC ($). Returns null until enough candles.
  atr(period = cfg.ATR_PERIOD) {
    const H = this.closedHighs, L = this.closedLows, C = this.closedCloses;
    const n = C.length;
    if (n < period + 1) return null;
    const TR = [];
    for (let i = 1; i < n; i++) {
      TR.push(Math.max(H[i] - L[i], Math.abs(H[i] - C[i - 1]), Math.abs(L[i] - C[i - 1])));
    }
    let atr = 0;
    for (let i = 0; i < period; i++) atr += TR[i];   // seed = simple avg of first `period` TRs
    atr /= period;
    for (let i = period; i < TR.length; i++) atr = (atr * (period - 1) + TR[i]) / period; // Wilder smooth
    return atr;
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
          while (this.closedVolumes.length > cfg.VOLUME_WINDOW + 1) this.closedVolumes.shift();
          this.closedHighs.push(parseFloat(k.h));
          this.closedLows.push(parseFloat(k.l));
          this.closedCloses.push(parseFloat(k.c));
          while (this.closedCloses.length > this.maxBars) { this.closedHighs.shift(); this.closedLows.shift(); this.closedCloses.shift(); }
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

  // Is the latest closed candle's volume ≥ multiplier × the trailing MA (baseline)?
  // Returns { active, ok, recent, ma, n }. active=false while warming up (don't gate).
  check(multiplier) {
    const n = this.closedVolumes.length;
    if (n < cfg.VOLUME_MIN_SAMPLES) return { active: false, ok: true, recent: this.currentVolume, ma: null, n };
    const recent = this.closedVolumes[n - 1];
    const prior = this.closedVolumes.slice(0, n - 1);   // baseline excludes the spike candle
    const ma = prior.reduce((s, v) => s + v, 0) / prior.length;
    const ok = ma > 0 ? recent >= multiplier * ma : true;
    return { active: true, ok, recent, ma, n };
  }
}

module.exports = VolumeFeed;
