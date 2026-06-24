// botRunner.js  (entry point)
// ─────────────────────────────────────────────────────────────────────────────
// Standalone launcher for the NEW trailing-0.05 trading engine.
// Runs INDEPENDENTLY of server.js — it does not start the Express API or the old
// priceScheduler/ammBuySellNew loop. Safe to run while building/testing.
//
//   Run:   node botRunner.js
//   Mode:  controlled by BOT_DRY_RUN in .env (defaults to true = paper mode)
// ─────────────────────────────────────────────────────────────────────────────
require('./bot/runner');
