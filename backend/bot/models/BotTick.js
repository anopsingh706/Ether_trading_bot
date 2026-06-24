// bot/models/BotTick.js
// ─────────────────────────────────────────────────────────────────────────────
// Throttled price-tick log — kept for auditing / future backtesting.
// NOT used for decisions (the live WS stream drives those in memory).
// ─────────────────────────────────────────────────────────────────────────────
const { Schema } = require('mongoose');
const botConn = require('../db');

const BotTickSchema = new Schema({
  symbol:     { type: String },
  price:      { type: Number },
  source:     { type: String, default: 'ws' }, // 'ws' | 'rest'
  created_at: { type: Date, default: Date.now, index: true },
});

module.exports = botConn.model('BotTick', BotTickSchema, 'bot_ticks');
