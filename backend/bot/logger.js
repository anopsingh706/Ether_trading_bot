// bot/logger.js
// ─────────────────────────────────────────────────────────────────────────────
// Output model the user asked for:
//   • ONE bordered TRADE TABLE. Each executed trade is a new row appended at the
//     bottom. The table never gets interrupted by status text.
//   • Liveness ("waiting for…", last price, PnL) is a SINGLE line that updates
//     in place at the very bottom (TTY only) — it is not a table row.
//   • When output is piped/redirected (non-TTY), the live line is suppressed so
//     log files contain only the clean table.
// ─────────────────────────────────────────────────────────────────────────────

function fmt(n, d = 2) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
  return Number(n).toFixed(d);
}
function signed(n, d = 2) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
  const v = Number(n);
  return (v >= 0 ? '+' : '') + v.toFixed(d);
}
const hhmmss = (date = new Date()) => date.toTimeString().slice(0, 8);
const padL = (v, w) => String(v).padStart(w);
const padR = (v, w) => String(v).padEnd(w);

// Trade table columns (content width + alignment)
const COLS = [
  { h: '#',       w: 3,  a: 'r' },
  { h: 'Time',    w: 8,  a: 'l' },
  { h: 'Side',    w: 4,  a: 'l' },
  { h: 'Price',   w: 9,  a: 'r' },
  { h: 'Peak/Bot',w: 9,  a: 'r' },
  { h: 'USDT',    w: 10, a: 'r' },
  { h: 'WETH',    w: 10, a: 'r' },
  { h: 'Net P/L', w: 8,  a: 'r' },
  { h: 'P/L %',   w: 7,  a: 'r' },
  { h: 'Cum P/L', w: 9,  a: 'r' },
];
const cell = (v, c) => (c.a === 'r' ? padL(v, c.w) : padR(v, c.w));
const segLine = (ch, j) => COLS.map((c) => ch.repeat(c.w + 2)).join(j);
const TOP = '┌' + segLine('─', '┬') + '┐';
const MID = '├' + segLine('─', '┼') + '┤';
const BOT = '└' + segLine('─', '┴') + '┘';
const rowStr = (vals) => '│' + vals.map((v, i) => ' ' + cell(String(v), COLS[i]) + ' ').join('│') + '│';

// ── live status line (in-place, TTY only) ───────────────────────────────────
let _statusShown = false;
let _lastStatus = '';
let _statusRows = 1; // how many terminal rows the currently-shown status wraps across
const _termWidth = () => process.stdout.columns || 80;

// A plain '\r' only rewinds the cursor to the start of the CURRENT row — if the last
// status line wrapped onto 2+ rows (narrow terminal, or npm's spawned shell misreporting
// its width), that only erases the last row and leaves the earlier ones stuck on screen
// forever, so the line appears to grow instead of update in place. Move up to the first
// wrapped row, then erase everything from there to the end of the screen.
function _clearStatus() {
  if (process.stdout.isTTY && _statusShown) {
    if (_statusRows > 1) process.stdout.write(`\x1b[${_statusRows - 1}A`);
    process.stdout.write('\r\x1b[0J');
    _statusShown = false;
  }
}
function renderStatus(text) {
  _lastStatus = text;
  if (!process.stdout.isTTY) return;       // never pollute piped/redirected logs
  _clearStatus();
  process.stdout.write(text);
  _statusRows = Math.max(1, Math.ceil(text.length / _termWidth()));
  _statusShown = true;
}
function statusLineNonTTY(text) { console.log(text); } // sparse liveness for log files

// Status-aware log line: clear the pinned status line, print, then restore it.
// Use this for ANY runtime output (tx flow, errors) so it never collides with
// the in-place status line / breaks the table.
function line(...args) {
  _clearStatus();
  console.log(...args);
  if (process.stdout.isTTY && _lastStatus) renderStatus(_lastStatus);
}

// ── table ────────────────────────────────────────────────────────────────────
function tradeTableHeader() {
  console.log('\n📒 TRADE LEDGER — one row per executed trade (newest at the bottom)');
  console.log(TOP);
  console.log(rowStr(COLS.map((c) => c.h)));
  console.log(MID);
}

function printTrade(t) {
  _clearStatus();
  console.log(rowStr([
    t.code,
    hhmmss(t.time),
    t.side,
    fmt(t.trigger),
    fmt(t.extreme),
    fmt(t.usdt),
    fmt(t.weth, 6),
    signed(t.profit),
    t.profitPct == null ? '—' : signed(t.profitPct) + '%',
    signed(t.cumPnl),
  ]));
  if (process.stdout.isTTY && _lastStatus) renderStatus(_lastStatus);
}

function tableFooter() { _clearStatus(); console.log(BOT); }

function summary(d) {
  _clearStatus();
  const winRate = d.roundTrips ? ((d.wins / d.roundTrips) * 100).toFixed(1) : '0.0';
  console.log('\n╔═ SESSION SUMMARY ' + '═'.repeat(32));
  console.log(`  Round trips  : ${d.roundTrips}  (wins ${d.wins} / losses ${d.losses})`);
  console.log(`  Win rate     : ${winRate}%`);
  console.log(`  Realized PnL : ${signed(d.realized)} USDT`);
  console.log('╚' + '═'.repeat(50));
}

// edge-case notices: clear the live line, print, then restore it
function note(m) { _clearStatus(); console.log('ℹ️  ' + m); if (process.stdout.isTTY && _lastStatus) renderStatus(_lastStatus); }
function warn(m) { _clearStatus(); console.log('⛔ ' + m); if (process.stdout.isTTY && _lastStatus) renderStatus(_lastStatus); }

module.exports = {
  tradeTableHeader, printTrade, tableFooter, renderStatus, statusLineNonTTY, line,
  summary, note, warn, fmt, signed,
};
