# Eather Bot — Database Schema Reference

**You do NOT need to create anything by hand.** All collections are Mongoose models
that MongoDB creates automatically on the bot's first run against a fresh database.
This document is a reference for operating, querying, and debugging — not a migration
script.

---

## 1. Which database the bot uses

- The bot opens its **own dedicated connection** (`bot/db.js`) — never the legacy
  server's connection.
- URL resolution (`bot/config.js`):
  1. `BOT_DB_URL` if set — use exactly this.
  2. Otherwise **derived from `DB_URL`** by swapping the database name to
     **`jan25au_botsim`** (e.g. `…/jan25au_prod` → `…/jan25au_botsim`).
- On a brand-new system: point `DB_URL` (or `BOT_DB_URL`) at your cluster; the
  database + collections appear on first run.

### Fresh-database behavior (what to expect on first run)
| Situation | What happens |
|---|---|
| No `bot_state` doc | Created automatically (`position: IN_USDT`, no anchor). Banner: `🆕 initialised fresh state`. |
| `order_code` counter | Starts from 1 (per-database sequence — codes restart in a new DB). |
| Wallet already holds WETH but DB has no BUY record | Bot reconciles to `IN_WETH`, but the **cost basis is unknown** → the break-even floor can't be computed for that inherited position; it exits on classic trailing. Everything is normal from the next BUY. |
| Cloned system pointed at the **same** DB as the original | Resumes the exact position, cost basis, break-even level, and P&L history. ⚠️ Never run two bots on the same wallet simultaneously. |

---

## 2. Collections (live path — `backend/bot/models/`)

### `bot_state` — the state machine (singleton documents)
One document per mode, keyed by `key`:
- **`"singleton"`** — the LIVE bot's state.
- **`"sim-singleton"`** — the simulation's state (`npm run sim`); fully isolated.

| Field | Type | Meaning |
|---|---|---|
| `key` | String (unique) | `singleton` \| `sim-singleton` |
| `position` | String | `IN_USDT` (flat, waiting to buy) \| `IN_WETH` (holding) |
| `anchorPrice` | Number | Trailing extreme: lowest price since last SELL (`IN_USDT`) or highest since last BUY (`IN_WETH`). Cleared on restart (re-anchor). |
| `anchorUpdatedAt` | Date | Last anchor move |
| `lastActionPrice` / `lastActionAt` | Number / Date | Price/time of the last executed trade (drives cooldown) |
| `threshold` | Number | Legacy Δ recorded at init (informational) |
| `entryUsdt` | Number | Cost basis: USDC spent on the open position (null when flat) |
| `entryWeth` | Number | WETH bought for the open position |
| `entryPrice` | Number | Realized entry rate (USDC per WETH) |
| `entryGas` | Number | Gas (USD) paid on the entry leg — subtracted from the round-trip net |
| `entryAt` | Date | Entry time (status line shows underwater hours from this) |
| `roundTrips` / `wins` / `losses` | Number | Completed BUY→SELL cycles and their outcomes (net of gas) |
| `cumulativePnl` | Number | Running realized net P&L (USDC) |
| `isExecuting` / `lockedAt` | Boolean / Date | **Atomic cross-process trade lock** — prevents a second instance/crash-resume from double-trading. Locks older than 2 min are treated as stale and recoverable. |
| `simUsdt` / `simWeth` / `simGasUsd` | Number | Virtual balances + cumulative simulated gas (sim doc only) |
| `txCount` | Number | Total swaps executed (BUY + SELL each count 1; drives the sim's `tx N/target` display) |
| `dryRun` | Boolean | Legacy field (dry-run mode was removed) |
| `createdAt` / `updatedAt` | Date | Mongoose timestamps |

**Break-even note:** the BE floor is *not stored* — it is recomputed every tick from
`entryUsdt`, `entryWeth`, the pool fee, and `BOT_BE_BUFFER_PCT`, so it survives
restarts as long as the cost basis fields are intact.

### `bot_orders` — one document per executed swap (the ledger)

| Field | Type | Meaning |
|---|---|---|
| `order_code` | Number (unique) | Atomic sequence from `bot_counters` |
| `side` | Number | `1` = BUY, `2` = SELL |
| `currency1` / `currency2` | String | `USDT→WETH` on buys, `WETH→USDT` on sells (USDT = USDC.e) |
| `amount` | Number | USDC leg: **spent** on BUY, **received** on SELL |
| `quantity` | Number | WETH leg: **received** on BUY, **sold** on SELL |
| `realized_rate` / `rate` | Number | Actual achieved price (USDC per WETH) from on-chain balance deltas — never a quote |
| `chainlink_rate` | Number | Legacy reference field (0 on the Uniswap path) |
| `trigger_price` | Number | The tick price that fired the trade |
| `anchor_price` | Number | The trailing peak/bottom that triggered it |
| `profit` | Number\|null | SELL only: **NET** round-trip USDC profit (after both legs' gas) |
| `profit_gross` | Number\|null | SELL only: gross profit before gas |
| `profit_pct` | Number\|null | SELL only: net % return on the round trip |
| `exit_reason` | String\|null | SELL only: `profit-take` \| `breakeven` \| `disaster` \| `stop-loss` \| `trend-down` |
| `slippage_bps` | Number | Fill deviation from the decision price (basis points) |
| `gas_fee` | Number | Gas for THIS swap (USD) |
| `gst_charge` / `gst_applied` | Number / Boolean | Legacy AMM-era accounting (recorded, not deducted) |
| `route` | String | **`UNISWAP`** = live trade · **`UNISWAP-SIM`** = simulation · `AMM` = legacy |
| `dry_run` | Boolean | `true` only for simulation orders |
| `tx_hash` | String\|null | Polygon transaction hash (null in sim) |
| `special` / `status` | Number | Legacy compatibility fields |
| `createdAt` / `updatedAt` | Date | Mongoose timestamps |

**Filter cheat-sheet:** live trades `{ dry_run: { $ne: true } }` · sim trades
`{ route: 'UNISWAP-SIM' }` · completed round trips `{ side: 2 }` · realized P&L =
sum of `profit` over sells.

### `bot_ticks` — throttled price log (audit only)

| Field | Type | Meaning |
|---|---|---|
| `symbol` | String | e.g. `ethusdt` |
| `price` | Number | Pool price at log time |
| `source` | String | `block` (WSS) \| `poll` \| `init` \| `ws` \| `rest` |
| `created_at` | Date (indexed) | Timestamp |

Written at most once per `BOT_PERSIST_MS` (default 3s); **never used for decisions**
(the live feed drives those in memory). Safe to prune/TTL if it grows.

### `bot_counters` — atomic sequences

| Field | Type | Meaning |
|---|---|---|
| `_id` | String | Sequence name — currently only `bot_order_code` |
| `seq` | Number | Last issued value (`$inc` upsert = race-safe) |

---

## 3. Legacy collections (NOT used by the bot)

The deprecated server app (`server.js`, `jobs/`, `services/` — the old closed-loop AMM
system) used its own collections in the production DB (`orders`, `crypto_rates`,
`admins`, …). The bot never reads or writes them; a fresh bot database will simply not
have them. See `docs/PROJECT_STATUS.md` §2 for why that system was abandoned.
