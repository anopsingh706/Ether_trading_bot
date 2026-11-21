// dashboard/server.js — web dashboard for the live bot (npm run dashboard)
// ─────────────────────────────────────────────────────────────────────────────
// Read the bot's state + trades from MongoDB, and send it commands (pause /
// resume / emergency sell / reset breaker) through the same DB document — the bot
// carries them out itself. This process NEVER holds the wallet key (deleted from
// the environment below) and never touches the bot process.
//
// Security: listens on 127.0.0.1 only (Caddy in front provides HTTPS); scrypt-
// hashed passwords; HMAC-signed HttpOnly/Secure/SameSite=Strict session cookie;
// CSRF token + Origin check on every command; login rate limiting; strict CSP.
// Roles: admin (can control) and viewer (read-only).
// ─────────────────────────────────────────────────────────────────────────────
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
// The dashboard must never be able to sign a transaction. Set (not delete) to empty:
// dotenv never overrides a variable that already exists, so later .env loads (config.js)
// can't bring the key back.
process.env.PRIVATE_KEY = '';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ethers } = require('ethers');
const cfg = require('../bot/config');
const botConn = require('../bot/db');
const BotState = require('../bot/models/BotState');
const BotOrder = require('../bot/models/BotOrder');
const { STATE_KEY } = require('../bot/state');
const circuitBreaker = require('../bot/circuitBreaker');
const rpc = require('../bot/rpc');
const { verifyPassword } = require('./passwords');

const PORT = Number(process.env.DASH_PORT || 8080);
const HOST = process.env.DASH_HOST || '127.0.0.1';
const SECRET = (process.env.DASH_SECRET || '').trim();
const SECURE_COOKIE = String(process.env.DASH_COOKIE_SECURE || 'true').toLowerCase() !== 'false';
const SESSION_H = Number(process.env.DASH_SESSION_HOURS || 12);
const USERS = [
  { role: 'admin',  name: (process.env.DASH_ADMIN_USER || '').trim(),  hash: (process.env.DASH_ADMIN_HASH || '').trim() },
  { role: 'viewer', name: (process.env.DASH_VIEWER_USER || '').trim(), hash: (process.env.DASH_VIEWER_HASH || '').trim() },
].filter((u) => u.name && u.hash);

if (SECRET.length < 32) { console.error('DASH_SECRET missing or shorter than 32 chars — run: npm run dash:user (it prints one)'); process.exit(1); }
if (!USERS.length) { console.error('No dashboard users — run: npm run dash:user'); process.exit(1); }

// ── sessions (stateless, signed) ──────────────────────────────────────────────
const b64u = (b) => Buffer.from(b).toString('base64url');
const sign = (data) => crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
function makeSession(user) {
  const body = b64u(JSON.stringify({ u: user.name, r: user.role, exp: Date.now() + SESSION_H * 3600000, c: crypto.randomBytes(18).toString('base64url') }));
  return `${body}.${sign(body)}`;
}
function readSession(req) {
  const m = /(?:^|;\s*)eds=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return null;
  const [body, sig] = m[1].split('.');
  if (!body || !sig) return null;
  const good = sign(body);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  try {
    const s = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (Date.now() > s.exp || !USERS.some((u) => u.name === s.u && u.role === s.r)) return null; // removed user → logged out
    return s;
  } catch { return null; }
}
const cookie = (v, maxAgeS) => `eds=${v}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${maxAgeS}${SECURE_COOKIE ? '; Secure' : ''}`;

// ── login rate limit: 5 failures per IP per 15 min ────────────────────────────
const fails = new Map();
const clientIp = (req) => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress; // only Caddy can reach us (127.0.0.1)
function limited(ip) {
  const f = fails.get(ip);
  if (!f) return false;
  if (Date.now() - f.first > 15 * 60000) { fails.delete(ip); return false; }
  return f.n >= 5;
}
function recordFail(ip) { const f = fails.get(ip); if (!f || Date.now() - f.first > 15 * 60000) fails.set(ip, { n: 1, first: Date.now() }); else f.n++; }

// ── helpers ───────────────────────────────────────────────────────────────────
const SEC_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
  // 'same-origin' (not 'no-referrer'): with no-referrer browsers send "Origin: null" on
  // form posts, which made the login form fail the origin check below.
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store',
};
function send(res, code, body, type = 'text/html; charset=utf-8', extra = {}) {
  res.writeHead(code, { ...SEC_HEADERS, 'Content-Type': type, ...extra });
  res.end(body);
}
const json = (res, code, obj) => send(res, code, JSON.stringify(obj), 'application/json; charset=utf-8');
function readBody(req, max = 4096) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > max) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => resolve(d));
    req.on('error', reject);
  });
}
// A request is accepted only if the browser says it came from this same site:
// Sec-Fetch-Site (set by the browser, can't be forged by another site) or a matching Origin.
function sameOrigin(req) {
  const site = req.headers['sec-fetch-site'];
  if (site) return site === 'same-origin' || site === 'none';   // 'none' = typed URL / bookmark
  const o = req.headers.origin;
  return !o || o === `https://${req.headers.host}` || o === `http://${req.headers.host}`;
}
const PUB = path.join(__dirname, 'public');
const file = (n) => fs.readFileSync(path.join(PUB, n));

// ── data ──────────────────────────────────────────────────────────────────────
let walletCache = { at: 0, v: null };
async function wallet(price) {
  if (cfg.SIM_MODE || !cfg.ADMIN_WALLET) return null;
  if (Date.now() - walletCache.at < 30000) return walletCache.v;
  try {
    const p = rpc.provider();
    const erc = ['function balanceOf(address) view returns (uint256)'];
    const [u, w, n] = await Promise.all([
      new ethers.Contract(cfg.USDC_ADDRESS, erc, p).balanceOf(cfg.ADMIN_WALLET),
      new ethers.Contract(cfg.WETH_ADDRESS, erc, p).balanceOf(cfg.ADMIN_WALLET),
      p.getBalance(cfg.ADMIN_WALLET),
    ]);
    const usdc = Number(ethers.formatUnits(u, 6)), weth = Number(ethers.formatEther(w)), native = Number(ethers.formatEther(n));
    walletCache = { at: Date.now(), v: { usdc, weth, native, total: price ? usdc + weth * price : null } };
  } catch { /* keep the last value */ walletCache.at = Date.now(); }
  return walletCache.v;
}

async function status() {
  const s = await BotState.findOne({ key: STATE_KEY }).lean();
  if (!s) return { error: `no bot state "${STATE_KEY}" yet — start the bot once` };
  const orders = await BotOrder.find({}).sort({ createdAt: -1 }).limit(40).lean();
  const midnight = new Date(); midnight.setUTCHours(0, 0, 0, 0);
  const today = orders.filter((o) => o.side === 2 && new Date(o.createdAt) >= midnight);
  const ageS = s.hbAt ? (Date.now() - new Date(s.hbAt).getTime()) / 1000 : null;
  const alive = !s.hbStopped && ageS != null && ageS < 45;
  const price = s.hbPrice || null;
  return {
    now: new Date(), chain: cfg.CHAIN_NAME, dex: cfg.DEX_NAME, mode: cfg.SIM_MODE ? 'sim' : 'live', explorer: cfg.SCAN_TX_URL,
    wallet: cfg.SIM_MODE ? null : cfg.ADMIN_WALLET,
    bot: { alive, halted: !!s.hbHalted, stopped: !!s.hbStopped, lastSeenS: ageS, version: s.hbVersion, exitMode: s.hbExitMode, stale: !!s.hbStale, line: s.hbLine, lastError: s.hbLastError },
    price,
    position: s.position, entryPrice: s.entryPrice, entryWeth: s.entryWeth, entryUsdt: s.entryUsdt, entryAt: s.entryAt,
    unrealized: s.position === 'IN_WETH' && price && s.entryWeth && s.entryUsdt ? price * s.entryWeth - s.entryUsdt : null,
    pnl: { all: s.cumulativePnl || 0, today: today.reduce((a, o) => a + (o.profit || 0), 0), todayTrades: today.length, wins: s.wins || 0, losses: s.losses || 0, roundTrips: s.roundTrips || 0 },
    breaker: { enabled: cfg.CB_ENABLED, tripped: !!s.cbTripped, reason: s.cbReason, detail: s.cbDetail, at: s.cbTrippedAt, text: circuitBreaker.status(s),
      limits: { consec: cfg.CB_MAX_CONSEC_LOSSES, daily: cfg.CB_MAX_DAILY_LOSS_USD, drawdown: cfg.CB_MAX_DRAWDOWN_USD } },
    control: { paused: !!s.ctlPaused, sellPending: !!(s.ctlSellReqAt && (!s.ctlSellDoneAt || new Date(s.ctlSellReqAt) > new Date(s.ctlSellDoneAt))), sellNote: s.ctlSellNote,
      cbResetPending: !!(s.ctlCbResetReqAt && (!s.ctlCbResetDoneAt || new Date(s.ctlCbResetReqAt) > new Date(s.ctlCbResetDoneAt))),
      unhaltPending: !!(s.ctlUnhaltReqAt && (!s.ctlUnhaltDoneAt || new Date(s.ctlUnhaltReqAt) > new Date(s.ctlUnhaltDoneAt))) },
    triggers: {
      mode: s.ctlTriggerMode === 'atr' || s.ctlTriggerMode === 'manual' ? s.ctlTriggerMode : cfg.TRIGGER_MODE,
      entryUsd: s.ctlEntryUsd != null ? s.ctlEntryUsd : cfg.TRIGGER_ENTRY_USD,
      exitUsd: s.ctlExitUsd != null ? s.ctlExitUsd : cfg.TRIGGER_EXIT_USD,
      inForce: { entry: s.hbEntryDelta, exit: s.hbExitDelta },         // what the bot is using right now
      min: cfg.TRIGGER_MIN_USD, max: cfg.TRIGGER_MAX_USD,
    },
    log: (s.ctlLog || []).slice(-20).reverse(),
    trades: orders.map((o) => ({ at: o.createdAt, side: o.side === 1 ? 'BUY' : 'SELL', price: o.realized_rate, usdc: o.amount, weth: o.quantity, profit: o.profit, pct: o.profit_pct, reason: o.exit_reason, gas: o.gas_fee, tx: o.tx_hash })),
    wallet_balance: await wallet(price),
  };
}

async function command(user, action, body) {
  const now = new Date();
  const set = {};
  if (action === 'pause') set.ctlPaused = true;
  else if (action === 'resume') set.ctlPaused = false;
  else if (action === 'sell') { if (body.confirm !== 'SELL') return 'type SELL to confirm'; set.ctlSellReqAt = now; }
  else if (action === 'cbreset') set.ctlCbResetReqAt = now;
  else if (action === 'unhalt') set.ctlUnhaltReqAt = now;
  else if (action === 'triggers') {
    const mode = body.mode === 'atr' ? 'atr' : body.mode === 'manual' ? 'manual' : null;
    const val = (v) => { const n = Math.round(Number(v) * 100) / 100; return isFinite(n) && n >= cfg.TRIGGER_MIN_USD && n <= cfg.TRIGGER_MAX_USD ? n : null; };
    const e = val(body.entryUsd), x = val(body.exitUsd);
    if (!mode) return 'mode must be manual or atr';
    if (mode === 'manual' && (e == null || x == null)) return `trigger must be between $${cfg.TRIGGER_MIN_USD} and $${cfg.TRIGGER_MAX_USD}`;
    set.ctlTriggerMode = mode;
    if (mode === 'manual') { set.ctlEntryUsd = e; set.ctlExitUsd = x; }
    action = mode === 'atr' ? 'trigger → AUTO (ATR)' : `trigger → buy +$${e.toFixed(2)} / sell −$${x.toFixed(2)}`;
  }
  else return 'unknown action';
  await BotState.updateOne({ key: STATE_KEY }, { $set: set, $push: { ctlLog: { $each: [{ at: now, by: user.u, action }], $slice: -50 } } });
  console.log(`[dashboard] ${now.toISOString()} ${user.u} → ${action}`);
  return null;
}

// ── routes ────────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const sess = readSession(req);

    if (req.method === 'GET' && url.pathname === '/app.js')  return send(res, 200, file('app.js'), 'text/javascript; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/app.css') return send(res, 200, file('app.css'), 'text/css; charset=utf-8');

    if (req.method === 'POST' && url.pathname === '/login') {
      const ip = clientIp(req);
      if (!sameOrigin(req)) return send(res, 403, 'bad origin', 'text/plain');
      if (limited(ip)) return send(res, 429, file('login.html').toString().replace('<!--MSG-->', '<p class="err">Too many attempts — wait 15 minutes.</p>'));
      const f = new URLSearchParams(await readBody(req));
      const user = USERS.find((u) => u.name === (f.get('user') || ''));
      const ok = await verifyPassword(f.get('pass') || '', user ? user.hash : null); // constant work even for unknown users
      if (!user || !ok) {
        recordFail(ip);
        console.warn(`[dashboard] failed login for "${String(f.get('user')).slice(0, 40)}" from ${ip}`);
        return send(res, 401, file('login.html').toString().replace('<!--MSG-->', '<p class="err">Wrong username or password.</p>'));
      }
      fails.delete(ip);
      console.log(`[dashboard] ${user.name} (${user.role}) logged in from ${ip}`);
      return send(res, 303, '', 'text/plain', { 'Set-Cookie': cookie(makeSession(user), SESSION_H * 3600), Location: '/' });
    }
    if (req.method === 'POST' && url.pathname === '/logout') {
      if (!sameOrigin(req)) return send(res, 403, 'bad origin', 'text/plain');
      return send(res, 303, '', 'text/plain', { 'Set-Cookie': cookie('', 0), Location: '/' });
    }

    if (!sess) {
      if (url.pathname.startsWith('/api/')) return json(res, 401, { error: 'login required' });
      return send(res, 200, file('login.html'));
    }

    if (req.method === 'GET' && url.pathname === '/') return send(res, 200, file('index.html'));
    if (req.method === 'GET' && url.pathname === '/api/status') {
      return json(res, 200, { ...(await status()), me: { user: sess.u, role: sess.r, csrf: sess.c } });
    }
    if (req.method === 'POST' && url.pathname === '/api/control') {
      if (sess.r !== 'admin') return json(res, 403, { error: 'viewers cannot control the bot' });
      if (!sameOrigin(req) || req.headers['x-csrf'] !== sess.c) return json(res, 403, { error: 'bad request origin' });
      let body = {};
      try { body = JSON.parse(await readBody(req) || '{}'); } catch { return json(res, 400, { error: 'bad json' }); }
      const err = await command(sess, String(body.action || ''), body);
      return err ? json(res, 400, { error: err }) : json(res, 200, { ok: true });
    }
    return send(res, 404, 'not found', 'text/plain');
  } catch (e) {
    console.error('[dashboard] error:', e.message);
    return json(res, 500, { error: 'server error' });
  }
});

if (process.env.PRIVATE_KEY) { console.error('refusing to start: PRIVATE_KEY is present in the dashboard process'); process.exit(1); }

botConn.asPromise().then(() => {
  server.listen(PORT, HOST, () => console.log(`📊 dashboard on http://${HOST}:${PORT} — state "${STATE_KEY}" (${cfg.CHAIN_NAME}${cfg.SIM_MODE ? ', simulation' : ', LIVE'}) — users: ${USERS.map((u) => `${u.name}(${u.role})`).join(', ')}`));
});
