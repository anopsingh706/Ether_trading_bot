// bot/cbReset.js — clear a tripped circuit breaker (npm run cb:reset), then restart the bot.
// Resets the counters too, so the next trip needs a fresh run of losses. Uses the same
// BOT_CHAIN / BOT_SIM settings as the bot, so it targets exactly that bot's state.
const cfg = require('./config');
const botConn = require('./db');
const BotState = require('./models/BotState');
const { STATE_KEY } = require('./state');

(async () => {
  await botConn.asPromise();
  const s = await BotState.findOne({ key: STATE_KEY });
  if (!s) { console.log(`No bot state "${STATE_KEY}" found.`); process.exit(1); }
  console.log(`state "${STATE_KEY}": ${s.cbTripped ? `TRIPPED (${s.cbReason}) — ${s.cbDetail} at ${s.cbTrippedAt && s.cbTrippedAt.toISOString()}` : 'not tripped'}`);
  await BotState.updateOne({ key: STATE_KEY }, { $set: {
    cbTripped: false, cbReason: null, cbDetail: null, cbTrippedAt: null,
    cbConsecLosses: 0, cbDay: new Date().toISOString().slice(0, 10), cbDayPnl: 0, cbPeakPnl: s.cumulativePnl || 0,
  } });
  console.log(`✅ circuit breaker reset (${cfg.CHAIN_NAME}${cfg.SIM_MODE ? ', simulation' : ''}). Now restart the bot: pm2 restart eather-bot`);
  process.exit(0);
})().catch((e) => { console.error('💥', e.message || e); process.exit(1); });
