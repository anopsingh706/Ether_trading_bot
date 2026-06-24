// bot/models/Counter.js
// ─────────────────────────────────────────────────────────────────────────────
// Atomic sequence generator for order_code. findByIdAndUpdate($inc) is atomic at
// the DB level, so codes are always unique and gap-tolerant even under concurrency.
// ─────────────────────────────────────────────────────────────────────────────
const { Schema } = require('mongoose');
const botConn = require('../db');

const CounterSchema = new Schema({
  _id: { type: String },
  seq: { type: Number, default: 0 },
});

CounterSchema.statics.next = async function (id) {
  const doc = await this.findByIdAndUpdate(
    id,
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return doc.seq;
};

module.exports = botConn.model('Counter', CounterSchema, 'bot_counters');
