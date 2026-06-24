// bot/models/BotState.js
// ─────────────────────────────────────────────────────────────────────────────
// THE "TABLE" — a single persisted document that is the source of truth for the
// state machine. Replaces the fragile "read the last order's side" logic.
//   position    : what we hold now (IN_USDT = waiting to buy, IN_WETH = waiting to sell)
//   anchorPrice : trailing extreme — the lowest price since we sold (IN_USDT)
//                 or the highest price since we bought (IN_WETH)
//   sim*        : simulated balances used ONLY in dry-run mode
// Persisted so a restart resumes exactly where it left off.
// ─────────────────────────────────────────────────────────────────────────────
const { Schema } = require('mongoose');
const botConn = require('../db');

const BotStateSchema = new Schema(
  {
    key:             { type: String, default: 'singleton', unique: true, index: true },
    position:        { type: String, enum: ['IN_USDT', 'IN_WETH'], default: 'IN_USDT' },
    anchorPrice:     { type: Number, default: null },
    anchorUpdatedAt: { type: Date,   default: null },
    lastActionPrice: { type: Number, default: null },
    lastActionAt:    { type: Date,   default: null },
    threshold:       { type: Number, default: 0.05 },

    // dry-run simulated balances
    simUsdt:         { type: Number, default: 0 },
    simWeth:         { type: Number, default: 0 },

    // cost basis of the CURRENTLY OPEN position (set on BUY, cleared on SELL)
    entryUsdt:       { type: Number, default: null }, // USDT spent to enter
    entryWeth:       { type: Number, default: null }, // WETH bought
    entryPrice:      { type: Number, default: null }, // realized entry rate
    entryGas:        { type: Number, default: 0 },    // gas (USD) paid on the entry leg
    entryAt:         { type: Date,   default: null },

    // running performance metrics (a round trip = one BUY then SELL)
    roundTrips:      { type: Number, default: 0 },
    wins:            { type: Number, default: 0 },
    losses:          { type: Number, default: 0 },
    cumulativePnl:   { type: Number, default: 0 }, // realized USDT profit

    // persistent execution lock (guards against overlapping swaps)
    isExecuting:     { type: Boolean, default: false },
    lockedAt:        { type: Date,   default: null },

    dryRun:          { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = botConn.model('BotState', BotStateSchema, 'bot_state');
