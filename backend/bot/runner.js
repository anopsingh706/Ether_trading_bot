// bot/runner.js
// ─────────────────────────────────────────────────────────────────────────────
// Bootstraps the new engine: connect sandbox DB → init state → start WS feed →
// route every tick into the strategy engine. Prints a trade ledger (one row per
// trade), a periodic STATUS box with live metrics, and a session summary on exit.
// ─────────────────────────────────────────────────────────────────────────────
const cfg = require('./config');
const botConn = require('./db');
const PriceFeed = require('./priceFeed');
const UniswapFeed = require('./uniswapFeed');
const StrategyEngine = require('./strategyEngine');
const VolumeFeed = require('./volumeFeed');
const BotTick = require('./models/BotTick');
const logger = require('./logger');

let _lastTickLog = 0;

async function main() {
  await botConn.asPromise(); // wait for sandbox DB connection

  console.log('────────────────────────────────────────────────────────────');
  console.log('🤖 Trading bot starting');
  console.log('   mode      : ⚠️  LIVE (real funds) — every run trades real money');
  if (cfg.THRESHOLD_MODE === 'atr') {
    console.log(`   entry/exit: ATR-adaptive — buy ${cfg.ENTRY_ATR_MULT}×ATR / sell ${cfg.EXIT_ATR_MULT}×ATR, floor $${cfg.ENTRY_THRESHOLD}/$${cfg.EXIT_THRESHOLD} (ATR${cfg.ATR_PERIOD} on ${cfg.VOLUME_INTERVAL})`);
  } else {
    console.log(`   entry/exit: buy +${cfg.ENTRY_THRESHOLD} / sell -${cfg.EXIT_THRESHOLD} (${cfg.THRESHOLD_MODE})`);
  }
  console.log(`   smoothing : ${cfg.SMOOTHING ? 'EMA ~' + Math.round(cfg.SMOOTHING_MS / 1000) + 's (decisions on smoothed price)' : 'off (raw ticks)'}`);
  console.log(`   guards    : minNetProfit=${cfg.MIN_NET_PROFIT} USDC | slippageAlert=${cfg.SLIPPAGE_ALERT_BPS}bps${cfg.SLIPPAGE_HALT ? ' (HALT on)' : ''}`);
  console.log(`   trend flt : ${cfg.TREND_FILTER ? 'ON' : 'off'} — only buys in an uptrend (MA window ${Math.round(cfg.TREND_WINDOW_MS / 60000)}min)`);
  console.log(`   exits     : take-profit≥${cfg.MIN_NET_PROFIT} USDC | stop-loss ${cfg.STOP_LOSS_PCT > 0 ? cfg.STOP_LOSS_PCT + '%' : 'off'} | trend-exit ${cfg.TREND_EXIT ? 'on' : 'off'}`);
  console.log(`   filters   : fake-spike confirm ${cfg.ENTRY_CONFIRM_MS > 0 ? Math.round(cfg.ENTRY_CONFIRM_MS / 1000) + 's' : 'off'} | cooldown ${cfg.COOLDOWN_MS > 0 ? Math.round(cfg.COOLDOWN_MS / 1000) + 's' : 'off'} | feed read ≤1/${Math.round(cfg.FEED_MIN_READ_MS / 1000)}s`);
  console.log(`   volume    : ${cfg.VOLUME_FILTER ? 'confirm ON — buy only if ' + cfg.VOLUME_SYMBOL.toUpperCase() + ' ' + cfg.VOLUME_INTERVAL + ' vol ≥ ' + cfg.VOLUME_MULT + '× ' + cfg.VOLUME_WINDOW + '-MA' : 'off'}`);
  console.log(`   regime    : ${cfg.REGIME_FILTER ? 'ON — buy only when the ' + Math.round(cfg.TREND_WINDOW_MS / 60000) + 'min MA slopes ≥ +' + cfg.REGIME_MIN_SLOPE_PCT + '% (anti-whipsaw: skip ranging markets)' : 'off'}`);
  console.log(`   db        : ${botConn.name}`);
  console.log(`   price src : ${cfg.PRICE_SOURCE === 'uniswap' ? 'Uniswap v3 pool (Polygon, on-chain)' : 'Binance ' + cfg.WS_SYMBOL}`);
  console.log('────────────────────────────────────────────────────────────');

  const feed = cfg.PRICE_SOURCE === 'uniswap' ? new UniswapFeed() : new PriceFeed();
  const volumeFeed = (cfg.VOLUME_FILTER || cfg.THRESHOLD_MODE === 'atr') ? new VolumeFeed() : null;
  const engine = new StrategyEngine(feed, volumeFeed);
  await engine.init();
  logger.tradeTableHeader();

  feed.on('tick', (t) => {
    engine.onTick(t).catch((e) => console.error('🔥 onTick:', e.message || e));

    if (cfg.TICK_LOG && Date.now() - _lastTickLog >= cfg.PERSIST_THROTTLE_MS) {
      _lastTickLog = Date.now();
      BotTick.create({ symbol: cfg.WS_SYMBOL, price: t.price, source: t.source }).catch(() => {});
    }
  });

  await feed.start();
  if (volumeFeed) await volumeFeed.start();

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

    const entryDelta = s.anchorPrice != null ? engine._entryDelta(s.anchorPrice) : 0;
    const exitDelta  = s.anchorPrice != null ? engine._exitDelta(s.anchorPrice)  : 0;

    const holding = s.position === 'IN_WETH';
    let next = '—';
    if (s.anchorPrice != null) {
      next = holding ? `SELL≤${fmt(s.anchorPrice - exitDelta)}` : `BUY≥${fmt(s.anchorPrice + entryDelta)}`;
    }
    // show the protective stop level while holding (entry − STOP_LOSS_PCT%)
    let stopStr = '';
    if (holding && s.entryPrice != null && cfg.STOP_LOSS_PCT > 0) {
      stopStr = ` stop≤${fmt(s.entryPrice * (1 - cfg.STOP_LOSS_PCT / 100))}`;
    }
    let unreal = null;
    if (holding && s.entryPrice != null && s.entryWeth != null && feed.lastPrice != null) {
      unreal = (feed.lastPrice - s.entryPrice) * s.entryWeth;
    }

    const tr = engine.lastTrend || {};
    const trendStr = !tr.ready ? 'warming' : (tr.up ? 'up' : 'down');
    const regStr = cfg.REGIME_FILTER
      ? ` reg ${tr.regimeReady ? tr.regime + (tr.slopePct != null ? '(' + (tr.slopePct >= 0 ? '+' : '') + tr.slopePct.toFixed(2) + '%)' : '') : 'warm'}`
      : '';
    let volStr = '';
    if (cfg.VOLUME_FILTER && volumeFeed) {
      const vc = volumeFeed.check(cfg.VOLUME_MULT);
      volStr = !vc.active
        ? ` | vol warm(${vc.n}/${cfg.VOLUME_WINDOW})`
        : ` | vol ${vc.ma > 0 ? (vc.recent / vc.ma).toFixed(1) + '×' : 'n/a'}${vc.ok ? '✓' : '✗'}`;
    }
    let atrStr = '';
    if (cfg.THRESHOLD_MODE === 'atr' && volumeFeed) {
      const a = volumeFeed.atr();
      atrStr = a ? ` | ATR ${fmt(a)} Δ${fmt(entryDelta)}/${fmt(exitDelta)}` : ' | ATR warm';
    }
    const line =
      `⏳ ${holding ? 'HOLDING' : 'WAITING'} | last ${fmt(feed.lastPrice)}${cfg.SMOOTHING && engine.ema != null ? ' ema ' + fmt(engine.ema) : ''} | ` +
      `${holding ? 'peak' : 'bot'} ${fmt(s.anchorPrice)} | trend ${trendStr}${tr.ma ? ' MA' + fmt(tr.ma) : ''}${regStr} | next ${next}${stopStr}${volStr}${atrStr} | ` +
      `${holding ? 'unreal ' + signed(unreal) : 'flat'} | ` +
      `RT ${s.roundTrips || 0} W${s.wins || 0}/L${s.losses || 0} | PnL ${signed(s.cumulativePnl || 0)} | ` +
      `${ticks}t/5s${feed.isStale() ? ' ⚠️STALE' : ''}`;

    if (process.stdout.isTTY) {
      logger.renderStatus(line);
    } else if (Date.now() - lastFileStatus >= 60000) {
      lastFileStatus = Date.now();
      logger.statusLineNonTTY(line);
    }
  }, 5000);

  const shutdown = async () => {
    const s = engine.state || {};
    logger.tableFooter();
    logger.summary({
      roundTrips: s.roundTrips || 0,
      wins: s.wins || 0,
      losses: s.losses || 0,
      realized: s.cumulativePnl || 0,
    });
    console.log('🛑 Shutting down…');
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
