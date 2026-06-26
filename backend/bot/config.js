// bot/config.js
// ─────────────────────────────────────────────────────────────────────────────
// Central configuration for the NEW trading engine (trailing 0.05 strategy).
// Everything is env-overridable so we never hard-code behaviour.
//
// SAFETY NOTE:
//   • This bot trades REAL funds on EVERY run — dry-run/paper mode was removed.
//     The wallet in .env is live; watch for the LIVE banner on startup.
//   • The bot uses its OWN database (derived from DB_URL by swapping the db name
//     to `jan25au_botsim`). Override with BOT_DB_URL.
// ─────────────────────────────────────────────────────────────────────────────
require('dotenv').config();

const num = (v, d) => (v !== undefined && v !== '' && !isNaN(Number(v)) ? Number(v) : d);
const bool = (v, d) => (v === undefined || v === '' ? d : String(v).toLowerCase() === 'true');
const trim = (v) => (typeof v === 'string' ? v.trim() : v);

// Derive a sandbox DB URL from the production DB_URL by replacing the db name.
// e.g.  mongodb+srv://.../jan25au_prod   →   mongodb+srv://.../jan25au_botsim
function deriveBotDbUrl() {
  if (process.env.BOT_DB_URL) return process.env.BOT_DB_URL.trim();
  const base = trim(process.env.DB_URL) || '';
  return base.replace(/\/([^/?]+)(\?|$)/, '/jan25au_botsim$2');
}

// Derive a WSS RPC url from the HTTPS one (Infura): https://…/v3/KEY → wss://…/ws/v3/KEY
function deriveWss() {
  if (process.env.POLYGON_WSS_URL) return process.env.POLYGON_WSS_URL.trim();
  const http = trim(process.env.POLYGON_RPC_URL) || '';
  if (!http.startsWith('https://')) return null;
  return http.replace(/^https:\/\//, 'wss://').replace('/v3/', '/ws/v3/');
}

module.exports = {
  // ── Mode ────────────────────────────────────────────────────────────────────
  BOT_DB_URL: deriveBotDbUrl(),

  // ── Price feed (Binance WebSocket) ───────────────────────────────────────────
  WS_SYMBOL:   (process.env.BOT_WS_SYMBOL || 'ethusdt').toLowerCase(),  // ws stream
  REST_SYMBOL: process.env.CRYPTO_ID || 'ETHUSDT',                      // REST fallback
  MAX_PRICE_STALENESS_MS: num(process.env.BOT_MAX_STALENESS_MS, 10000), // pause if no tick

  // ── Strategy ─────────────────────────────────────────────────────────────────
  THRESHOLD:       num(process.env.BOT_THRESHOLD, 0.05),               // legacy single Δ (fallback)
  THRESHOLD_MODE:  (process.env.BOT_THRESHOLD_MODE || 'absolute'),     // 'absolute' | 'percent' | 'atr'
  TRADE_SIZE_MODE: (process.env.BOT_TRADE_SIZE_MODE || 'all'),         // 'all' (100%)
  COOLDOWN_MS:     num(process.env.BOT_COOLDOWN_MS, 0),                // min gap between trades

  // #3 — Two thresholds: a WIDER entry confirmation + a TIGHTER trailing exit.
  // Both honour THRESHOLD_MODE. Default to THRESHOLD so old single-Δ behaviour holds
  // until set. Recommended (percent): entry 0.3, exit 0.15.
  ENTRY_THRESHOLD: num(process.env.BOT_ENTRY_THRESHOLD, num(process.env.BOT_THRESHOLD, 0.05)),
  EXIT_THRESHOLD:  num(process.env.BOT_EXIT_THRESHOLD,  num(process.env.BOT_THRESHOLD, 0.05)),

  // ── ATR-adaptive thresholds (THRESHOLD_MODE='atr') ───────────────────────────
  // The proper fix for "too quiet here, too twitchy there": the threshold tracks live
  // volatility. delta = max(MULT × ATR, fixed ENTRY/EXIT_THRESHOLD). So it AUTO-WIDENS
  // when ETH is volatile (won't whipsaw) but never tightens below the $ floor (won't
  // churn in dead-calm). ATR is Wilder ATR(period) over the Binance VOLUME_INTERVAL
  // candle stream (same WS — no extra RPC), seeded from REST so it's live immediately.
  ATR_PERIOD:     num(process.env.BOT_ATR_PERIOD, 14),
  ENTRY_ATR_MULT: num(process.env.BOT_ENTRY_ATR_MULT, 1.0),
  EXIT_ATR_MULT:  num(process.env.BOT_EXIT_ATR_MULT, 1.0),

  // #1 — Smoothed-price reversal: run the trough/peak reversal on an EMA of the
  // price, not raw ticks, so noise can't fake a reversal. SMOOTHING_MS = EMA
  // time-constant (bigger = smoother but more lag). Set false to use raw ticks.
  SMOOTHING:    bool(process.env.BOT_SMOOTHING, true),
  SMOOTHING_MS: num(process.env.BOT_SMOOTHING_MS, 60000),

  // Fake-spike filter: after the entry threshold triggers, require the SMOOTHED price
  // to HOLD above the trigger this long before buying. A pop that fades fails the hold
  // and is skipped. 0 = buy immediately (old behaviour).
  ENTRY_CONFIRM_MS: num(process.env.BOT_ENTRY_CONFIRM_MS, 45000),

  // Volume confirmation (false-breakout filter). Only BUY if the latest Binance candle's
  // volume ≥ MULT × the trailing WINDOW-period volume MA. Instant gate (no chase). Source
  // is a Binance kline WebSocket (no RPC load). Inactive until MIN_SAMPLES candles seen.
  VOLUME_FILTER:      bool(process.env.BOT_VOLUME_FILTER, true),
  VOLUME_MULT:        num(process.env.BOT_VOLUME_MULT, 1.5),
  VOLUME_WINDOW:      num(process.env.BOT_VOLUME_WINDOW, 20),
  VOLUME_MIN_SAMPLES: num(process.env.BOT_VOLUME_MIN_SAMPLES, 5),
  VOLUME_SYMBOL:      (process.env.BOT_VOLUME_SYMBOL || 'ethusdt').toLowerCase(),
  VOLUME_INTERVAL:    (process.env.BOT_VOLUME_INTERVAL || '1m'),

  // ── Trend filter (Option B: "sit in cash" — only BUY in an uptrend) ──────────
  TREND_FILTER:      bool(process.env.BOT_TREND_FILTER, true),         // on = block buys while price is below its moving average
  TREND_WINDOW_MS:   num(process.env.BOT_TREND_WINDOW_MS, 900000),     // moving-average window (default 15 min)
  TREND_MIN_SAMPLES: num(process.env.BOT_TREND_MIN_SAMPLES, 20),       // warm-up ticks before the filter acts

  // ── Regime / chop filter (anti-whipsaw) ──────────────────────────────────────
  // Whipsaw = trading a ranging market. This gate only allows BUYS when the trend MA
  // is actually SLOPING UP by ≥ MIN_SLOPE_PCT across the trend window — so the bot
  // stands aside in flat/choppy markets (where the Δ-reversal just churns to the fee
  // floor) and only commits when a real directional move is underway. THE structural
  // whipsaw fix: not a tighter threshold, but "don't trade chop at all".
  REGIME_FILTER:        bool(process.env.BOT_REGIME_FILTER, false),
  REGIME_MIN_SLOPE_PCT: num(process.env.BOT_REGIME_MIN_SLOPE_PCT, 0.2), // min MA drift % over the window to call it a trend

  // ── Protective exits (cut a long instead of bag-holding) ─────────────────────
  // These OVERRIDE the MIN_NET_PROFIT guard below, so a losing/fading position is
  // always cut rather than held through a downtrend (the exact trap that forced a
  // manual flatten at −0.30). Profit-taking still uses the normal Δ-reversal +
  // MIN_NET_PROFIT, so small *real* profits keep accumulating.
  STOP_LOSS_PCT: num(process.env.BOT_STOP_LOSS_PCT, 0.5),   // SELL if price falls ≥ this % below the entry price (0 = off)
  TREND_EXIT:    bool(process.env.BOT_TREND_EXIT, true),    // SELL when the trend MA flips down while holding (symmetric to the buy filter)

  // ── Risk / economics guards (OD-1 / OD-2 / OD-5) ─────────────────────────────
  // OD-1: THRESHOLD above is already configurable — raise BOT_THRESHOLD (e.g. 2 or 5)
  //       so each round trip targets a move big enough to clear costs.
  // OD-2: only SELL if expected net (proceeds − entry cost − est. costs) ≥ this.
  //   0  = OFF (always honour the reversal — cuts losers).
  //   >0 = only realise profitable exits. ⚠️ This means it will HOLD a losing
  //        position instead of cutting it, until price recovers enough.
  MIN_NET_PROFIT:     num(process.env.BOT_MIN_NET_PROFIT, 0),    // USDC
  EST_COST_PER_TRADE: num(process.env.BOT_EST_COST, 0),          // USDC gas+fee estimate used by the guard
  // OD-5: the AMM's swapWithAmount has NO min-output, so we cannot prevent a bad
  //   fill on-chain — instead we DETECT it after the swap and alert (optionally halt).
  SLIPPAGE_ALERT_BPS: num(process.env.BOT_SLIPPAGE_BPS, 50),     // warn if a live fill deviates > this (basis points)
  SLIPPAGE_HALT:      bool(process.env.BOT_SLIPPAGE_HALT, false),// true = stop trading after a bad fill

  // ── Tokens / chain ───────────────────────────────────────────────────────────
  WETH_ADDRESS: trim(process.env.WETH_TOKEN_ADDRESS),
  USDT_ADDRESS: trim(process.env.USDT_TOKEN_ADDRESS),   // NOTE: this is actually USDC.e on Polygon
  USDC_ADDRESS: trim(process.env.USDT_TOKEN_ADDRESS),   // USDC.e (0x2791…) — what the wallet holds
  ADMIN_WALLET: trim(process.env.ADMIN_WALLET_ADDRESS),
  USDT_DECIMALS: 6,
  WETH_DECIMALS: 18,

  // ── Price source & Uniswap (Polygon) ─────────────────────────────────────────
  PRICE_SOURCE: (process.env.BOT_PRICE_SOURCE || 'uniswap'),   // 'uniswap' | 'binance'
  RPC_HTTP: trim(process.env.POLYGON_RPC_URL),
  RPC_WSS:  deriveWss(),                                       // websocket node connection (best-effort)
  USE_WSS:  bool(process.env.BOT_USE_WSS, true),               // subscribe to new blocks over WSS
  BLOCK_POLL_MS:    num(process.env.BOT_BLOCK_POLL_MS, 2500),     // reliable polling baseline (ms)
  FEED_MIN_READ_MS: num(process.env.BOT_FEED_MIN_READ_MS, 4000),  // hard cap on pool-read rate → cuts Infura RPC load
  RPC_BACKOFF_MS:   num(process.env.BOT_RPC_BACKOFF_MS, 30000),   // pause trading this long after an RPC error (anti-spam)
  POOL_FEE: num(process.env.BOT_POOL_FEE, 500),               // 0.05% tier (auto-falls back if illiquid)
  UNISWAP_V3_FACTORY: trim(process.env.UNISWAP_V3_FACTORY) || '0x1F98431c8aD98523631AE4a59f267346ea31F984',
  UNISWAP_ROUTER:     trim(process.env.UNISWAP_ROUTER)     || '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45', // SwapRouter02 (live, next phase)
  UNISWAP_QUOTER:     trim(process.env.UNISWAP_QUOTER)     || '0x61fFE014bA17989E743c5F6cB21bF9697530B21e', // QuoterV2
  SLIPPAGE_TOLERANCE: num(process.env.BOT_SLIPPAGE_TOLERANCE, 0.005),  // 0.5% min-output protection on live swaps
  POL_PRICE_USD:      num(process.env.BOT_POL_PRICE_USD, 0.08),         // FALLBACK POL/USD only (live price fetched from Binance at runtime)

  // ── Misc ─────────────────────────────────────────────────────────────────────
  // Throttle for writing the moving anchor + tick log to the DB (ms).
  PERSIST_THROTTLE_MS: num(process.env.BOT_PERSIST_MS, 3000),
  TICK_LOG: bool(process.env.BOT_TICK_LOG, true),
};
