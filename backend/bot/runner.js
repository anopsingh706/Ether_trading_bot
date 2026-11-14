// bot/runner.js
// ─────────────────────────────────────────────────────────────────────────────
// Bootstraps the new engine: connect sandbox DB → init state → start WS feed →
// route every tick into the strategy engine. Prints a trade ledger (one row per
// trade), a periodic STATUS box with live metrics, and a session summary on exit.
// ─────────────────────────────────────────────────────────────────────────────
const pkg = require('../package.json');
const cfg = require('./config');
const botConn = require('./db');
const PriceFeed = require('./priceFeed');
const UniswapFeed = require('./uniswapFeed');
const StrategyEngine = require('./strategyEngine');
const VolumeFeed = require('./volumeFeed');
const BotTick = require('./models/BotTick');
const logger = require('./logger');
const control = require('./control');

let _lastTickLog = 0;

async function main() {
  await botConn.asPromise(); // wait for sandbox DB connection

  console.log('────────────────────────────────────────────────────────────');
  console.log(`🤖 Trading bot starting — v${pkg.version}`);
  if (cfg.SIM_MODE) {
    console.log(`   mode      : 🧪 SIMULATION (paper) — virtual $${cfg.SIM_CAPITAL} capital, NO real funds, no wallet`);
    console.log(cfg.SIM_NO_FEES
      ? `   sim cost  : ⚠️ NONE — frictionless fill at signal price (NO fee/impact/gas — NOT realistic)`
      : `   sim cost  : real QuoterV2 fill (0.05% LP fee + price impact) + live gas estimate per swap`);
    if (cfg.SIM_ID) console.log(`   sim run   : "${cfg.SIM_ID}" (own state + orders → compare with: npm run sim:compare)`);
    console.log(`   sim target: ~${cfg.SIM_TX_TARGET} transactions${cfg.SIM_MAX_TX > 0 ? ` (hard stop at ${cfg.SIM_MAX_TX})` : ' (run until stopped)'}`);
  } else {
    console.log('   mode      : ⚠️  LIVE (real funds) — every run trades real money');
  }
  console.log(`   trigger   : default ${cfg.TRIGGER_MODE === 'atr' ? 'AUTO (ATR)' : `manual — buy +$${cfg.TRIGGER_ENTRY_USD} / sell −$${cfg.TRIGGER_EXIT_USD}`} (the dashboard setting, if saved, wins — see [control] line)`);
  console.log(`   smoothing : ${cfg.SMOOTHING ? 'EMA ~' + Math.round(cfg.SMOOTHING_MS / 1000) + 's (decisions on smoothed price)' : 'off (raw ticks)'}`);
  console.log(`   guards    : minNetProfit=${cfg.MIN_NET_PROFIT} USDC | slippageAlert=${cfg.SLIPPAGE_ALERT_BPS}bps${cfg.SLIPPAGE_HALT ? ' (HALT on)' : ''}`);
  console.log(`   swap safe : minOut slip ${(cfg.SLIPPAGE_TOLERANCE * 100).toFixed(2)}%→${(cfg.SLIPPAGE_MAX * 100).toFixed(2)}% (ATR-adaptive ×${cfg.SLIPPAGE_ATR_MULT}) | revert backoff ${Math.round(cfg.REVERT_BACKOFF_MS / 1000)}s`);
  console.log(`   trend flt : ${cfg.TREND_FILTER ? 'ON' : 'off'} — only buys in an uptrend (MA window ${Math.round(cfg.TREND_WINDOW_MS / 60000)}min)`);
  if (cfg.EXIT_MODE !== 'classic' && cfg.EXIT_MODE !== 'breakeven') {
    const rule = cfg.EXIT_MODE === 'instant' ? 'sell the moment price < entry'
      : cfg.EXIT_MODE === 'timestop' ? `sell if still below entry after ${cfg.TIME_STOP_H}h`
      : `sell when below entry AND trend down for ${Math.round(cfg.REGIME_CONFIRM_MS / 1000)}s`;
    console.log(`   exits     : ${cfg.EXIT_MODE.toUpperCase()} mode — underwater: ${rule} | trail above BE+${cfg.BE_BUFFER_PCT}% | ε-tol ${cfg.BE_TOLERANCE_PCT}% | disaster stop ${cfg.DISASTER_STOP_PCT > 0 ? cfg.DISASTER_STOP_PCT + '%' : 'off'}`);
  } else if (cfg.EXIT_MODE === 'breakeven') {
    console.log(`   exits     : BREAK-EVEN mode — no loss exits (hold underwater for BE+${cfg.BE_BUFFER_PCT}%) | trail above BE | ε-tol ${cfg.BE_TOLERANCE_PCT}% | disaster stop ${cfg.DISASTER_STOP_PCT > 0 ? cfg.DISASTER_STOP_PCT + '%' : '⚠️ OFF (unbounded holds)'}`);
    console.log(`   uw-swing  : ${cfg.UW_SWING ? `⚠️ ON — reb $${cfg.SW_REB}/rev $${cfg.SW_REV}, min-drop ${cfg.UW_MIN_DROP_PCT}%, cool ${Math.round(cfg.SW_COOL_MS / 60000)}m, max ${cfg.SW_MAX}/campaign (backtest: net-negative — your call)` : 'off (backtest verdict: hurts — enable with BOT_UW_SWING=true)'}`);
  } else {
    console.log(`   exits     : take-profit≥${cfg.MIN_NET_PROFIT} USDC | stop-loss ${cfg.STOP_LOSS_PCT > 0 ? cfg.STOP_LOSS_PCT + '%' : 'off'} | trend-exit ${cfg.TREND_EXIT ? 'on' : 'off'}`);
  }
  console.log(`   filters   : fake-spike confirm ${cfg.ENTRY_CONFIRM_MS > 0 ? Math.round(cfg.ENTRY_CONFIRM_MS / 1000) + 's' : 'off'} | cooldown ${cfg.COOLDOWN_MS > 0 ? Math.round(cfg.COOLDOWN_MS / 1000) + 's' : 'off'} | feed read ≤1/${Math.round(cfg.FEED_MIN_READ_MS / 1000)}s`);
  console.log(`   volume    : ${cfg.VOLUME_FILTER ? 'confirm ON — buy only if ' + cfg.VOLUME_SYMBOL.toUpperCase() + ' ' + cfg.VOLUME_INTERVAL + ' vol ≥ ' + cfg.VOLUME_MULT + '× ' + cfg.VOLUME_WINDOW + '-MA' : 'off'}`);
  console.log(`   atr filt  : ${cfg.ATR_FILTER ? 'ON — skip entries when ATR < ' + cfg.ATR_MIN_PCT + '% (period ' + cfg.ATR_PERIOD + ')' : 'off'}`);
  console.log(`   atr trig  : entry ${cfg.ATR_ENTRY_MULT > 0 ? 'ATR×' + cfg.ATR_ENTRY_MULT + ' (replaces fixed $ once warm)' : 'off (fixed $ threshold)'} | exit ${cfg.ATR_EXIT_MULT > 0 ? 'ATR×' + cfg.ATR_EXIT_MULT : 'off (fixed $ threshold)'}`);
  console.log(`   circuit   : ${cfg.CB_ENABLED ? `ON — stop new buys after ${cfg.CB_MAX_CONSEC_LOSSES || '∞'} losses in a row | −$${cfg.CB_MAX_DAILY_LOSS_USD || '∞'}/day | −$${cfg.CB_MAX_DRAWDOWN_USD || '∞'} from best` : 'off'}`);
  console.log(`   dashboard : heartbeat + remote controls via DB (pause / resume / emergency sell / reset breaker)`);
  console.log(`   rsi filt  : ${cfg.RSI_FILTER ? 'ON — buy only if RSI ≤ ' + cfg.RSI_MAX_ENTRY + ' (period ' + cfg.RSI_PERIOD + ', confirms a real oversold dip)' : 'off'}`);
  console.log(`   db        : ${botConn.name}`);
  console.log(`   chain     : ${cfg.CHAIN_NAME} — ${cfg.DEX_NAME} WETH/${cfg.USDC_SYMBOL} fee ${cfg.POOL_FEE} (${cfg.POOL_FEE / 1e4}%) | gas in ${cfg.NATIVE_SYMBOL}${cfg.L1_FEE_ORACLE ? ' + L1 data fee' : ''} | rpc ${/infura|alchemy/.test(cfg.RPC_HTTP || '') ? 'private' : (cfg.RPC_HTTP || '—')}`);
  console.log(`   price src : ${cfg.PRICE_SOURCE === 'uniswap' ? `${cfg.DEX_NAME} pool (${cfg.CHAIN_NAME}, on-chain)` : 'Binance ' + cfg.WS_SYMBOL}`);
  console.log('────────────────────────────────────────────────────────────');

  const feed = cfg.PRICE_SOURCE === 'uniswap' ? new UniswapFeed() : new PriceFeed();
  // One Binance kline feed powers BOTH the volume filter and the ATR filter.
  const volumeFeed = (cfg.VOLUME_FILTER || cfg.ATR_FILTER) ? new VolumeFeed() : null;
  const engine = new StrategyEngine(feed, volumeFeed);
  await engine.init();
  control.start(engine, feed); // BEFORE the feed starts: a saved pause must hold from the very first tick
  logger.tradeTableHeader();

  feed.on('tick', (t) => {
    engine.onTick(t).catch((e) => console.error('🔥 onTick:', e.message || e));

    if (cfg.TICK_LOG && Date.now() - _lastTickLog >= cfg.PERSIST_THROTTLE_MS) {
      _lastTickLog = Date.now();
      BotTick.create({ symbol: cfg.WS_SYMBOL, price: t.price, source: t.source }).catch(() => {});
    }
  });

  await feed.start();
  if (volumeFeed) volumeFeed.start();

  // live status: a single in-place line at the bottom (TTY), or a sparse line
  // every ~60s when output is redirected to a file. Never adds table rows.
  const { fmt, signed } = logger;
  let lastTickCount = 0;
  let lastFileStatus = 0;
  setInterval(() => {
    const s = engine.state;
    if (!s) return;

    const ticks = feed.tickCount - lastTickCount;
    lastTickCount = feed.tickCount;

    // the trigger distances the engine REALLY uses (dashboard manual $, or ATR)
    const entryDelta = s.anchorPrice != null ? engine._entryDelta(s.anchorPrice) : 0;
    const exitDelta  = s.anchorPrice != null ? engine._exitDelta(s.anchorPrice) : 0;

    const holding = s.position === 'IN_WETH';
    const swinging = s.position === 'IN_SWING';
    let next = '—';
    if (s.anchorPrice != null) {
      next = holding ? `SELL≤${fmt(s.anchorPrice - exitDelta)}`
        : swinging ? `REBUY≥${fmt(s.anchorPrice + entryDelta)}${s.swingSellPrice ? '|fs≥' + fmt(s.swingSellPrice + cfg.SW_REV) : ''}`
        : `BUY≥${fmt(s.anchorPrice + entryDelta)}`;
    }
    // show the exit levels while holding: BE floor (breakeven mode) or stop-loss (classic)
    let stopStr = '';
    if (holding && cfg.FLOOR_EXIT_MODES.includes(cfg.EXIT_MODE) && engine.lastBE != null) {
      const uw = s.anchorPrice != null && s.anchorPrice < engine.lastBE;
      const uwh = uw && s.entryAt ? ' uw ' + ((Date.now() - new Date(s.entryAt).getTime()) / 3600000).toFixed(1) + 'h' : '';
      stopStr = ` BE≥${fmt(engine.lastBE)}${uw ? '⏳' + uwh : '✓'}${cfg.DISASTER_STOP_PCT > 0 && s.entryPrice ? ' dstop≤' + fmt(s.entryPrice * (1 - cfg.DISASTER_STOP_PCT / 100)) : ''}`;
    } else if (holding && s.entryPrice != null && cfg.STOP_LOSS_PCT > 0) {
      stopStr = ` stop≤${fmt(s.entryPrice * (1 - cfg.STOP_LOSS_PCT / 100))}`;
    }
    let unreal = null;
    if (holding && s.entryPrice != null && s.entryWeth != null && feed.lastPrice != null) {
      unreal = (feed.lastPrice - s.entryPrice) * s.entryWeth;
    } else if (swinging && s.swingCash != null && s.entryUsdt != null) {
      unreal = s.swingCash - s.entryUsdt; // campaign progress while parked in cash
    }

    const tr = engine.lastTrend || {};
    const trendStr = !tr.ready ? 'warming' : (tr.up ? 'up' : 'down');
    // NOTE: volume/ATR/RSI filter readouts were dropped from this line to keep it short
    // and stable in the terminal — a blocked buy still prints its own reason via
    // logger.note() (throttled) from the strategy engine when it happens.
    // sim: show virtual equity (cash + WETH marked at the live price) and tx progress
    let simStr = '';
    if (cfg.SIM_MODE) {
      const equity = (s.simUsdt || 0) + (s.simWeth || 0) * (feed.lastPrice || 0);
      simStr = ` | 💰$${equity.toFixed(2)} (gas $${(s.simGasUsd || 0).toFixed(2)}) | tx ${s.txCount || 0}/${cfg.SIM_TX_TARGET}`;
    }
    const line =
      `⏳ ${holding ? 'HOLDING' : swinging ? 'SWING' + (s.swingCount ? ' ' + s.swingCount + '/' + cfg.SW_MAX : '') : 'WAITING'} | last ${fmt(feed.lastPrice)}${cfg.SMOOTHING && engine.ema != null ? ' ema ' + fmt(engine.ema) : ''} | ` +
      `${holding ? 'peak' : swinging ? 'low' : 'bot'} ${fmt(s.anchorPrice)} | trend ${trendStr}${tr.ma ? ' MA' + fmt(tr.ma) : ''} | next ${next}${stopStr} | ` +
      `${holding || swinging ? 'unreal ' + signed(unreal) : 'flat'} | ` +
      `RT ${s.roundTrips || 0} W${s.wins || 0}/L${s.losses || 0} | PnL ${signed(s.cumulativePnl || 0)}${simStr} | ` +
      `${ticks}t/5s${feed.isStale() ? ' ⚠️STALE' : ''}${control.paused() ? ' ⏸PAUSED' : ''}`;
    engine.statusLine = line; // published to the dashboard by the heartbeat

    // sim hard-stop: shut down cleanly once the configured swap count is reached.
    if (cfg.SIM_MODE && cfg.SIM_MAX_TX > 0 && (s.txCount || 0) >= cfg.SIM_MAX_TX) {
      logger.renderStatus(line);
      console.log(`\n🧪 [sim] reached ${s.txCount} transactions (target ${cfg.SIM_MAX_TX}) — stopping.`);
      shutdown();
      return;
    }

    if (process.stdout.isTTY) {
      logger.renderStatus(line);
    } else if (Date.now() - lastFileStatus >= 60000) {
      lastFileStatus = Date.now();
      logger.statusLineNonTTY(line);
    }
  }, 5000);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const s = engine.state || {};
    logger.tableFooter();
    logger.summary({
      roundTrips: s.roundTrips || 0,
      wins: s.wins || 0,
      losses: s.losses || 0,
      realized: s.cumulativePnl || 0,
    });
    console.log('🛑 Shutting down…');
    await control.stopped().catch(() => {}); // dashboard shows "stopped" instead of waiting for the heartbeat to age
    feed.stop();
    if (volumeFeed) volumeFeed.stop();
    try { await botConn.close(); } catch (_) {}
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('💥 Fatal startup error:', e.message || e);
  process.exit(1);
});
