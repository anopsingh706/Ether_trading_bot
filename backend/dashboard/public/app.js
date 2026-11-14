// dashboard/public/app.js — polls /api/status every 5s and renders it.
// All data is written with textContent (never innerHTML), so nothing in the data can inject markup.
(() => {
  const $ = (id) => document.getElementById(id);
  const usd = (n, sign = true) => (n == null ? '—' : (sign ? (n >= 0 ? '+' : '−') : '') + '$' + Math.abs(n).toFixed(2));
  const cls = (el, c) => { el.classList.remove('good', 'bad', 'warn'); if (c) el.classList.add(c); };
  const ago = (s) => (s == null ? 'never' : s < 90 ? `${Math.round(s)}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${(s / 3600).toFixed(1)} h ago`);
  const time = (d) => new Date(d).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  let csrf = null, data = null;
  // trigger editor: local draft, so the 5 s refresh doesn't overwrite what you're changing
  let tDraft = null, tDirty = false;
  const STEP = 0.25;

  function render(d) {
    data = d;
    if (d.error) { $('botState').textContent = d.error; return; }
    csrf = d.me.csrf;
    $('chain').textContent = `${d.chain} · ${d.mode === 'live' ? 'LIVE' : 'SIM'}`;
    $('me').textContent = `${d.me.user} (${d.me.role})`;
    $('controls').hidden = d.me.role !== 'admin';
    if (d.wallet) { $('scan').href = d.explorer.replace('/tx/', '/address/') + d.wallet; } else { $('scan').hidden = true; }

    // bot
    const b = d.bot;
    const st = !b.alive ? (b.stopped ? 'Stopped' : 'Not responding') : b.halted ? 'Halted' : d.control.paused ? 'Paused' : 'Running';
    $('botState').textContent = (!b.alive ? '■ ' : b.halted ? '🛑 ' : d.control.paused ? '⏸ ' : '● ') + st;
    cls($('botState'), !b.alive || b.halted ? 'bad' : d.control.paused ? 'warn' : 'good');
    $('botSub').textContent = `last heartbeat ${ago(b.lastSeenS)} · v${b.version || '?'} · exit ${b.exitMode || '?'}`;

    // price
    $('price').textContent = d.price ? '$' + d.price.toFixed(2) : '—';
    $('stale').textContent = b.stale ? '⚠ price feed stale — trading paused until it returns' : `${d.dex} pool`;
    cls($('stale'), b.stale ? 'warn' : null);

    // position
    if (d.position === 'IN_WETH') {
      $('pos').textContent = `Holding ${(d.entryWeth || 0).toFixed(5)} WETH`;
      $('posSub').textContent = `entry $${(d.entryPrice || 0).toFixed(2)} · unrealized ${usd(d.unrealized)}`;
      cls($('posSub'), d.unrealized == null ? null : d.unrealized >= 0 ? 'good' : 'bad');
    } else {
      $('pos').textContent = 'In cash';
      $('posSub').textContent = 'waiting for a buy signal';
      cls($('posSub'), null);
    }

    // pnl
    $('pnlAll').textContent = usd(d.pnl.all);
    cls($('pnlAll'), d.pnl.all > 0 ? 'good' : d.pnl.all < 0 ? 'bad' : null);
    $('pnlSub').textContent = `today ${usd(d.pnl.today)} (${d.pnl.todayTrades} trades) · W${d.pnl.wins}/L${d.pnl.losses}`;

    // wallet
    const w = d.wallet_balance;
    $('wTotal').textContent = w && w.total != null ? '$' + w.total.toFixed(2) : d.mode === 'sim' ? 'simulation' : '—';
    $('wSub').textContent = w ? `${w.usdc.toFixed(2)} USDC · ${w.weth.toFixed(5)} WETH · gas ${w.native.toFixed(5)} ETH${w.native < 0.0002 ? ' ⚠ low' : ''}` : '';

    // breaker
    const cb = d.breaker;
    $('cb').textContent = !cb.enabled ? 'Off' : cb.tripped ? '⛔ Tripped' : 'OK';
    cls($('cb'), !cb.enabled ? 'warn' : cb.tripped ? 'bad' : 'good');
    $('cbSub').textContent = cb.tripped ? `${cb.detail}${cb.reason === 'daily' ? ' — clears at 00:00 UTC' : ''}` : cb.text.replace(/^ok — /, '');

    // banner
    const bn = $('banner');
    let msg = null, level = 'warn';
    if (!b.alive) { msg = b.stopped ? 'The bot is stopped.' : `The bot is not responding (last heartbeat ${ago(b.lastSeenS)}). Check the server: pm2 status`; level = 'bad'; }
    else if (b.halted) { msg = '🛑 Trading HALTED after a suspicious fill — the bot is ignoring prices. Check the last trade on the explorer, then press "Clear halt".'; level = 'bad'; }
    else if (d.control.sellPending) msg = '🚨 Emergency sell in progress…';
    else if (cb.tripped) { msg = `⛔ Circuit breaker tripped: ${cb.detail}. New buys are stopped.`; level = 'bad'; }
    else if (d.control.paused) msg = '⏸ Paused from the dashboard — no new buys. Press Resume to trade again.';
    bn.hidden = !msg; bn.textContent = msg || ''; bn.className = 'banner ' + level;

    // controls state
    $('bPause').disabled = d.control.paused;
    $('bResume').disabled = !d.control.paused;
    $('bCb').disabled = !cb.tripped || d.control.cbResetPending;
    $('bSell').disabled = d.control.sellPending;
    $('bUnhalt').hidden = !b.halted;
    $('bUnhalt').disabled = d.control.unhaltPending;

    // trigger
    const T = d.triggers; const admin = d.me.role === 'admin';
    if (!tDirty || !tDraft) tDraft = { mode: T.mode, entryUsd: T.entryUsd, exitUsd: T.exitUsd };
    $('tManual').checked = tDraft.mode === 'manual'; $('tAtr').checked = tDraft.mode === 'atr';
    $('tEntry').textContent = '$' + tDraft.entryUsd.toFixed(2); $('tExit').textContent = '$' + tDraft.exitUsd.toFixed(2);
    for (const el of document.querySelectorAll('[data-step], #tManual, #tAtr')) el.disabled = !admin || (!!el.dataset.step && tDraft.mode === 'atr');
    $('tSave').hidden = !admin; $('tSave').disabled = !tDirty;
    const inf = T.inForce;
    $('tInfo').textContent = (T.mode === 'atr' ? 'Auto: the trigger follows volatility (ATR). ' : '') +
      (inf && inf.entry != null ? `In force now: buy +$${inf.entry.toFixed(2)} off the low · sell −$${inf.exit.toFixed(2)} off the peak (sells only above break-even).` : 'In force now: waiting for the bot.') +
      (tDirty ? ' — unsaved changes' : '');

    // status line + error
    $('line').textContent = b.line || '—';
    $('lastErr').textContent = b.lastError ? `last swap error (${time(b.lastError.at)}): ${b.lastError.side} — ${b.lastError.msg}` : '';

    // trades
    const tb = $('trades').querySelector('tbody');
    tb.replaceChildren();
    for (const t of d.trades) {
      const tr = document.createElement('tr');
      const td = (text, c) => { const e = document.createElement('td'); e.textContent = text; if (c) e.className = c; tr.appendChild(e); return e; };
      td(time(t.at));
      td(t.side, t.side === 'BUY' ? 'good' : '');
      td(t.price ? '$' + t.price.toFixed(2) : '—', 'r');
      td(t.usdc != null ? t.usdc.toFixed(2) : '—', 'r');
      td(t.weth != null ? t.weth.toFixed(5) : '—', 'r');
      const p = td(t.side === 'SELL' && t.profit != null ? `${usd(t.profit)}${t.pct != null ? ` (${t.pct.toFixed(2)}%)` : ''}` : '', 'r');
      if (t.side === 'SELL' && t.profit != null) p.classList.add(t.profit >= 0 ? 'good' : 'bad');
      td(t.reason || '');
      const cell = td('');
      if (t.tx) { const a = document.createElement('a'); a.href = d.explorer + t.tx; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'view'; cell.appendChild(a); }
      tb.appendChild(tr);
    }
    $('noTrades').hidden = d.trades.length > 0;

    // activity
    const log = $('log');
    log.replaceChildren(...(d.log.length ? d.log : [{ at: null, by: '', action: 'no dashboard actions yet' }]).map((l) => {
      const li = document.createElement('li');
      li.textContent = l.at ? `${time(l.at)} — ${l.by}: ${l.action}` : l.action;
      return li;
    }));
    $('updated').textContent = 'updated ' + new Date().toLocaleTimeString();
  }

  async function refresh() {
    try {
      const r = await fetch('/api/status', { credentials: 'same-origin' });
      if (r.status === 401) { location.reload(); return; }
      render(await r.json());
    } catch { $('updated').textContent = 'connection problem — retrying…'; }
  }

  async function control(action, extra = {}) {
    $('ctlMsg').textContent = 'sending…';
    try {
      const r = await fetch('/api/control', { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF': csrf }, body: JSON.stringify({ action, ...extra }) });
      const j = await r.json();
      $('ctlMsg').textContent = j.ok ? 'Sent — the bot applies it within a few seconds.' : 'Error: ' + j.error;
      cls($('ctlMsg'), j.ok ? 'good' : 'bad');
    } catch { $('ctlMsg').textContent = 'Not sent — your internet connection dropped (or the server is restarting). Check your connection and press again.'; cls($('ctlMsg'), 'bad'); }
    refresh();
  }

  document.addEventListener('DOMContentLoaded', () => {
    $('bPause').addEventListener('click', () => control('pause'));
    $('bResume').addEventListener('click', () => control('resume'));
    $('bCb').addEventListener('click', () => control('cbreset'));
    $('bUnhalt').addEventListener('click', () => control('unhalt'));
    const bump = (which, dir) => {
      if (!tDraft || !data) return;
      const k = which === 'entry' ? 'entryUsd' : 'exitUsd';
      const v = Math.round((tDraft[k] + (dir === '+' ? STEP : -STEP)) * 100) / 100;
      tDraft[k] = Math.min(data.triggers.max, Math.max(data.triggers.min, v)); tDirty = true; render(data);
    };
    for (const b of document.querySelectorAll('[data-step]')) b.addEventListener('click', () => { const [w, dir] = b.dataset.step.split(':'); bump(w, dir); });
    for (const r of [$('tManual'), $('tAtr')]) r.addEventListener('change', () => { if (tDraft) { tDraft.mode = r.value; tDirty = true; render(data); } });
    $('tSave').addEventListener('click', async () => { await control('triggers', tDraft); tDirty = false; });
    const dlg = $('sellDlg');
    $('bSell').addEventListener('click', () => { $('sellConfirm').value = ''; dlg.showModal(); });
    dlg.addEventListener('close', () => { if (dlg.returnValue === 'go') control('sell', { confirm: $('sellConfirm').value.trim().toUpperCase() }); });
    refresh();
    setInterval(refresh, 5000);
  });
})();
