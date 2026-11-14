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
    // IN_SWING = campaign open but holding cash mid swing-repair (Layer 2, UW_SWING)
    position:        { type: String, enum: ['IN_USDT', 'IN_WETH', 'IN_SWING'], default: 'IN_USDT' },
    anchorPrice:     { type: Number, default: null },
    anchorUpdatedAt: { type: Date,   default: null },
    lastActionPrice: { type: Number, default: null },
    lastActionAt:    { type: Date,   default: null },
    threshold:       { type: Number, default: 0.05 },

    // simulation (paper) virtual balances + accounting (BOT_SIM mode only)
    simUsdt:         { type: Number, default: 0 },
    simWeth:         { type: Number, default: 0 },
    simGasUsd:       { type: Number, default: 0 },    // cumulative simulated gas (USD)
    txCount:         { type: Number, default: 0 },    // total swaps executed (BUY + SELL)

    // cost basis of the CURRENTLY OPEN position (set on BUY, cleared on SELL)
    entryUsdt:       { type: Number, default: null }, // USDT spent to enter
    entryWeth:       { type: Number, default: null }, // WETH bought
    entryPrice:      { type: Number, default: null }, // realized entry rate
    entryGas:        { type: Number, default: 0 },    // gas (USD) paid on the entry leg
    entryAt:         { type: Date,   default: null },

    // Layer 2 swing-repair state (campaign-scoped; cleared on entry/exit)
    swingCash:       { type: Number, default: null }, // USDC held while IN_SWING
    swingSellPrice:  { type: Number, default: null }, // realized rate of the last swing-sell (failsafe reference)
    swingCount:      { type: Number, default: 0 },    // swing cycles this campaign (cap = SW_MAX)
    lastSwingAt:     { type: Date,   default: null }, // cooldown reference

    // running performance metrics (a round trip = one BUY then SELL)
    roundTrips:      { type: Number, default: 0 },
    wins:            { type: Number, default: 0 },
    losses:          { type: Number, default: 0 },
    cumulativePnl:   { type: Number, default: 0 }, // realized USDT profit

    // circuit breaker (see bot/circuitBreaker.js)
    cbConsecLosses:  { type: Number,  default: 0 },
    cbDay:           { type: String,  default: null },  // UTC day 'YYYY-MM-DD' of cbDayPnl
    cbDayPnl:        { type: Number,  default: 0 },
    cbPeakPnl:       { type: Number,  default: 0 },     // best cumulativePnl seen (drawdown reference)
    cbTripped:       { type: Boolean, default: false },
    cbReason:        { type: String,  default: null },  // 'consecutive' | 'daily' | 'drawdown'
    cbDetail:        { type: String,  default: null },
    cbTrippedAt:     { type: Date,    default: null },

    // dashboard: heartbeat written by the bot (bot/control.js)
    hbAt:            { type: Date,    default: null },
    hbStopped:       { type: Boolean, default: false },
    hbPid:           { type: Number,  default: null },
    hbVersion:       { type: String,  default: null },
    hbMode:          { type: String,  default: null },
    hbChain:         { type: String,  default: null },
    hbExitMode:      { type: String,  default: null },
    hbPrice:         { type: Number,  default: null },
    hbStale:         { type: Boolean, default: false },
    hbLine:          { type: String,  default: null },
    hbLastError:     { type: Schema.Types.Mixed, default: null },
    hbHalted:        { type: Boolean, default: false },  // slippage halt active (engine ignores prices)
    // dashboard: commands written by the dashboard, carried out by the bot
    ctlPaused:        { type: Boolean, default: false },
    ctlSellReqAt:     { type: Date,    default: null },
    ctlSellDoneAt:    { type: Date,    default: null },
    ctlSellNote:      { type: String,  default: null },
    ctlCbResetReqAt:  { type: Date,    default: null },
    ctlCbResetDoneAt: { type: Date,    default: null },
    ctlUnhaltReqAt:   { type: Date,    default: null },
    ctlUnhaltDoneAt:  { type: Date,    default: null },
    ctlLog:           { type: [Schema.Types.Mixed], default: [] }, // audit: who did what, when (last 50)

    // persistent execution lock (guards against overlapping swaps)
    isExecuting:     { type: Boolean, default: false },
    lockedAt:        { type: Date,   default: null },

    dryRun:          { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = botConn.model('BotState', BotStateSchema, 'bot_state');
