// bot/db.js
// ─────────────────────────────────────────────────────────────────────────────
// A DEDICATED mongoose connection for the bot's sandbox database.
// Using createConnection (not the global mongoose.connect) guarantees the bot's
// reads/writes go to BOT_DB_URL and never to the production connection that
// server.js opens. All bot models are bound to THIS connection.
// ─────────────────────────────────────────────────────────────────────────────
const mongoose = require('mongoose');
const { BOT_DB_URL } = require('./config');

const botConn = mongoose.createConnection(BOT_DB_URL);

botConn.on('connected', () => console.log(`✅ [bot-db] connected → db "${botConn.name}"`));
botConn.on('error', (e) => console.error('❌ [bot-db] connection error:', e.message));
botConn.on('disconnected', () => console.warn('⚠️ [bot-db] disconnected'));

module.exports = botConn;
