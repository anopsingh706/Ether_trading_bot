# Software Requirements Specification (SRS) & Implementation Roadmap
## USDT ⇄ WETH Automated AMM Trading Bot — Rewrite

| Field | Value |
|---|---|
| Document version | 0.1 (DRAFT) |
| Date | 2026-06-14 |
| Status | For review — to be approved before implementation |
| Owner | (redacted) |
| Scope of change | `backend/` trading engine only (frontend untouched) |

> This document is the **plan we will follow**. It describes the current system,
> every known bug, the target strategy, the new architecture (WebSocket price feed
> + a persistent **state table** decision engine), and a phased roadmap with
> acceptance criteria. No code is changed by this document.

---

## 1. Introduction

### 1.1 Purpose
The current bot does **not** trade according to the intended strategy and contains
several correctness, accounting, and security defects. This SRS defines:
1. What the bot *should* do (the 0.05 trailing buy/sell strategy).
2. How we will rebuild the decision and execution layers to do it reliably.
3. The exact, ordered steps (roadmap) to get there safely.

### 1.2 Scope
**In scope**
- Real-time price ingestion (Binance WebSocket, replacing 30s REST polling).
- A persistent **state machine + state table** that decides buy/sell.
- A trailing **0.05** trigger (buy as price starts rising, sell as it starts falling).
- Accurate order recording (real executed rate, correct GST, gas).
- Concurrency safety, error recovery, observability.
- Security hardening (secret handling).

**Out of scope (for now, tracked as open decisions)**
- Replacing the on-chain AMM contract (needed only for true slippage protection — see §11).
- Frontend/admin UI changes.
- Multi-pair / multi-wallet support.

### 1.3 Definitions
| Term | Meaning |
|---|---|
| **Position** | What the wallet currently holds: `IN_USDT` (waiting to buy) or `IN_WETH` (waiting to sell). |
| **Anchor** | The running extreme price while we wait: the lowest price seen since the last sell (a *trough*) when `IN_USDT`, or the highest price seen since the last buy (a *peak*) when `IN_WETH`. |
| **Threshold (Δ)** | The move size that confirms a reversal and triggers a trade. Requested value = `0.05`. Configurable. |
| **Realized rate** | The *actual* price a swap executed at, computed from on-chain balance changes (`USDT delta / WETH delta`), not a quoted number. |
| **Tick** | One incoming price update from the WebSocket. |
| **Pip adjustment** | The spread the AMM contract applies around the Chainlink rate on each swap. |

### 1.4 Reference files (current code)
- `backend/jobs/priceScheduler.js` — 30s Binance REST poll + triggers trading.
- `backend/jobs/ammBuySellNew.js` — current (live) decision + execution logic.
- `backend/services/ammService.js` — AMM contract wrapper (swap, pause, Chainlink, gas).
- `backend/models/order.js`, `backend/models/CryptoRate.js` — data models.
- `backend/contracts/amm.abi.json` — AMM ABI (`swapWithAmount(amountIn, isWethToUsdt)` — **no min-output param**).
- `backend/ecosystem.config.js` — **contains a plaintext private key (must be rotated)**.

---

## 2. Current System Summary (AS-IS)

### 2.1 Execution flow (today)
```
server.js
  └─ startPriceScheduler()              [priceScheduler.js]
       every 30 seconds (cron */30 * * * * *):
         1. GET Binance ETHUSDT price (REST)
         2. INSERT into crypto_rates
         3. executeOrder()              [ammBuySellNew.js]
              - read latest 3 crypto_rates → latestRate, secondRate (3rd unused)
              - read live Chainlink rate (only for the saved record)
              - read LAST order:
                   last was SELL / none → autoBuyOrder()
                   last was BUY        → autoSellOrder()
              - condition check → performSwap() → save Order
```

### 2.2 How "buy/sell" is decided today
- `latestRate` = Binance price now (from DB).
- `secondRate` = Binance price ~30s ago (from DB).
- `sellPrice` / `buyPrice` = `lastOrder.rate` = a **Chainlink** value saved on the previous order.
- Buy if `latestRate > secondRate` (rising) with sub-cases vs `sellPrice`.
- Sell if `latestRate < secondRate` (falling) with sub-cases vs `buyPrice`.

### 2.3 Known defects (bug catalog)
| ID | Severity | Defect | Effect |
|---|---|---|---|
| B-1 | **Critical** | `0.05` is never a trigger — trades fire on *any* up/down tick. It's only written as a fake recorded price. | Bot does not implement the intended strategy at all. |
| B-2 | **Critical** | Decision mixes price feeds: `latestRate`/`secondRate` = Binance, but `buyPrice`/`sellPrice` = Chainlink. | Comparisons flip from feed divergence, not real moves. |
| B-3 | **Critical** | Special-branch saves a **synthetic** rate (`last ± 0.05`); the next cycle uses it as the new baseline. | Decision baseline drifts further from reality each special trade. |
| B-4 | High | Cold start: first run has `sellPrice = 0` → special branch → first order saved with `rate = 0.05`. | Garbage seed value corrupts subsequent decisions. |
| B-5 | High | `gst_flag` (0 for special) is computed but never used; `gst_charge` is charged unconditionally. | Intended GST exemption never happens; accounting wrong. |
| B-6 | High | No slippage / min-output protection. ABI `swapWithAmount` has **no** min-out param. | Swap can execute at any price; needs contract change to fix. |
| B-7 | High | `PROFIT_MARGIN` / `MINOR_CASE` computed but never enforced. | No minimum-profit guard; trades on noise. |
| B-8 | Medium | `order_code`: schema `String`, code does `Number(...) + 1`. | `NaN` risk → unique-index collisions → all future saves fail. |
| B-9 | Medium | `route` set on order but no schema field → silently dropped. | Data thought saved is lost. |
| B-10 | Medium | Always trades 100% of balance. | Amplifies impact of any bad/early trigger. |
| B-11 | Medium | `isProcessing` is in-memory only. | Multi-process/PM2-cluster → double trades. |
| B-12 | Medium | Decision uses prices up to 30–60s old; on-chain settle adds more lag. | Stale decisions; reversal missed by execution time. |
| B-13 | **Critical (security)** | Private key + RPC key in plaintext `ecosystem.config.js`. | Wallet drain risk if file is exposed. |
| B-14 | Low | 3 prices fetched, only 2 used; many dead/duplicate dated files. | Confusion, maintenance/audit risk. |

Full traceability (bug → requirement that fixes it) is in §12.

---

## 3. Target Strategy (business rules)

### 3.1 Plain-English statement
> Buy **early as the price starts rising** (when it has risen `0.05` off its recent low),
> ride the uptrend, and **sell early as it starts falling** (when it has dropped `0.05`
> off its recent high). Then repeat — strictly alternating buy → sell → buy → sell.

This is a **trailing reversal** strategy. We never predict; we react to a confirmed
reversal of size `Δ = 0.05`.

### 3.2 The decision/state table (the "table")
The bot is always in exactly one state. Every incoming tick updates the anchor and
checks the trigger.

| State (Position) | We are watching for | Anchor we track | On each tick | Trigger to act | Action | New state |
|---|---|---|---|---|---|---|
| `IN_USDT` | price to **rise** | `trough` = lowest price since last sell | if `price < trough` → `trough = price` | `price ≥ trough + Δ` | **BUY** (USDT→WETH) | `IN_WETH`, set `peak = price` |
| `IN_WETH` | price to **fall** | `peak` = highest price since last buy | if `price > peak` → `peak = price` | `price ≤ peak − Δ` | **SELL** (WETH→USDT) | `IN_USDT`, set `trough = price` |

Key properties:
- The anchor **follows** the price in the favorable direction (trailing). This is what
  makes "buy as it starts rising / sell as it starts falling" work.
- A trade fires **only** when the move reverses by `Δ`. Tiny noise below `Δ` never trades.
- State strictly alternates — enforced by the persisted `position`, not by reading the
  last order's `side` (removes B-3/B-4 coupling).

### 3.3 Worked example (Δ = 0.05)
Start: `IN_USDT`, `trough` unset.
```
price 2000.00  → trough=2000.00            (watching for rise)
price 1999.80  → trough=1999.80            (new low, keep tracking)
price 1999.82  → 1999.82 < 1999.80+0.05? (1999.85) no → wait
price 1999.86  → ≥ 1999.85 → BUY @ ~market. State → IN_WETH, peak=1999.86
price 2001.50  → peak=2001.50              (riding up)
price 2003.20  → peak=2003.20
price 2003.18  → ≤ 2003.20−0.05 (2003.15)? no → wait
price 2003.10  → ≤ 2003.15 → SELL. State → IN_USDT, trough=2003.10
... repeat
```
Net: bought near the start of a rise, sold near the start of a fall.

### 3.4 Strategy parameters (all configurable via env/DB)
| Param | Default | Meaning |
|---|---|---|
| `THRESHOLD` (Δ) | `0.05` | Reversal size that triggers a trade. |
| `THRESHOLD_MODE` | `absolute` | `absolute` (USD) or `percent` (of anchor). *See open decision OD-1.* |
| `MIN_NET_PROFIT` | TBD | Optional guard: skip a sell unless `proceeds − gas − GST − pip-spread ≥ this`. (Revives B-7 correctly.) |
| `TRADE_SIZE_MODE` | `all` | `all` (100%) or `fixed`/`percent`. *See open decision OD-3.* |
| `COOLDOWN_MS` | TBD | Minimum gap between trades to avoid churn / overlapping swaps. |
| `MAX_PRICE_STALENESS_MS` | e.g. 5000 | If no tick within this window, pause trading & reconnect. |

> ⚠️ **Economics note:** `Δ = 0.05` on ETH (~$2k–$4k) is extremely tight (≈0.0015%).
> Each round trip must overcome gas + GST + the AMM pip-spread. With `Δ = 0.05`, most
> cycles may be net-negative. We **honor 0.05 as the default** but strongly recommend
> `MIN_NET_PROFIT` and/or a larger configurable `Δ`. This is **OD-1/OD-2** in §11.

---

## 4. Proposed Architecture (TO-BE)

### 4.1 Components
```
┌──────────────────────────────────────────────────────────────┐
│ PriceFeedService (NEW)                                         │
│  - Binance WebSocket (ethusdt@bookTicker / @trade)            │
│  - auto-reconnect (exponential backoff), heartbeat            │
│  - staleness watchdog → REST fallback + pause trading         │
│  - emits normalized {price, ts} ticks                         │
└───────────────┬──────────────────────────────────────────────┘
                │ tick
                ▼
┌──────────────────────────────────────────────────────────────┐
│ StrategyEngine (NEW)  — the state machine                     │
│  - loads/persists BotState (the "table")                      │
│  - updates anchor (trough/peak)                               │
│  - evaluates trigger (price vs anchor ± Δ)                    │
│  - applies cooldown / staleness / profit guard               │
│  - decides: BUY | SELL | HOLD                                 │
└───────────────┬──────────────────────────────────────────────┘
                │ decision = BUY/SELL
                ▼
┌──────────────────────────────────────────────────────────────┐
│ ExecutionService (refactor of ammService usage)               │
│  - acquire persistent lock (atomic)                          │
│  - snapshot balances → performSwap() → wait receipt          │
│  - compute REALIZED rate from balance deltas                 │
│  - compute gas (MATIC) + GST correctly                       │
│  - write Order (fixed schema) + update BotState atomically   │
│  - release lock                                              │
└──────────────────────────────────────────────────────────────┘
```

### 4.2 Why WebSocket (fixes B-12)
- REST + 30s cron means decisions use 30–60s-old data. A 0.05 reversal is invisible
  at that resolution.
- A WebSocket stream pushes sub-second updates, so the trailing anchor/trigger can
  detect the *actual* turn. The trading loop becomes **event-driven** (on each tick),
  not time-driven.
- We keep a **REST fallback**: if the socket drops or goes stale beyond
  `MAX_PRICE_STALENESS_MS`, the engine **stops trading** (does not trade on stale data)
  and attempts reconnect; REST is used only to keep a heartbeat / resume.

### 4.3 Price-feed consistency (addresses B-2)
Decisions and recorded prices must come from a **single, well-defined source**:
- **Decision feed:** Binance WebSocket (fast, fine-grained) — used for the trailing logic.
- **Recorded order rate:** the **realized rate** from on-chain balance deltas
  (`amountReceived / amountSent`). This is the truth and removes the synthetic-rate bug (B-3).
- **Chainlink:** stored as an *informational* reference field only (the contract itself
  executes against Chainlink + pip). We never compare Binance against Chainlink for a decision.

> The unavoidable tension: the contract executes at **Chainlink + pip**, but we *decide*
> on Binance. We mitigate by (a) recording realized rate, (b) optional `MIN_NET_PROFIT`
> guard computed from realized deltas, and (c) optional pre-trade sanity check that
> Chainlink and Binance agree within a tolerance. See **OD-4**.

### 4.4 The state table (persistence) — fixes B-3, B-4, B-11
A single persisted `BotState` document is the source of truth (not "last order side").
Persisted so a restart resumes correctly; lock fields make concurrency safe.

### 4.5 Execution & reconciliation — fixes B-5, B-6(partial), B-9, B-10
- Realized amounts come from before/after balance deltas (already partly done — keep & harden).
- GST applied per the **actual** rule (and `gst_flag`/`gst_applied` persisted).
- Trade size from `TRADE_SIZE_MODE` (not hard-coded 100%).
- Min-output: cannot be enforced on-chain with current ABI (B-6) → **journaling + post-trade
  validation**: if realized rate is worse than tolerance, raise alert / pause. True on-chain
  protection requires a contract change (OD-5).

---

## 5. Functional Requirements

| ID | Requirement | Fixes |
|---|---|---|
| FR-1 | The system SHALL ingest ETH/USDT prices in real time via Binance WebSocket and normalize each update to `{price:number, ts:number}`. | B-12 |
| FR-2 | The system SHALL auto-reconnect on socket close/error with exponential backoff and detect staleness (`MAX_PRICE_STALENESS_MS`); while stale it SHALL NOT place trades. | B-12 |
| FR-3 | The system SHALL maintain a persisted `BotState` with `position`, `anchorPrice`, and lock fields, and resume from it on restart. | B-3, B-4, B-11 |
| FR-4 | On each tick, when `IN_USDT`, the engine SHALL set `anchor = min(anchor, price)` and BUY when `price ≥ anchor + Δ`. | B-1 |
| FR-5 | On each tick, when `IN_WETH`, the engine SHALL set `anchor = max(anchor, price)` and SELL when `price ≤ anchor − Δ`. | B-1 |
| FR-6 | `Δ` and `THRESHOLD_MODE` SHALL be configurable without code change. | B-1 |
| FR-7 | The engine SHALL strictly alternate BUY/SELL via `position`, never via reading the last order's side. | B-3, B-4 |
| FR-8 | Before executing, the system SHALL acquire an **atomic persistent lock**; only one swap may be in flight. | B-11 |
| FR-9 | Order `rate` SHALL be the **realized rate** from on-chain balance deltas; Chainlink rate stored only as a reference field. | B-2, B-3 |
| FR-10 | GST SHALL be applied per the defined rule and the decision (`gst_applied`) SHALL be persisted on the order. | B-5 |
| FR-11 | `order_code` generation SHALL be race-safe and type-consistent (atomic counter; numeric). | B-8 |
| FR-12 | The order schema SHALL include all written fields (`route`, `gst_applied`, `realized_rate`, `chainlink_rate`, `trigger_price`, `anchor_price`, `tx_hash`). | B-9 |
| FR-13 | Trade size SHALL follow `TRADE_SIZE_MODE`. | B-10 |
| FR-14 | An optional `MIN_NET_PROFIT` guard SHALL block trades whose estimated net result is below the configured minimum. | B-7 |
| FR-15 | The system SHALL provide a **dry-run / paper-trading** mode that runs the full strategy and records intended orders WITHOUT sending on-chain transactions. | (testing) |
| FR-16 | The system SHALL log every decision (BUY/SELL/HOLD) with the inputs used (price, anchor, Δ, reason). | observability |
| FR-17 | On swap failure, the system SHALL release the lock, leave `position` unchanged, and retry/recover per policy (reuse existing pause/unpause recovery). | reliability |
| FR-18 | A pre-trade sanity check MAY compare Binance vs Chainlink within tolerance and skip/alert on large divergence. | B-2 (OD-4) |

---

## 6. Non-Functional Requirements
| ID | Requirement |
|---|---|
| NFR-1 (Latency) | Tick→decision evaluation < 50 ms; the bottleneck is on-chain settlement, not the engine. |
| NFR-2 (Reliability) | No trade on stale/missing price data; survive socket drops and process restarts without losing position. |
| NFR-3 (Consistency) | Order record + BotState update committed together; no "swapped but not recorded" or double-recorded states. |
| NFR-4 (Security) | No secrets in source. Private key/RPC key loaded from environment/secret store; key rotated. |
| NFR-5 (Observability) | Structured logs + minimal metrics (trades/hr, realized PnL, gas spend, socket uptime, errors). |
| NFR-6 (Configurability) | All strategy params adjustable via env/DB without redeploy where practical. |
| NFR-7 (Auditability) | Every order traceable to the tx hash and the tick/anchor that triggered it. |

---

## 7. Data Model

### 7.1 `BotState` (NEW — the "table") — singleton
| Field | Type | Notes |
|---|---|---|
| `key` | String | Fixed `"singleton"`, unique. |
| `position` | String | `IN_USDT` \| `IN_WETH`. |
| `anchorPrice` | Number | trough (IN_USDT) or peak (IN_WETH). |
| `anchorUpdatedAt` | Date | |
| `lastActionPrice` | Number | price at last executed trade. |
| `lastActionAt` | Date | for cooldown. |
| `threshold` | Number | effective Δ. |
| `isExecuting` | Boolean | persistent lock. |
| `lockedAt` | Date | lock timeout / stale-lock recovery. |
| `updatedAt` | Date | |

### 7.2 `Order` (REVISED schema)
| Field | Change |
|---|---|
| `order_code` | → atomic numeric sequence (see FR-11). |
| `rate` | = **realized rate** (USDT per WETH from deltas). |
| `realized_rate` | NEW (explicit; can mirror `rate`). |
| `chainlink_rate` | NEW (reference only). |
| `trigger_price` | NEW (the tick price that fired the trade). |
| `anchor_price` | NEW (trough/peak at trigger). |
| `gst_applied` | NEW (Boolean) + keep `gst_charge`. |
| `route` | NEW field so it actually persists. |
| `tx_hash` | NEW. |
| existing | `side, amount, quantity, gas_fee, gst_charge, special, status` retained. |

### 7.3 `Counter` (NEW) — for atomic `order_code`
`{ _id: "order_code", seq: Number }` updated with `findOneAndUpdate($inc)`.

### 7.4 `CryptoRate` / tick log
Keep for history/audit, but it is **no longer the decision path**. Optionally throttle
writes (e.g., 1/sec) to avoid bloat from the WS stream.

---

## 8. Implementation Roadmap (phased)

> Each phase is independently shippable and testable. **Phase 0 first — it's security.**

### Phase 0 — Safety & hygiene (do immediately)
- Rotate the leaked private key (B-13); move secrets to env/secret store; scrub
  `ecosystem.config.js`.
- `git init` (repo currently untracked) + `.gitignore` for `.env`, keys, `node_modules`.
- Archive the dead/dated duplicate files into `backend/_archive/` (B-14).
- **Acceptance:** no secret in any tracked file; only one canonical job + service file in the live path.

### Phase 1 — Real-time price feed
- `PriceFeedService` (Binance WS), reconnect, heartbeat, staleness watchdog, REST fallback.
- Emit normalized ticks; optional throttled persistence to `crypto_rates`.
- **Acceptance:** continuous tick stream; on forced socket kill, reconnects and flags staleness; no trade attempts while stale.

### Phase 2 — State machine + state table
- `BotState` model + load/persist; `StrategyEngine.onTick()` updating anchor and computing BUY/SELL/HOLD.
- Strict alternation via `position`. Cold-start initialization (set initial position from real wallet balances, not `rate=0`).
- **Acceptance:** unit tests over a synthetic tick series produce the exact buy/sell points from §3.3; restart mid-run resumes correct state.

### Phase 3 — Trigger engine (Δ logic) + guards
- Implement `Δ`, `THRESHOLD_MODE`, `COOLDOWN_MS`, optional `MIN_NET_PROFIT`.
- **Acceptance:** trades fire only on `±Δ` reversals; sub-Δ noise produces no trades; cooldown respected.

### Phase 4 — Execution hardening
- Persistent atomic lock (FR-8); balance-delta realized rate (FR-9); correct GST + `gst_applied` (FR-10); trade sizing (FR-13); journaling so a crash between swap and record is reconciled.
- **Acceptance:** concurrent invocations cannot double-trade; every executed swap has a matching order with realized rate and tx hash.

### Phase 5 — Schema & accounting fixes
- New `Order` fields + atomic `order_code` counter (FR-11/12); migrate/backfill if needed.
- **Acceptance:** 1,000 rapid saves produce unique sequential codes, no NaN; `route`/`gst_applied` persisted.

### Phase 6 — Slippage / execution safety (needs decision)
- If OD-5 = yes: add `minAmountOut` to the contract `swapWithAmount` and pass it.
- If OD-5 = no: post-trade realized-rate validation + alert/pause on bad fills.
- **Acceptance:** a deliberately bad fill is detected and handled per chosen path.

### Phase 7 — Observability
- Structured logs, decision log, metrics (trades/hr, realized PnL, gas, socket uptime), alerts on errors/stale/bad-fill.
- **Acceptance:** dashboard/log shows live position, anchor, last decision reason, PnL.

### Phase 8 — Validation & rollout
- Backtest engine over recorded ticks; **paper-trading** mode (FR-15) live for N days; small-size **canary** on mainnet; then full size.
- **Acceptance:** paper run matches backtest expectations; canary executes correct buy/sell points with acceptable realized PnL.

---

## 9. Testing & Validation Strategy
- **Unit:** StrategyEngine over crafted tick arrays (rising, falling, choppy, gap, flat) → asserts exact BUY/SELL/HOLD and anchor values.
- **Property tests:** never two BUYs or two SELLs in a row; never trade while stale/locked.
- **Integration:** PriceFeed → Engine → mocked Execution; simulate socket drop, RPC failure, swap revert.
- **Backtest:** replay historical/recorded ticks, report round trips, gross/net PnL after gas+GST+pip.
- **Paper trade:** full live pipeline, `DRY_RUN=true`, records intended orders only.
- **Canary:** minimum trade size on mainnet with tight monitoring.

---

## 10. Security Requirements
- SEC-1: Rotate the exposed key in `ecosystem.config.js` **now**; treat it as compromised.
- SEC-2: Secrets only via env/secret manager; never committed.
- SEC-3: `.gitignore` covers `.env`, key files, `ecosystem.config.js` (or strip its secrets).
- SEC-4: Least-privilege RPC key; rotate the Infura key too.
- SEC-5: Verify `WETH_TOKEN_ADDRESS` / `USDT_TOKEN_ADDRESS` / `AMM_CONTRACT_ADDRESS` are the intended contracts before any live run.

---

## 11. Decisions — **LOCKED 2026-06-14** (by stakeholder)
| ID | Decision | Final ruling |
|---|---|---|
| OD-1 | `Δ` units | **Absolute USD `0.05`** (configurable). |
| OD-2 | `MIN_NET_PROFIT` guard | **Not implemented** — negligible effect on strategy per stakeholder. (Param hook may exist but stays OFF.) |
| OD-3 | Trade size | **100% of balance each trade** (current behavior), kept configurable. |
| OD-4 | Binance-vs-Chainlink divergence check | **Deferred** — functional-first; revisit after the bot trades correctly locally. |
| OD-5 | On-chain slippage / contract change | **Not done** — negligible effect per stakeholder; no contract change. |
| OD-6 | Execution path | **Keep current AMM + Chainlink** path (`swapWithAmount`). |

> Rollout intent: build & validate on **localhost** first; only after the bot trades per
> strategy and is profitable do we consider hosting. Hosting-time hardening
> (secret rotation, secret store, PM2/multi-instance) is explicitly a **later** phase.

---

## 12. Traceability (bug → requirement)
| Bug | Addressed by |
|---|---|
| B-1 (0.05 not a trigger) | FR-4, FR-5, FR-6, §3.2 |
| B-2 (mixed feeds) | FR-9, FR-18, §4.3 |
| B-3 (synthetic rate baseline) | FR-3, FR-7, FR-9 |
| B-4 (cold start) | FR-3, Phase 2 cold-start init |
| B-5 (GST flag unused) | FR-10, §7.2 |
| B-6 (no slippage) | FR-9 + Phase 6 / OD-5 |
| B-7 (margins dead) | FR-14 |
| B-8 (order_code NaN) | FR-11, §7.3 |
| B-9 (route dropped) | FR-12, §7.2 |
| B-10 (100% size) | FR-13, OD-3 |
| B-11 (in-memory lock) | FR-8, §7.1 |
| B-12 (stale prices) | FR-1, FR-2, §4.2 |
| B-13 (secret leak) | SEC-1..SEC-4, Phase 0 |
| B-14 (dead files) | Phase 0 hygiene |

---

## 13. Sign-off
| Role | Name | Decision | Date |
|---|---|---|---|
| Product owner | | ☐ Approved ☐ Changes requested | |
| Engineering | | ☐ Approved | |

> Next step after approval: lock the **Open Decisions (§11)**, then begin **Phase 0**.
