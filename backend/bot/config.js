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

  // ── Simulation (paper) mode ──────────────────────────────────────────────────
  // BOT_SIM=true → NO real swaps, NO wallet, NO private key needed. Prices are the
  // real-time Uniswap pool price; every fill is priced with the REAL QuoterV2 (so the
  // 0.05% LP fee AND price impact are included) plus a real gas estimate. Trades run
  // against a virtual SIM_CAPITAL balance. Fully isolated from live state (its own
  // BotState document `sim-singleton`; orders tagged dry_run:true / route UNISWAP-SIM).
  SIM_MODE:      bool(process.env.BOT_SIM, false),
  SIM_CAPITAL:   num(process.env.BOT_SIM_CAPITAL, 1000),   // virtual starting USDC.e
  SIM_TX_TARGET: num(process.env.BOT_SIM_TX_TARGET, 1000), // progress-display target (number of swaps)
  SIM_MAX_TX:    num(process.env.BOT_SIM_MAX_TX, 0),       // hard-stop after N swaps (0 = off, run until stopped)
  SIM_GAS_UNITS: num(process.env.BOT_SIM_GAS_UNITS, 0),    // override gas units/swap (0 = use QuoterV2 estimate)
  // ⚠️ FRICTIONLESS mode: fill every swap at the exact signal price — NO LP fee, NO
  // price impact, NO gas. This is the OLD fee-blind paper model (the "+$950" illusion);
  // it isolates the strategy's raw timing but is NOT realistic. Off by default.
  SIM_NO_FEES:   bool(process.env.BOT_SIM_NO_FEES, false),

  // ── Price feed (Binance WebSocket) ───────────────────────────────────────────
  WS_SYMBOL:   (process.env.BOT_WS_SYMBOL || 'ethusdt').toLowerCase(),  // ws stream
  REST_SYMBOL: process.env.CRYPTO_ID || 'ETHUSDT',                      // REST fallback
  MAX_PRICE_STALENESS_MS: num(process.env.BOT_MAX_STALENESS_MS, 10000), // pause if no tick

  // ── Strategy ─────────────────────────────────────────────────────────────────
  THRESHOLD:       num(process.env.BOT_THRESHOLD, 0.05),               // legacy single Δ (fallback)
  THRESHOLD_MODE:  (process.env.BOT_THRESHOLD_MODE || 'absolute'),     // 'absolute' | 'percent'
  TRADE_SIZE_MODE: (process.env.BOT_TRADE_SIZE_MODE || 'all'),         // 'all' (100%)
  // Fixed-notional position size (USDC) per BUY. 0 = all-in (legacy). Smaller size
  // → far less price impact (the dominant cost on the thin USDC.e pool). Sim only.
  TRADE_USD:       num(process.env.BOT_TRADE_USD, 0),
  COOLDOWN_MS:     num(process.env.BOT_COOLDOWN_MS, 0),                // min gap between trades

  // #3 — Two thresholds: a WIDER entry confirmation + a TIGHTER trailing exit.
  // Both honour THRESHOLD_MODE. Default to THRESHOLD so old single-Δ behaviour holds
  // until set. Recommended (percent): entry 0.3, exit 0.15.
  ENTRY_THRESHOLD: num(process.env.BOT_ENTRY_THRESHOLD, num(process.env.BOT_THRESHOLD, 0.05)),
  EXIT_THRESHOLD:  num(process.env.BOT_EXIT_THRESHOLD,  num(process.env.BOT_THRESHOLD, 0.05)),

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

  // ── ATR volatility filter (anti-whipsaw: don't trade dead / low-vol chop) ────
  // ATR (Average True Range) from Binance klines. When the market is too quiet for a
  // move to clear the round-trip cost, sit in cash instead of churning. Optionally
  // makes the entry threshold adaptive (Δ scales with ATR). Source = the same kline
  // stream the volume filter already uses (no extra RPC load).
  ATR_FILTER:     bool(process.env.BOT_ATR_FILTER, true),
  ATR_PERIOD:     num(process.env.BOT_ATR_PERIOD, 14),       // candles in the ATR average
  ATR_MIN_PCT:    num(process.env.BOT_ATR_MIN_PCT, 0.12),    // min ATR as % of price to ALLOW entries (below = too quiet → sit out)
  // Adaptive entry/exit trigger: once ATR is warm, the trigger Δ = ATR × mult — fully
  // REPLACES the fixed BOT_ENTRY_THRESHOLD/BOT_EXIT_THRESHOLD (which only remain as the
  // fallback while ATR is still warming up). Calm market → smaller Δ; volatile → bigger.
  // 0 = off (use the fixed $ threshold always, old behaviour).
  ATR_ENTRY_MULT: num(process.env.BOT_ATR_ENTRY_MULT, 0),    // entry Δ = ATR × mult (once ready)
  ATR_EXIT_MULT:  num(process.env.BOT_ATR_EXIT_MULT, 0),     // exit Δ  = ATR × mult (once ready), usually tighter than entry

  // ── RSI momentum-confirmation filter (oversold-bounce confirmation for BUYS) ────
  // Confirms the dip the entry trigger reacted to was a genuine oversold move, not a
  // random tick already back near/above neutral. Computed from the same Binance kline
  // stream the volume/ATR filters use (no extra RPC load).
  RSI_FILTER:     bool(process.env.BOT_RSI_FILTER, false),
  RSI_PERIOD:     num(process.env.BOT_RSI_PERIOD, 14),       // candles in the RSI average
  RSI_MAX_ENTRY:  num(process.env.BOT_RSI_MAX_ENTRY, 40),    // only BUY if RSI ≤ this (confirms a real oversold dip)

  // ── Trend filter (Option B: "sit in cash" — only BUY in an uptrend) ──────────
  // This is the adaptive downtrend guard (replaced the removed datum-line gate):
  // blocks buys while price < its 15-min MA, and auto-releases when the trend turns —
  // no fixed historical level to reclaim, so it can't lock the bot out indefinitely.
  TREND_FILTER:      bool(process.env.BOT_TREND_FILTER, true),         // on = block buys while price is below its moving average
  TREND_WINDOW_MS:   num(process.env.BOT_TREND_WINDOW_MS, 900000),     // moving-average window (default 15 min)
  TREND_MIN_SAMPLES: num(process.env.BOT_TREND_MIN_SAMPLES, 20),       // warm-up ticks before the filter acts

  // ── Exit mode ────────────────────────────────────────────────────────────────
  // 'classic'   = trailing Δ exit + 0.5% stop-loss (small losses cut early).
  // 'breakeven' = NEVER sell below break-even (entry + fees + gas + BE_BUFFER_PCT):
  //               hold underwater until price recovers, then exit at BE-or-better
  //               (trailing above BE). The ONLY allowed loss is the deep DISASTER
  //               stop, so a structural crash stays bounded instead of freezing the
  //               bot forever. Backtested 30d crash: 97% green exits, 10 bounded
  //               disasters vs 600+ small cuts in classic.
  EXIT_MODE:         (process.env.BOT_EXIT_MODE || 'classic'),
  DISASTER_STOP_PCT: num(process.env.BOT_DISASTER_STOP_PCT, 5),   // % below entry; 0 = off (⚠️ 30d test froze 719h holding −17%)
  BE_BUFFER_PCT:     num(process.env.BOT_BE_BUFFER_PCT, 0.1),     // margin above true breakeven (covers gas + rounding)

  // Layer 1 — ε-tolerance below the BE floor: allows exits at ≥ BE×(1−ε) so a rebound
  // that misses break-even by cents still banks (micro-loss ≈ $0.01–0.02) instead of
  // riding a $40 drawdown. Directly fixes the "peaked at 1799, BE was 1798.7-on-pool,
  // never sold, crashed to 1750" pattern. 0 = strict BE (old behaviour).
  BE_TOLERANCE_PCT:  num(process.env.BOT_BE_TOLERANCE_PCT, 0.05),

  // Layer 2 — underwater swing-repair: in a DEEP drawdown, sell big rebounds and re-buy
  // the next dip to accumulate ETH against the same basis → the break-even RATCHETS
  // DOWN each cycle, so a partial recovery can close the campaign at ≥ $0.
  // ⚠️ BACKTEST VERDICT (30d & 90d, all tunings): NET-NEGATIVE vs plain hold-for-BE —
  // real ETH drawdowns V-recover more often than they oscillate, so swing-sells mostly
  // interrupt recoveries. Shipped OFF; enable only if you accept those numbers.
  UW_SWING:          bool(process.env.BOT_UW_SWING, false),
  UW_MIN_DROP_PCT:   num(process.env.BOT_UW_MIN_DROP_PCT, 0.5),   // arm swings only ≥ this % below BE (anti-churn)
  SW_REB:            num(process.env.BOT_SW_REB, 15),             // $ rebound off the drawdown low before a swing-sell can arm
  SW_REV:            num(process.env.BOT_SW_REV, 8),              // $ reversal off the rebound peak that fires it (also failsafe margin)
  SW_COOL_MS:        num(process.env.BOT_SW_COOL_MS, 2700000),    // min gap between swing-sells (45 min)
  SW_MAX:            num(process.env.BOT_SW_MAX, 10),             // max swing cycles per campaign

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

  // Gas-burn guard: a reverted swap still pays full gas. After ANY execution error,
  // pause new swap attempts this long instead of retrying every tick (the 2026-07-02
  // incident: 5 back-to-back minOut reverts in one fast move = pure wasted gas).
  REVERT_BACKOFF_MS:  num(process.env.BOT_REVERT_BACKOFF_MS, 60000),

  // Adaptive slippage: in fast markets the pool moves >0.15% between quote and landing,
  // so a fixed tight minOut reverts every attempt. Tolerance = max(base, 1m-ATR% × MULT),
  // capped at SLIPPAGE_MAX. Quiet market → base; volatility spike → wider but bounded.
  SLIPPAGE_ATR_MULT:  num(process.env.BOT_SLIPPAGE_ATR_MULT, 2),
  SLIPPAGE_MAX:       num(process.env.BOT_SLIPPAGE_MAX, 0.005),  // hard cap (0.5%) — ENTRY quotes

  // ── Exit-completion retry (asymmetric: a missed SELL chases the market down) ──
  // A reverted BUY is free (the engine's REVERT_BACKOFF_MS handles it — a missed entry
  // costs nothing). A reverted SELL is NOT: waiting 60s while price falls turned a 1798
  // exit into a 1766 dump. So an EXIT escalates its slippage across fast retries until it
  // LANDS, starting from the normal adaptive tol and widening to EXIT_SLIPPAGE_MAX.
  // Each retry re-quotes at the current price, so the wider tol is measured fresh.
  EXIT_RETRY_MAX:      num(process.env.BOT_EXIT_RETRY_MAX, 4),        // total SELL attempts incl. the first
  EXIT_SLIPPAGE_MAX:   num(process.env.BOT_EXIT_SLIPPAGE_MAX, 0.02),  // exit-only hard cap (2%) — beats a 2%+ chase-down
  EXIT_RETRY_DELAY_MS: num(process.env.BOT_EXIT_RETRY_DELAY_MS, 3000),// gap between escalating exit retries

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
