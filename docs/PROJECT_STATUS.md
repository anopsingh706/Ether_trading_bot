# Eather Trading Bot — Project Status & Handoff
**Last updated: 2026-06-18**

This document is a complete handoff so work can continue in a fresh chat. It covers what
the project is, the architecture we built, every fix/change made, the honest findings,
the exact current state, and the open decision.

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

## 10. Related docs
- `docs/SRS_Trading_Bot.md` — the original spec/roadmap + locked decisions.
- This file (`docs/PROJECT_STATUS.md`) — current handoff.
