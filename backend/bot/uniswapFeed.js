// bot/uniswapFeed.js
// ─────────────────────────────────────────────────────────────────────────────
// Real-time price from the SAME Uniswap v3 pool we will trade against (Polygon).
// Uniswap has no native price websocket, so:
//   • PRIMARY (websocket):  connect to a Polygon node over WSS and read the pool's
//     slot0 price on every new block (~2s push) — true real-time, on-chain price.
//   • BASELINE (reliable):  also poll slot0 over HTTPS every BLOCK_POLL_MS so the
//     feed never gets stuck if the websocket drops (same resilience as the Binance feed).
// Emits the SAME interface as priceFeed.js: 'tick' {price, ts, source}, plus
// lastPrice / lastTickTs / tickCount / isStale() / start() / stop().
// ─────────────────────────────────────────────────────────────────────────────
const EventEmitter = require('events');
const { ethers } = require('ethers');
const axios = require('axios');
const cfg = require('./config');
const logger = require('./logger');

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
    this.http = new ethers.JsonRpcProvider(cfg.RPC_HTTP, cfg.CHAIN_ID, { staticNetwork: true });
    this.wsProvider = null;
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
    if (liq === 0n) console.warn('⚠️ [uniswap] pool liquidity reads 0 — check BOT_POOL_FEE');
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
      const price = this._priceFromSqrt(s.sqrtPriceX96);
      if (price > 0 && isFinite(price)) {
        this.lastPrice = price;
        this.lastTickTs = Date.now();
        this.tickCount++;
        this.emit('tick', { price, ts: this.lastTickTs, source });
      }
    } catch (e) {
      // swallow — staleness watchdog in the engine pauses trading if reads keep failing
    }
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

    // BASELINE: reliable HTTPS polling so the feed can never get stuck.
    this.pollTimer = setInterval(() => this._readPrice('poll'), cfg.BLOCK_POLL_MS);

    // PRIMARY: websocket block subscription for real-time updates (best-effort).
    if (cfg.USE_WSS && cfg.RPC_WSS) this._connectWs();
  }

  _connectWs() {
    try {
      this.wsProvider = new ethers.WebSocketProvider(cfg.RPC_WSS);
      this.wsProvider.on('block', () => this._readPrice('block'));
      this.wsProvider.on('error', (e) => logger.line('⚠️ [uniswap-ws] error (polling continues):', e.message));
      console.log('🔌 [uniswap] websocket block subscription active (real-time)');
    } catch (e) {
      console.warn('⚠️ [uniswap] websocket unavailable, using polling only:', e.message);
    }
  }

  stop() {
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.wsProvider) { try { this.wsProvider.destroy(); } catch (_) {} }
  }
}

module.exports = UniswapFeed;
