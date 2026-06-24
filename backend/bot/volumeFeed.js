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
  }

  start() {
    this.stopped = false;
    this._connect();
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
