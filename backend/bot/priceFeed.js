// bot/priceFeed.js
// ─────────────────────────────────────────────────────────────────────────────
// Real-time price feed from Binance via WebSocket (replaces the 30s REST poll).
//   • Stream: <symbol>@bookTicker → uses mid price (best bid + best ask) / 2
//   • Auto-reconnect with exponential backoff
//   • Staleness watchdog: if no tick for MAX_PRICE_STALENESS_MS, emits 'stale',
//     does a REST heartbeat, and forces a reconnect. While stale the engine will
//     NOT trade (it checks isStale()).
// Emits: 'tick' {price, ts, source}, 'open', 'stale'
// ─────────────────────────────────────────────────────────────────────────────
const EventEmitter = require('events');
const WebSocket = require('ws');
const axios = require('axios');
const cfg = require('./config');

class PriceFeed extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.lastPrice = null;
    this.lastTickTs = 0;
    this.tickCount = 0; // total ticks received (liveness indicator)
    this.reconnectDelay = 1000;
    this.maxReconnectDelay = 30000;
    this.stopped = false;
    this.watchdog = null;
  }

  start() {
    this.stopped = false;
    this._connect();
    const interval = Math.max(2000, Math.floor(cfg.MAX_PRICE_STALENESS_MS / 2));
    this.watchdog = setInterval(() => this._checkStale(), interval);
  }

  stop() {
    this.stopped = true;
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.ws) { try { this.ws.terminate(); } catch (_) {} }
  }

  isStale() {
    return Date.now() - this.lastTickTs > cfg.MAX_PRICE_STALENESS_MS;
  }

  _connect() {
    const url = `wss://stream.binance.com:9443/ws/${cfg.WS_SYMBOL}@bookTicker`;
    console.log('🔌 [feed] connecting:', url);
    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      console.log('✅ [feed] websocket open');
      this.reconnectDelay = 1000; // reset backoff
      this.emit('open');
    });

    this.ws.on('message', (raw) => {
      try {
        const d = JSON.parse(raw);
        const bid = parseFloat(d.b);
        const ask = parseFloat(d.a);
        if (!bid || !ask) return;
        const price = (bid + ask) / 2;
        this.lastPrice = price;
        this.lastTickTs = Date.now();
        this.tickCount++;
        this.emit('tick', { price, ts: this.lastTickTs, source: 'ws' });
      } catch (_) { /* ignore malformed frame */ }
    });

    this.ws.on('close', () => {
      if (this.stopped) return;
      console.warn(`⚠️ [feed] socket closed — reconnecting in ${this.reconnectDelay}ms`);
      setTimeout(() => this._connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
    });

    this.ws.on('error', (e) => {
      console.error('❌ [feed] ws error:', e.message);
      try { this.ws.close(); } catch (_) {}
    });
  }

  async _checkStale() {
    if (this.stopped || !this.isStale()) return;

    // REST FALLBACK (not just a heartbeat): if the WebSocket is down, poll Binance's
    // REST price and EMIT it as a tick so the bot keeps running on REST data and
    // staleness clears. This is what stops the bot freezing when the WS won't connect.
    try {
      const url = `https://api.binance.com/api/v3/ticker/price?symbol=${cfg.REST_SYMBOL}`;
      const r = await axios.get(url, { timeout: 8000 });
      const p = parseFloat(r.data && r.data.price);
      if (p) {
        this.lastPrice = p;
        this.lastTickTs = Date.now();   // clears staleness → trading resumes
        this.tickCount++;
        this.emit('tick', { price: p, ts: this.lastTickTs, source: 'rest' });
        console.log(`ℹ️ [feed] REST fallback tick: ${p} (WS down — running on REST)`);
      }
    } catch (e) {
      console.error('❌ [feed] REST fallback failed (no connectivity?):', e.message);
      this.emit('stale'); // only TRULY stale when both WS and REST are down
    }

    // Nudge a reconnect ONLY if the socket is open-but-silent. NEVER terminate a
    // socket that is still CONNECTING — doing that caused the "closed before
    // connection established" loop that prevented it from ever connecting.
    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.terminate();
    } catch (_) {}
  }
}

module.exports = PriceFeed;
