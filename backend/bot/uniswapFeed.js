// bot/uniswapFeed.js
// ─────────────────────────────────────────────────────────────────────────────
// Real-time price from the SAME v3 pool we will trade against (Uniswap / PancakeSwap).
// A DEX can't push to us, but the pool emits a Swap event (carrying the NEW
// sqrtPriceX96) on every trade — the only thing that moves the price. So:
//   • PRIMARY (websocket):  eth_subscribe to the pool's Swap logs (free public node,
//     cfg.RPC_WSS) and take the price straight from each event — zero RPC reads.
//     Events are coalesced to ≤1 tick per SWAP_MIN_EMIT_MS (latest price wins).
//     Reconnects with backoff on close/error, or after WSS_SILENT_MS without events.
//   • SAFETY NET (HTTPS):  read slot0 every BLOCK_POLL_MS through the failover RPC
//     list (bot/rpc.js) — skipped while Swap events are flowing, so it costs
//     nothing normally and keeps the feed alive if the websocket drops.
// Emits the SAME interface as priceFeed.js: 'tick' {price, ts, source}, plus
// lastPrice / lastTickTs / tickCount / isStale() / start() / stop().
// ─────────────────────────────────────────────────────────────────────────────
const EventEmitter = require('events');
const WebSocket = require('ws');
const { ethers } = require('ethers');
const axios = require('axios');
const cfg = require('./config');
const logger = require('./logger');
const rpc = require('./rpc');

const FACTORY_ABI = ['function getPool(address,address,uint24) view returns (address)'];
const POOL_ABI = [
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint32 feeProtocol, bool unlocked)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function liquidity() view returns (uint128)',
];

class UniswapFeed extends EventEmitter {
  constructor() {
    super();
    this.http = rpc.provider({ log: (...a) => logger.line(...a) });
    this.ws = null;
    this._wsDelay = 1000;       // reconnect backoff
    this._wsOpenedAt = 0;
    this._lastSwapAt = 0;       // last Swap event received (liveness of the websocket)
    this._lastSwap = null;      // {blk, idx} of the newest event applied (ignores out-of-order logs)
    this._pendingPrice = null;  // coalesced price waiting to be emitted
    this._emitTimer = null;
    this._silenceTimer = null;
    this.pool = null;
    this.poolFee = null;
    this.wethIsToken0 = false;
    this.lastPrice = null;
    this.lastTickTs = 0;
    this.tickCount = 0;
    this.stopped = false;
    this.pollTimer = null;
    this._lastReadAt = 0; // throttle pool reads to cap RPC (Infura) load
  }

  isStale() { return Date.now() - this.lastTickTs > cfg.MAX_PRICE_STALENESS_MS; }

  // USDC per WETH from sqrtPriceX96, accounting for token ordering + decimals (18/6).
  _priceFromSqrt(sqrtPriceX96) {
    const r = Number(sqrtPriceX96) / 2 ** 96;   // = sqrt(P_raw)
    const pRaw = r * r;                           // token1_raw per token0_raw
    const f = 10 ** (cfg.WETH_DECIMALS - cfg.USDT_DECIMALS); // 1e12
    // WETH token0: pRaw = USDC_raw/WETH_raw → USDC/WETH = pRaw * f
    // WETH token1: pRaw = WETH_raw/USDC_raw → USDC/WETH = f / pRaw
    return this.wethIsToken0 ? pRaw * f : f / pRaw;
  }

  async _resolvePool() {
    // Resolve ONLY the configured fee tier so the price feed and the executor
    // (dex.js, which uses cfg.POOL_FEE) are ALWAYS on the same pool. No silent
    // fallback to another tier — that would price on one pool and trade on another.
    const factory = new ethers.Contract(cfg.UNISWAP_V3_FACTORY, FACTORY_ABI, this.http);
    const fee = cfg.POOL_FEE;
    const addr = await factory.getPool(cfg.WETH_ADDRESS, cfg.USDC_ADDRESS, fee);
    if (!addr || addr === ethers.ZeroAddress) {
      throw new Error(`No ${cfg.DEX_NAME} WETH/${cfg.USDC_SYMBOL} pool on ${cfg.CHAIN_NAME} at fee ${fee} (set the pool-fee env to a tier that exists)`);
    }
    const pool = new ethers.Contract(addr, POOL_ABI, this.http);
    let liq = 0n;
    try { liq = await pool.liquidity(); } catch {}
    this.pool = pool;
    this.poolFee = fee;
    const t0 = (await pool.token0()).toLowerCase();
    this.wethIsToken0 = t0 === cfg.WETH_ADDRESS.toLowerCase();
    console.log(`🦄 [${cfg.DEX_NAME} ${cfg.CHAIN_NAME}] pool ${addr} (fee ${fee}, WETH = token${this.wethIsToken0 ? '0' : '1'}, liquidity ${liq.toString()})`);
    if (liq === 0n) console.warn(`⚠️ [${cfg.DEX_NAME} ${cfg.CHAIN_NAME}] pool liquidity reads 0 — check the pool-fee setting`);
  }

  async _readPrice(source) {
    if (this.stopped || !this.pool) return;
    // Throttle: WSS block + HTTP poll can both fire — cap the actual RPC reads so we
    // don't blow the Infura rate/quota. 'init' always reads (startup price).
    const now = Date.now();
    if (source !== 'init' && now - this._lastReadAt < cfg.FEED_MIN_READ_MS) return;
    this._lastReadAt = now;
    try {
      const s = await this.pool.slot0();
      this._emitPrice(this._priceFromSqrt(s.sqrtPriceX96), source);
    } catch (e) {
      // swallow — staleness watchdog in the engine pauses trading if reads keep failing
    }
  }

  _emitPrice(price, source) {
    if (!(price > 0 && isFinite(price))) return;
    this.lastPrice = price;
    this.lastTickTs = Date.now();
    this.tickCount++;
    this.emit('tick', { price, ts: this.lastTickTs, source });
  }

  // Safety-net poll: only reads the pool when Swap events have NOT kept the price fresh.
  _poll() {
    if (Date.now() - this._lastSwapAt < cfg.BLOCK_POLL_MS) return;
    this._readPrice('poll');
  }

  async start() {
    this.stopped = false;
    await this._resolvePool();
    await this._readPrice('init');

    // Sanity check: confirm our on-chain price ≈ Binance (catches any decimal mistake).
    try {
      const b = await axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${cfg.REST_SYMBOL}`, { timeout: 8000 });
      const bp = parseFloat(b.data && b.data.price);
      const diff = this.lastPrice && bp ? ((this.lastPrice - bp) / bp) * 100 : null;
      console.log(`🔎 [pool] sanity: ${cfg.DEX_NAME} ${this.lastPrice ? this.lastPrice.toFixed(2) : '—'} vs Binance ${bp ? bp.toFixed(2) : '—'} (${diff != null ? diff.toFixed(3) : '—'}% diff)`);
    } catch (_) {}

    // SAFETY NET: HTTPS polling (failover RPC list) so the feed can never get stuck.
    this.pollTimer = setInterval(() => this._poll(), cfg.BLOCK_POLL_MS);

    // PRIMARY: Swap-event websocket for real-time updates (best-effort).
    if (cfg.USE_WSS && cfg.RPC_WSS && cfg.SWAP_TOPIC) {
      this._connectWs();
      this._silenceTimer = setInterval(() => this._checkSilence(), Math.min(cfg.WSS_SILENT_MS, 30000));
    }
  }

  _connectWs() {
    if (this.stopped) return;
    const tag = `[${cfg.DEX_NAME} ${cfg.CHAIN_NAME} ws]`;
    const ws = new WebSocket(cfg.RPC_WSS, { handshakeTimeout: 15000 });
    this.ws = ws;
    this._wsOpenedAt = 0;

    ws.on('open', () => {
      this._wsOpenedAt = Date.now();
      ws.send(JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'eth_subscribe',
        params: ['logs', { address: this.pool.target, topics: [cfg.SWAP_TOPIC] }],
      }));
    });

    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      if (m.id === 1) {
        if (m.error) { logger.line(`⚠️ ${tag} subscribe refused: ${m.error.message} — polling only until reconnect`); ws.terminate(); return; }
        this._wsDelay = 1000;
        this._lastSwapAt = Date.now(); // count the subscription itself as alive
        logger.line(`🔌 ${tag} Swap-event subscription active (${rpc.label(cfg.RPC_WSS)}) — price pushed on every trade`);
        return;
      }
      const log = m.params && m.params.result;
      if (log && log.data) this._onSwapLog(log);
    });

    ws.on('close', () => {
      if (this.ws !== ws) return;    // an older socket we already replaced
      this.ws = null;
      if (this.stopped) return;
      logger.line(`⚠️ ${tag} closed — polling continues, reconnecting in ${Math.round(this._wsDelay / 1000)}s`);
      setTimeout(() => this._connectWs(), this._wsDelay);
      this._wsDelay = Math.min(this._wsDelay * 2, 60000);
    });

    ws.on('error', (e) => {
      logger.line(`⚠️ ${tag} error: ${e.message}`);
      try { ws.terminate(); } catch (_) {}
    });
  }

  _onSwapLog(log) {
    if (log.removed || !log.topics || log.topics[0] !== cfg.SWAP_TOPIC) return;
    // ignore events older than one already applied (logs can arrive slightly out of order)
    const blk = parseInt(log.blockNumber, 16), idx = parseInt(log.logIndex, 16);
    if (this._lastSwap && (blk < this._lastSwap.blk || (blk === this._lastSwap.blk && idx <= this._lastSwap.idx))) return;
    this._lastSwap = { blk, idx };
    this._lastSwapAt = Date.now();

    // data words: amount0, amount1, sqrtPriceX96, liquidity, tick, … → sqrtPriceX96 is word #2
    this._pendingPrice = this._priceFromSqrt(BigInt('0x' + log.data.slice(2 + 64 * 2, 2 + 64 * 3)));

    // coalesce bursts: emit now if the last tick is old enough, else when the window ends
    if (this._emitTimer) return;
    const wait = Math.max(0, cfg.SWAP_MIN_EMIT_MS - (Date.now() - this.lastTickTs));
    this._emitTimer = setTimeout(() => {
      this._emitTimer = null;
      if (this.stopped || this._pendingPrice == null) return;
      const p = this._pendingPrice;
      this._pendingPrice = null;
      this._emitPrice(p, 'swap');
    }, wait);
  }

  // A socket can stay "open" but stop delivering (silent drop) → force a reconnect.
  _checkSilence() {
    if (this.stopped || !this.ws || !this._wsOpenedAt) return;
    if (Date.now() - Math.max(this._lastSwapAt, this._wsOpenedAt) < cfg.WSS_SILENT_MS) return;
    logger.line(`⚠️ [${cfg.DEX_NAME} ${cfg.CHAIN_NAME} ws] no Swap events for ${Math.round(cfg.WSS_SILENT_MS / 1000)}s — reconnecting`);
    try { this.ws.terminate(); } catch (_) {}
  }

  stop() {
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this._silenceTimer) clearInterval(this._silenceTimer);
    if (this._emitTimer) clearTimeout(this._emitTimer);
    if (this.ws) { try { this.ws.terminate(); } catch (_) {} }
  }
}

module.exports = UniswapFeed;
