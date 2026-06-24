// bot/models/BotOrder.js
// ─────────────────────────────────────────────────────────────────────────────
// Revised order schema (fixes from the SRS):
//   • order_code is a NUMBER from an atomic counter (no NaN / String coercion bug)
//   • rate / realized_rate = the ACTUAL achieved price (USDT per WETH), not a guess
//   • route, gst_applied, trigger_price, anchor_price, tx_hash, dry_run all persist
// Convention (both sides): realized_rate is always USDT per WETH.
//   BUY  : amount = USDT spent,    quantity = WETH received
//   SELL : amount = USDT received, quantity = WETH sold
// ─────────────────────────────────────────────────────────────────────────────
const { Schema } = require('mongoose');
const botConn = require('../db');

const BotOrderSchema = new Schema(
  {
    order_code:     { type: Number, required: true, unique: true, index: true },
    side:           { type: Number, enum: [1, 2], required: true }, // 1 = buy, 2 = sell
    currency1:      { type: String },
    currency2:      { type: String },
    amount:         { type: Number, min: 0 }, // USDT leg
    quantity:       { type: Number, min: 0 }, // WETH leg
    realized_rate:  { type: Number, min: 0 }, // USDT per WETH actually achieved
    rate:           { type: Number, min: 0 }, // mirror of realized_rate (compat)
    chainlink_rate: { type: Number, default: 0 }, // reference only
    trigger_price:  { type: Number },         // the tick price that fired the trade
    anchor_price:   { type: Number },         // trailing peak/bottom that triggered it
    profit:         { type: Number, default: null }, // NET USDC profit on a SELL, AFTER gas (round trip)
    profit_gross:   { type: Number, default: null }, // gross USDC profit before gas
    profit_pct:     { type: Number, default: null }, // % return on a SELL (net)
    exit_reason:    { type: String, default: null }, // why a SELL fired: profit-take | stop-loss | trend-down
    slippage_bps:   { type: Number, default: 0 },    // how far the fill deviated from the decision price (OD-5)
    gas_fee:        { type: Number, default: 0 },
    gst_charge:     { type: Number, default: 0 },
    gst_applied:    { type: Boolean, default: true },
    special:        { type: Number, default: 0 },
    route:          { type: String, default: 'AMM' },
    dry_run:        { type: Boolean, default: false },
    tx_hash:        { type: String, default: null },
    status:         { type: Number, default: 1 },
  },
  { timestamps: true }
);

module.exports = botConn.model('BotOrder', BotOrderSchema, 'bot_orders');
