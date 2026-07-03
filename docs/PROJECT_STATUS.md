# Eather Trading Bot — Project Status & Handoff
**Last updated: 2026-06-30**

This document is a complete handoff so work can continue in a fresh chat. The section
directly below is the CURRENT state and supersedes the older sections (kept as history).

---

## ⭐ LATEST STATUS — 2026-06-30 (READ THIS FIRST)

### Where the code is (git)
- **Live code = v1**, commit `520a417` ("volume-confirmed trailing-reversal bot"). Local `main` sits at v1 and is **2 commits BEHIND `origin/main`**: the regime-gate + ATR-adaptive work (`b1e0ddf` + `0c8acab`) is on GitHub and on local branch **`backup/atr-work`**, but was **reverted out of the live code on 2026-06-26** at the user's request. Restore it with `git checkout backup/atr-work`.
- Remote: `github.com/anopsingh706/Ether_trading_bot`. `backend/feeSim.js` (untracked) = read-only fee simulator.

### Current strategy & config (`backend/.env`, gitignored)
Pure trailing-reversal on the **raw** Uniswap pool price (EMA smoothing OFF), all-in, strictly alternating:
- BUY when raw price rises **+$1** off the trough; SELL when it falls **−$1** off the peak.
- `BOT_THRESHOLD_MODE=absolute` · `BOT_ENTRY_THRESHOLD=1` · `BOT_EXIT_THRESHOLD=1` · `BOT_SMOOTHING=false`
- `BOT_VOLUME_FILTER=true` (1.5× 20-candle MA on Binance ETHUSDT 1m; **~5-min live warm-up** — v1 has no REST seed)
- `BOT_TREND_FILTER=false` · `BOT_TREND_EXIT=false` · `BOT_STOP_LOSS_PCT=0.5` · `BOT_MIN_NET_PROFIT=0` · `BOT_COOLDOWN_MS=0` · `BOT_ENTRY_CONFIRM_MS=0`
- Slippage: `BOT_SLIPPAGE_TOLERANCE=0.0015` (0.15% min-output) · `BOT_SLIPPAGE_BPS=30` · `BOT_SLIPPAGE_HALT=true`
- Feed/exec: `BOT_PRICE_SOURCE=uniswap` · `BOT_POOL_FEE=500` (0.05% WETH/USDC.e pool) · `BOT_USE_WSS=true` (~2s block reads) · `BOT_FEED_MIN_READ_MS=2000`
- **RPC = Alchemy** (`POLYGON_RPC_URL=…g.alchemy.com/v2/…`); Infura is `POLYGON_RPC_URL_2` (stored, unused by code). ⚠️ v1 code has **no RPC-error backoff** (that was in the reverted commit).

### Wallet / position / how to run
- Live wallet `0xDdD168…` ≈ **$23 USDC.e + ~159 POL**. Position resumes from DB `BotState` and **re-anchors on every restart**.
- DB `jan25au_botsim` running counter: **−$2.67 over 160 real trades (80 round trips, ~20% win rate)**. Can be reset on request.
- Run LIVE: `cd backend && npm run bot` (real funds). Read-only sim: `node feeSim.js`.

### KEY FINDINGS THIS SESSION (settled — don't re-litigate)
1. **No edge; fees are the killer — proven three ways.** Round-trip cost ≈ **0.19%** = 0.10% pool fee (irreducible) + ~0.08% slippage + gas. `feeSim.js` (calibrated to the live ledger): $0.05/$0.05 on $1,000 loses ~9% in 33 min (~$2 fee/round-trip vs ~$0.30 captured). Real ledger agrees: −$2.67/160 trades.
2. **The "+$1,000 / 6,000-trade winning test" was PAPER mode with ZERO fees.** DB proof: `dry_run=true` = 6,160 trades, **+$1,063.97, $0 gas/fees**; `dry_run=false` (real) = 160 trades, **−$2.67**. The profit was a fee-blind illusion. With real fees those 6,160 trades leave ~$3 from $1,000 (~$50 even with zero slippage).
3. **Slippage is already minimized (0.15%) and is only HALF the cost.** The 0.10% pool fee can't be removed. MEV/private-RPC/aggregator advice is irrelevant at $23–$10k size (nobody sandwiches trades this small; Flashbots doesn't cover Polygon).
4. **The original custom AMM `0xe6A2b59` is a closed loop at the CONTRACT level:** `swapWithAmount` is `onlyOwner` (reverts "Not authorized" for the live wallet; owner = old `0xB7e4` wallet, key in `.env` as a comment). No public swap → no external flow → can never earn fees. AMM_Bot scaffold + closed-loop scripts were built then deleted.
5. **0.05% pool is the cost floor** — the 0.01% pool is an empty trap on Polygon (`feeScan` proved it).

### Open decision (clearer than ever)
Only path to profit: **trade far less, on much bigger moves**, so each round trip's captured move exceeds the ~0.19% round-trip cost (≈$3 at ETH ~$1,550). $0.05–$1 thresholds cannot. Alternatives: pivot to **LP/market-making** (be the fee-earner, not payer), build the deferred **ATR-adaptive + ADX** plan (`backup/atr-work` has the ATR half), or **stop**. No RPC/slippage/aggregator tweak changes the math.

---

## 1. TL;DR (read this first)
- We rebuilt the bot from a broken closed-loop AMM scalper into a **real-market Uniswap v3 bot** on Polygon (WETH/USDC.e), running locally, dry-run-capable, with real on-chain execution proven.
- **Honest conclusion reached:** this long-only ~0.05 scalping strategy **has no edge** — it loses to the 0.10% round-trip swap fee, and a cross-venue scan found **no arbitrage gap** to exploit. Gas is cheap (~$0.005/swap); the **fee** is the killer.
- We added a **trend filter ("sit in cash in downtrends")** so it stops buying into falling markets, plus **sell-side protective exits (stop-loss + trend-exit)** so a long is **cut, never bag-held** in a downtrend.
- **Current state: bot is FLAT (`IN_USDT`, ~24.43 USDC.e). Net realized so far: −0.5726 USDC** across ~6 live round trips (all small losses).
- **Open decision:** keep running in trend/bigger-threshold mode, switch strategy, or stop. No config makes this pair+strategy reliably profitable — profit needs ETH to trend up while long, or a fundamentally different approach.

---

## 2. What the project is
`C:\Users\Admin\Desktop\Eather` — Node/Express backend + (unused here) React admin frontend.
The trading bot trades **WETH ⇄ USDC.e** on **Polygon**.

- **Original system (deprecated):** `backend/jobs/ammBuySellNew.js` + `backend/services/ammService.js` swapped against a **custom owner-deployed AMM contract** priced off Chainlink. On-chain investigation proved this was **Scenario A** (the same wallet owns the contract, funded the only liquidity, and is the only trader) → a closed loop that can't make real money. **Abandoned.**
- **New system (current):** a self-contained engine under `backend/bot/` that prices from and trades on the **real Uniswap v3 pool**.

---

## 3. Architecture (the live bot)
Entry point: **`backend/botRunner.js`** → `backend/bot/runner.js`. Run with `npm run bot`.

| File | Role |
|---|---|
| `bot/config.js` | All settings (env-overridable). Derives sandbox DB URL + WSS RPC URL. |
| `bot/db.js` | Dedicated mongoose connection to the **sandbox DB** (isolated from prod). |
| `bot/uniswapFeed.js` | **Price feed** — reads the Uniswap pool `slot0` price via WSS block subscription + HTTPS poll fallback. Resolves only `cfg.POOL_FEE`. |
| `bot/priceFeed.js` | Legacy Binance WebSocket feed (used only if `BOT_PRICE_SOURCE=binance`). |
| `bot/strategyEngine.js` | The state machine: trailing-Δ reversal + **trend filter** + cooldown + profit guard + persistent lock call. |
| `bot/execution.js` | Decides dry-run vs live; computes realized rate from balance deltas; **net-of-gas P&L**; writes order; updates state. |
| `bot/dex.js` | **Real Uniswap swaps** via SwapRouter02 + QuoterV2 quote + **min-output slippage protection**. Verbose tx logging. |
| `bot/state.js` | Load/init/persist `BotState`; re-anchor on restart; **acquireLock/releaseLock**. |
| `bot/logger.js` | Table-formatted ledger + in-place status line + session summary. |
| `bot/scanner.js` | **Read-only** cross-venue price scanner (`npm run scan`). No trading. |
| `bot/models/` | `BotState`, `BotOrder`, `Counter` (atomic order_code), `BotTick`. |

Old/dead files (`jobs/ammBuySell*`, `services/ammService*`, dated backups, etc.) are **banner-marked DEPRECATED** and not on the live path.

---

## 4. The strategy
**Trailing reversal, long-only, alternating buy→sell — now on a SMOOTHED price with TWO thresholds (#1 + #3, 2026-06-19):**
- Decisions run on an **EMA-smoothed price** (`BOT_SMOOTHING`, `BOT_SMOOTHING_MS` ≈ 1 min), not raw ticks, so noise can't fake a reversal. The trend MA still uses raw price.
- `IN_USDT` (cash): track the smoothed **low**; BUY when the smoothed price rises the **wide entry threshold** (`BOT_ENTRY_THRESHOLD`, e.g. 0.3%) above it — *and only if the trend filter says uptrend*.
- `IN_WETH` (holding): track the smoothed **high**; SELL when the smoothed price falls the **tight exit threshold** (`BOT_EXIT_THRESHOLD`, e.g. 0.15%) below it (tight trailing capture) — or on a protective exit.
- Thresholds honour `BOT_THRESHOLD_MODE` (now `percent`). The old single `BOT_THRESHOLD` is just the fallback when entry/exit aren't set.

**Guards / filters (all configurable, currently ON):**
- **Trend filter (Option B) — currently OFF:** when ON, only BUY when `price ≥ 15-min moving average` (uptrend) and holds cash in downtrends. Turned OFF 2026-06-19 so the bot can grab downtrend bounces (the 0.3% entry threshold + EMA smoothing replace its noise-filtering role).
- **Protective exits (2026-06-18):** the symmetric partner to the trend filter, on the SELL side. While holding, a **hard stop-loss** (`BOT_STOP_LOSS_PCT`, default 0.5% below entry) and a **trend-exit** (`BOT_TREND_EXIT`, sells when the 15-min MA flips down) **override** the profit guard so a long is **cut, never bag-held**. Directly fixes the trap that forced the manual flatten at −0.30.
- **MIN_NET_PROFIT guard:** only SELL *for profit* if the exit nets ≥ `BOT_MIN_NET_PROFIT` after costs — so small *real* profits accumulate. The bag-hold side effect is now bounded by the protective exits above (they bypass this guard to cut losers). Set to 0 to also let the Δ-reversal itself cut losses.
- **Slippage:** QuoterV2 min-output on every live swap (0.5%); post-fill alert at 50 bps; `SLIPPAGE_HALT=true` stops trading on a bad fill.
- **Persistent lock:** atomic DB lock so a 2nd instance / crash-resume can't double-trade.
- **Re-anchor on restart:** clears the stale peak/bottom so it re-locks to the live price (prevents trading off a day-old extreme).

---

## 5. Honest findings (don't re-litigate these)
1. **Original AMM = Scenario A** (closed loop) — verified on-chain (owner == only LP == only swapper). Not real profit.
2. **Real Uniswap rails work** — real swaps, slippage protection, accurate accounting all proven.
3. **No edge:**
   - Single-venue scalp loses to the **0.10% round-trip swap fee** (0.05% × 2). On $25 the per-round-trip cost ≈ $0.035 ≈ 0.14%; the strategy targets ~$0.20 (0.011%) moves → underwater.
   - `npm run scan` over live venues (Binance / Uniswap v3 / Quickswap / Sushi): liquid venues priced within ~0.01%; **0/8 samples** beat the ~0.35% arb cost. No arbitrage edge.
4. **Gas is cheap** (~$0.0046/swap; POL ≈ $0.076). An earlier 5× overstatement (code used $0.40/POL) was fixed — dex.js now fetches live POL price. **The fee, not gas, is the problem.**
5. **Profit requires ETH to trend UP while long.** The trend filter avoids downtrend bleed but is not a guaranteed winner.

---

## 6. Wallet / config / secrets
- **Main wallet (live):** address + `PRIVATE_KEY` live in `backend/.env` (gitignored — never commit; rotate before hosting). Held ~24.43 USDC.e + ~170 POL (gas) at last handoff.
- **DB:** `DB_URL` in `.env` points at **production** `jan25au_prod`. The bot uses a **derived sandbox DB `jan25au_botsim`** (override with `BOT_DB_URL`). `bot_orders` there mixes old dry-run sim rows (`dry_run:true`) with live rows (`dry_run:false`, `route:"UNISWAP"`).
- **Key addresses:** WETH `0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619` · USDC.e `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` · pool `0x45dDa9cb7c25131DF268515131f647d726f50608` · SwapRouter02 `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45` · QuoterV2 `0x61fFE014bA17989E743c5F6cB21bF9697530B21e` · V3 factory `0x1F98431c8aD98523631AE4a59f267346ea31F984`.

### Key env vars (in `backend/.env`)
```
BOT_THRESHOLD        Δ in USD (last used 0.2; bigger = ride bigger moves)
BOT_PRICE_SOURCE     uniswap
BOT_POOL_FEE         500  (0.05% tier; feed AND executor both use this)
BOT_TREND_FILTER     true       BOT_TREND_WINDOW_MS 900000 (15m)  BOT_TREND_MIN_SAMPLES 20
BOT_STOP_LOSS_PCT    0.5   BOT_TREND_EXIT true   (protective exits — override MIN_NET_PROFIT)
BOT_MIN_NET_PROFIT   0.05  USDC  BOT_EST_COST 0.04
BOT_SLIPPAGE_HALT    true   BOT_SLIPPAGE_BPS 50   BOT_SLIPPAGE_TOLERANCE 0.005
```
⚠️ **Dry-run/paper mode was REMOVED (2026-06-18).** `BOT_DRY_RUN` and `BOT_SIM_*` are ignored — every run trades real funds.

### How to run
```bat
cd backend
:: LIVE (real funds — there is no paper mode anymore):
set BOT_THRESHOLD=0.2
npm run bot
:: read-only cross-venue scanner:
npm run scan
```
`npm start` runs ONLY the API. ⚠️ `npm run bot` **always trades real money** now.

---

## 7. All fixes & changes made this project
**Engine build:** new `bot/` engine — WebSocket/poll price feed, persistent state machine (`BotState`), table-formatted ledger, dry-run mode, isolated sandbox DB.

**Switched to real market:** price + execution moved to **Uniswap v3** (`uniswapFeed.js`, `dex.js`, `execution.execLive`). Real `exactInputSingle` swaps with `amountOutMinimum` slippage protection.

**Strategy/correctness fixes (vs the original bot's bugs):**
- 0.05 is now a real trigger (was cosmetic); single price source; realized rate from on-chain deltas (no synthetic prices); clean cold start; numeric atomic `order_code`; `route` persists; WebSocket feed (no 30s-stale data); re-anchor on restart; REST/poll fallback so the feed never freezes.

**Recent 5 bug fixes (verified in code):**
1. **P&L net of gas** — `profit`, `cumulativePnl`, win/loss now subtract both legs' gas (`BotState.entryGas` added; orders keep `profit` net + `profit_gross`).
2. **Server footgun** — `startPriceScheduler()` disabled in `server.js` (old loop no longer auto-starts on `npm start`).
3. **Feed/executor pool consistency** — `uniswapFeed` resolves only `cfg.POOL_FEE` (no silent fallback to a different tier).
4. **Persistent lock wired** — `acquireLock`/`releaseLock` in `state.js`, used in `strategyEngine._act` (stale locks >2 min auto-recover).
5. **`.env` typo** — `MATIC_PRICE_FEED_ADDRESS` corrected to 40 hex chars.

**Option B (trend filter):** added moving-average trend gate on buys (sit in cash in downtrends); shown on the status line + startup banner; unit-tested (rising→buy allowed, falling/warming→cash).

**Protective exits (sell-side, 2026-06-18):** hard stop-loss vs entry (`BOT_STOP_LOSS_PCT`, default 0.5%) + trend-flip exit (`BOT_TREND_EXIT`) that **override `MIN_NET_PROFIT`** so a long is cut instead of bag-held. New `exit_reason` field on each order (`profit-take | stop-loss | trend-down`); shown in the banner + status line (`stop≤…`). Unit-tested 8/8. Files: `config.js`, `strategyEngine.js` (`_protectiveExit`), `execution.js`, `models/BotOrder.js`, `runner.js`, `.env`. ⚠️ Risk-management only — caps losses, does **not** create edge.

**Guards turned ON** in `.env`: `BOT_MIN_NET_PROFIT=0.05`, `BOT_EST_COST=0.04`, `BOT_SLIPPAGE_HALT=true`.

**Fake-spike filter + anti-churn + RPC throttle (2026-06-23, "Option A"):** after a day of whipsaw losses (win rate ~12–21%, small wins ≈ small losses → negative expectancy) AND an **Infura rate-limit/quota crash** (`-32005 Too Many Requests` → `Payment Required` on `eth_getBalance`):
- **Fake-spike (false-breakout) filter** — `strategyEngine._pendingEntry`: when the smoothed price crosses `low + entryΔ`, it does NOT buy; it must **HOLD above the trigger for `BOT_ENTRY_CONFIRM_MS` (45s)**. A pop that falls back below the trigger first is logged "Fake spike rejected" and skipped. Unit-tested 7/7.
- **Cooldown is entry-only** — `_act` only applies `COOLDOWN_MS` to BUYs, so a protective SELL/stop is never blocked. `BOT_COOLDOWN_MS=60000`.
- **RPC throttle** — `uniswapFeed._readPrice` capped to one pool read / `BOT_FEED_MIN_READ_MS` (4s); `BOT_BLOCK_POLL_MS` raised to 8000. Cuts Infura load that caused the crash. (If the key is already quota-exhausted, point `POLYGON_RPC_URL` at the backup/Alchemy.)
- Files: `config.js`, `strategyEngine.js`, `uniswapFeed.js`, `runner.js`, `.env`. ⚠️ Reduces fake-spike losses + over-trading; does NOT create an edge — flat/choppy markets still bleed to the 0.10% fee.
- **REVERTED same day (2026-06-23):** the 45s confirm-window made the bot *chase* — it confirmed during a 1655→1659 rise, bought the top, then reversed (−0.07). Set `BOT_ENTRY_CONFIRM_MS=0` + `BOT_COOLDOWN_MS=0` → back to immediate entry. **RPC throttle kept** (infra fix, unrelated to results). Code left in place but dormant (flags 0).

**BREAK-EVEN exit mode (2026-07-02d, per user "no bleeding on exit"):** user accepted spike entries but wanted exits that never book the small losses. New `BOT_EXIT_MODE=breakeven` (live default now): NEVER sell below break-even (`beLevel = entryUsdt×(1+BE_BUFFER 0.1%)/(entryWeth×(1−fee))` — includes both fees, gas, rounding); underwater → HOLD (log every 5min, status `BE≥… ⏳uw Xh`); once the peak reaches BE the floor arms → exit at BE-or-better (trail $3 above BE, else `exit_reason:'breakeven'`); the ONLY realizable loss is the **disaster stop** `BOT_DISASTER_STOP_PCT=5` (raw price, `exit_reason:'disaster'`). Stop-loss/trend-exit/profit-guard are bypassed in this mode; `BOT_EXIT_MODE=classic` restores them. Unit-tested 7/7; backtester grew `--exit be --disaster N` + maxHold/stuck/mark-to-market-DD metrics. **Backtest evidence: 30d crash (ETH −18%): BE+5% → 314 RT, 97% green/flat exits, 10 bounded −5% hits, worst hold 50h vs classic 42% win / 600+ small cuts vs BE-without-disaster → FROZE 719h holding −17% unrealized (why disaster=0 is strongly discouraged). 7d: BE+5% beat classic (+1.50 vs +0.88) with the lowest drawdown.** Honest caveats: green ledger ≠ green wallet (mark-to-market dips while underwater, up to ~2 days observed); a gap through BE can still net a few cents red (buffer absorbs typical case); granularity-inflated absolutes — trust structure/comparisons.

**ATR entry gate OFF + spike-aware volume gate (2026-07-02c, per user):** a $4.88 pop (1642.41→1647.29) went untraded; diagnosis: (1) it was $0.12 below the $5 entry trigger anyway, and (2) ALL indicator gates were computed from CLOSED 1m candles → one candle late on sudden spikes while the raw-tick trigger is instant. Changes: `BOT_ATR_FILTER=false` in `.env` (ATR still computed — the adaptive slippage uses it); `volumeFeed.check()` now takes `max(latest closed, in-progress candle)` so a real breakout's volume passes within seconds (partial candle can only make the gate MORE permissive when activity is already above the full-candle average). Trend filter (15-min MA) kept as the sole downtrend guard. Live gates now: volume (spike-aware) + trend + $5/$3 + stop 0.5% + adaptive slippage + revert backoff.

**Datum gate REMOVED → adaptive trend gate (2026-07-02, per user):** the datum-line gate (block re-entry below the last entry price) proved to be a near-permanent lockout in practice — live it froze trading below 1645.46, and in the 30d backtest it reduced the $5/$3 config to 1 trade/month. Removed everywhere (`config`, `strategyEngine._datumBlocksBuy`, `execution`, `state`, `BotState.datumPrice` + DB `$unset`, `runner`, `backtest`). Replaced by re-enabling **`BOT_TREND_FILTER=true`** (Option B, already unit-tested): no buys while price < 15-min MA — same downtrend protection but **auto-releasing** when the trend turns. Backtest 30d $5/$3 (both inflated by 1m-OHLC granularity — trust the comparison, not the absolutes): trend ON: 523 RT, 63% win, maxDD 0.48, 1 stop-out vs trend OFF: 736 RT, 51% win, maxDD **2.04**, **17** stop-outs. Trend gate ≈ 4× lower drawdown, half the losers — strictly better than nothing, never locks out. `BOT_TREND_EXIT` stays false (history: it insta-sold bounce buys).

**Revert backoff + ATR-adaptive slippage + $5/$3 thresholds (2026-07-02, after the revert incident):** during a fast +1.7% move, 5 consecutive BUYs + 1 SELL reverted on the 0.15% minOut (pool moved more than that between quote and landing) — each revert still pays full gas (~$0.03 wasted total), because the engine retried every tick. Fixes, all live:
- **Revert backoff** (`BOT_REVERT_BACKOFF_MS`, 60s): after ANY execution error, `_act` refuses new swap attempts for the window instead of re-firing into the same fast market. Error log truncated to 300 chars (was dumping full receipt JSON per revert).
- **ATR-adaptive minOut** (`BOT_SLIPPAGE_ATR_MULT` ×2, `BOT_SLIPPAGE_MAX` 0.5%): tolerance = max(base 0.15%, 1m-ATR% × 2) capped 0.5% — quiet market keeps the tight guard, spike regime (ATR 0.17% → 0.34% tol) lands instead of reverting. Engine passes live ATR → `execution.slippageTol()` → `dex.swap(side, amount, tol)`.
- **Thresholds $1/$1 → $5/$3** in `.env`: $1 = 0.06% at ETH ~1640 = noise (a BUY got trail-stopped in 21s, −0.05); $5/$3 matches the only region the backtest showed as non-negative. Banner shows `swap safe : minOut slip 0.15%→0.50% (ATR-adaptive ×2) | revert backoff 60s`.

**Backtester (2026-07-02):** `npm run backtest` (`bot/backtest.js`) — read-only replay of the v1 strategy + all anti-whipsaw gates over historical Binance 1m klines with per-leg costs + gas. Flags: `--days N`, `--sweep` (grid ATR floor × thresholds × volume). Fills at trigger crossings; Binance stands in for the pool price — use for RELATIVE config comparison, not exact P&L. **30d findings (ETH −18.2%):** buy&hold −$4.14; nearly every gated config ≈ breakeven (−0.20…+0.11) — the datum gate turned the bot off after the first trade of the crash and preserved capital, exactly as designed; the current live config traded once (+0.01). No config was robustly profitable across both 7d and 30d windows (the 7d winner Δ8/5 didn't repeat; a lone +10.24 cell at 30d flipped sign on a single toggle → luck, not edge). Conclusion: gates = working capital preservation; profit still requires a trend while long. Live-side status check same day: 0 trades in the 2 days since the filters shipped (ATR 1m chronically 0.04–0.10% < 0.12% floor) while ETH rallied +3.3% — the 0.12% floor acts as a near-kill-switch on 1m; lower it (~0.05%) or accept trading only violent bursts. ATR log spam throttled 30s→5min.

**Anti-whipsaw filters: ATR + datum-line gate + sizing (LIVE, 2026-06-30):** three additions aimed at killing the whipsaw bleed (repeated round-trips in chop / downtrends). All config-gated, ON by default, on the LIVE path; unit-tested 9/9.
- **ATR volatility filter** (`bot/volumeFeed.js` now also computes ATR from the same Binance klines — no extra connection; `strategyEngine._atrBlocksBuy`): blocks BUYs when ATR as a % of price `< BOT_ATR_MIN_PCT` (default 0.12%) — i.e. the market is too quiet for a move to clear the round-trip cost, so sit in cash. `BOT_ATR_PERIOD` (14). Optional adaptive entry: `BOT_ATR_ENTRY_MULT>0` makes the entry Δ = `max(configured, ATR×mult)`.
- **Datum-line gate** (`strategyEngine._datumBlocksBuy`; `BotState.datumPrice` set to each entry price in `execution.finalize`): after an exit, **re-entry is blocked while the RAW price is below the datum (last entry price)** and only resumes once price reclaims it. This is the falling-knife stopper — in a downtrend from your last entry, the bot sits out instead of repeatedly buying lower and stopping out. `BOT_DATUM_GATE`. ⚠️ Can lock the bot out for a long time in a sustained downtrend (intended — capital preservation). Reset by clearing `datumPrice` or `BOT_DATUM_GATE=false`.
- **Fixed-notional sizing** (`BOT_TRADE_USD`, `bot/simExecution.js`): trade a fixed $ size instead of all-in → far less price impact (the dominant cost at larger size). Currently wired in the SIM path; the live $23 wallet has negligible impact anyway (cost ≈ the 0.10% fee floor), so live stays all-in unless `BOT_TRADE_USD` is added to `execLive` later.
- Banner + status show `atr X%✓/✗` and `datum NNNN🔒` (🔒 = locked, price below datum). Feed is built when EITHER volume OR ATR is on. Files: `config.js`, `volumeFeed.js`, `strategyEngine.js`, `execution.js`, `state.js`, `runner.js`, `models/BotState.js`. ⚠️ These cut whipsaw losses hard but do NOT make zero-loss possible — every round trip still pays the fee; a stop-loss still books a small loss.

**Volume confirmation / false-breakout filter (2026-06-23):** new `bot/volumeFeed.js` — a Binance **kline WebSocket** (no RPC load; Binance leads ETH price) tracking per-candle volume. `strategyEngine._volumeBlocksBuy()` gates entries: only BUY if the latest closed candle's volume ≥ `BOT_VOLUME_MULT` (1.5×) the trailing `BOT_VOLUME_WINDOW` (20)-candle MA. **Instant gate (no chase)** — fixes what killed Option A's time-confirm. ~5-candle warm-up (`BOT_VOLUME_MIN_SAMPLES`); inactive→passes during warm-up. Wired through `runner.js` (banner + `vol N×✓/✗` status). Default ON. Unit-tested 9/9. ⚠️ Coarse at the micro-threshold scale — keeps the bot out of dead/low-volume chop, doesn't perfectly judge each tick-spike. Pair with a wider exit (user tuning thresholds manually).

**Two-threshold + smoothed-price strategy (#1 + #3, 2026-06-19):** decisions now run on an **EMA-smoothed price** (`_smoothPrice`, `BOT_SMOOTHING`/`BOT_SMOOTHING_MS`) and the single Δ was split into a **wide entry** (`BOT_ENTRY_THRESHOLD`) + **tight trailing exit** (`BOT_EXIT_THRESHOLD`), both percent (`BOT_THRESHOLD_MODE=percent`). `.env` set to entry 0.3% / exit 0.15% / 1-min EMA, and **`BOT_MIN_NET_PROFIT=0`** so the tight exit can also cut failed bounces (the old 0.05 guard blocked that). Banner + status line show entry/exit + live `ema`. Files: `config.js`, `strategyEngine.js` (`_smoothPrice`, `_entryDelta`, `_exitDelta`, rewritten `onTick`), `runner.js`, `.env`. Unit-tested 7/7. **Trend filter + trend-exit set to `false`** (aggressive downtrend spike-grabbing): the 0.3% entry threshold + EMA smoothing are the noise filter now; stop-loss + the tight exit manage failed bounces. Set both back to `true` to only trade uptrends.

**Dry-run REMOVED + reconcile guard (2026-06-19):** deleted paper/dry-run mode entirely (it shared the live `BotState` singleton → a dry-run resumed the live `IN_WETH` position with 0 sim WETH and spam-looped "Cannot EXIT market"). Now there is one LIVE path only. Added a **position/balance reconcile** in `execLive`: if a SELL finds no WETH (or a BUY finds no USDC), it trusts the wallet, flips the position (`reconcileToCash`/`reconcileToWeth` in `state.js`), logs once, and skips — no more retry spam. Removed `DRY_RUN`/`SIM_*` from `config.js`, `state.js`, `runner.js`, `strategyEngine.js`, `execution.js` (`execDryRun` gone). `BotState.simUsdt/simWeth` left in schema (harmless, unused). Smoke-tested.

**Manual flatten (2026-06-18):** one manual SELL closed a bag-held WETH position (tx `0x5acf757…792be`) → bot now `IN_USDT`. Realized that round trip at −0.30; `cumulativePnl` = −0.5726.

---

## 8. CURRENT STATE (as of handoff)
- **Position:** `IN_USDT` (flat / in cash), wallet ≈ **24.43 USDC.e + ~170 POL**.
- **Net realized P&L:** **−0.5726 USDC** (≈ −2.3% of the $25), all from small losing round trips + gas.
- **Mode/config last used:** LIVE, Δ=0.2, trend filter ON, guards ON.
- **Note:** the user's terminal bot (PID at handoff) was running with stale memory after the manual flatten — it must be **restarted** (`Ctrl+C` + `npm run bot`) to reload the `IN_USDT` state.
- On restart, in the current **downtrend**, the trend filter will **hold USDC.e** (no buying) — working as designed.

---

## 9. Open decision / next steps
Pick a direction (none of these guarantees profit — that's the honest state):
1. **Run trend mode:** keep the trend filter, raise `BOT_THRESHOLD` (e.g. 5–10) so it only trades bigger moves where the 0.10% fee is negligible. Best chance, still a directional ETH bet.
2. **Turn `MIN_NET_PROFIT` off** (`0`) if you'd rather it cut losses than bag-hold.
3. **Different strategy** — market-making (needs real user flow; the old AMM had none), or a non-scalping approach.
4. **Stop** — treat the ~$0.57 as tuition; the engine + scanner remain as tools.

**Security TODO before any hosting:** rotate `PRIVATE_KEY` (it's been in plaintext), move secrets to a secret store, keep `.env`/`ecosystem.config.js` out of git (`.gitignore` already added).

---

## 10. Simulation / paper-trading mode (NEW — 2026-06-30)
A clean, **fully isolated** real-time paper-trading mode for running large test batches
(e.g. ~1000 transactions) with **no real funds and no wallet/private key**. Restores SRS
FR-15 / Phase 8 paper-trading — but, unlike the old dry-run that was removed (it shared the
live `BotState` singleton and corrupted the live position), this mode is isolated.

**How to run**
```bat
cd backend
npm run sim          :: virtual $1000, real-time Uniswap pricing, real fees — NO real money
```
Tunables (env, optional): `BOT_SIM_CAPITAL` (1000), `BOT_SIM_TX_TARGET` (1000 — progress
display only), `BOT_SIM_MAX_TX` (0 = run until stopped; set e.g. 1000 for a hard stop), plus
the usual `BOT_ENTRY_THRESHOLD` / `BOT_EXIT_THRESHOLD` / `BOT_VOLUME_FILTER` / … — it reads the
SAME strategy config as the live bot, so the sim mirrors live behaviour.

**What makes it realistic ("include all applicable fees")**
- **Price:** the live Uniswap v3 pool `slot0` (same feed as the live bot).
- **Fill:** each BUY/SELL is priced with the **real QuoterV2** for the actual trade size, so
  the **0.05% LP fee AND the price impact** of that size are already in the fill.
- **Gas:** real estimate — QuoterV2 `gasEstimate` × live gas price × live POL/USD (~$0.005/swap).
- **P&L:** reuses the live `execution.finalize()` → net-of-fee, net-of-gas, same ledger/accounting.

**Isolation (why it can't touch live):**
- Own state document `key:'sim-singleton'` (live is `'singleton'`) — separate position/balances.
- No `Dex`/wallet is constructed in sim; there is no signer, so a real tx is impossible.
- Orders tagged `dry_run:true`, `route:'UNISWAP-SIM'` (filterable; live rows are `UNISWAP`).
- Virtual-balance invariant: when flat, `simUsdt == SIM_CAPITAL + cumulativePnl` (can't drift).

**Files:** `bot/simExecution.js` (NEW), `botSimRunner.js` (NEW, `npm run sim`), plus sim-gated
additions in `bot/config.js`, `bot/state.js`, `bot/execution.js`, `bot/runner.js`,
`bot/strategyEngine.js`, `bot/models/BotState.js`. Live path is unchanged when `BOT_SIM` is unset.

**Validated 2026-06-30:** booted, seeded $1000, priced live, executed simulated round trips
(BUY $1000→WETH, SELL→USDC), net P&L + gas deducted, `txCount` + hard-stop working, balance
invariant held. ⚠️ As the docs predict, each all-in round trip is **net-negative** (fee + impact
+ gas, no edge) — the sim's purpose is to *quantify* that bleed across ~1000 trades, not to profit.

---

## 11. Related docs
- `docs/SRS_Trading_Bot.md` — the original spec/roadmap + locked decisions.
- This file (`docs/PROJECT_STATUS.md`) — current handoff.
