# Deploying the bot on a DigitalOcean droplet (24/7)

The bot is a single Node.js process that only makes **outgoing** connections
(Base RPC, Binance market data, MongoDB Atlas). It needs no open ports, no web
server and no domain.

## 1. Create the droplet

| Setting | Value | Why |
|---|---|---|
| Region | **Bangalore (BLR1)** or **Singapore (SGP1)** — **not US** | Binance blocks US IPs; the volume/ATR/RSI filters read Binance |
| Image | Ubuntu 24.04 LTS | |
| Size | Basic, Regular, **1 GB RAM** ($6/mo) | 512 MB is too tight for `npm ci` |
| Authentication | **SSH key** (never a password) | `ssh-keygen -t ed25519` on your PC, paste `~/.ssh/id_ed25519.pub` |
| Options | enable **Monitoring** (free) | CPU / RAM / disk graphs + alerts |

Optional but recommended: DigitalOcean **Cloud Firewall** with *inbound: SSH (22)
from your IP only*, *outbound: all*.

## 2. Harden + install (one command, as root)

```bash
ssh root@<IP>
curl -fsSL https://raw.githubusercontent.com/anopsingh706/Ether_trading_bot/main/backend/deploy/setup-droplet.sh -o setup.sh
less setup.sh      # read before running
bash setup.sh
```

It installs updates (+ automatic security updates), a firewall (SSH only),
fail2ban, key-only SSH, swap, Node.js 20 and pm2, creates the unprivileged user
**`eather`** that runs the bot, and clones this repo. It prints the droplet's
**public IP** at the end.

## 3. MongoDB Atlas

1. **Network Access → Add IP Address** → the droplet IP printed above.
2. Recommended — a dedicated, least-privilege database user for the server:
   **Database Access → Add New User** → role *readWrite* on database
   **`jan25au_botsim`** only. Put its URL in your local `.env` as
   `BOT_DB_URL=mongodb+srv://<user>:<password>@<cluster>/jan25au_botsim`
   (the bot prefers `BOT_DB_URL` over `DB_URL`). A leaked server then can't touch
   any other database.

## 4. Secrets: build a minimal `.env` and copy it over SSH

Secrets **never** go through GitHub. On your PC (in `backend/`):

```powershell
node deploy/make-server-env.js        # writes .env.server (git-ignored) — only what the bot reads
scp .env.server eather@<IP>:Ether_trading_bot/backend/.env
Remove-Item .env.server               # don't leave a second copy lying around
```

`make-server-env.js` keeps only the variables the bot code reads and drops the
rest (exchange API keys, 0x key, spare RPC URLs, the other chain's settings…).
It prints variable **names** only.

On the server:

```bash
ssh eather@<IP>
chmod 600 ~/Ether_trading_bot/backend/.env      # readable by the bot user only
```

## 5. Start (stop the bot on your PC first — only ONE live instance)

```bash
cd ~/Ether_trading_bot/backend
pm2 start botRunner.js --name eather-bot
pm2 save                                         # restored automatically after reboot/crash
pm2 logs eather-bot                              # check: LIVE · chain : Base … · exits : REGIME mode
```

## 6. Web dashboard (watch + control, from any phone or PC)

Shows: bot running / paused / not responding, live price, position, profit/loss
(today + all-time), wallet balance, circuit breaker, live status line, every trade
with an explorer link, and an audit log of dashboard actions.
**Admin** login can **Pause** (no new buys — an open position is still managed),
**Resume**, **Reset circuit breaker**, and **Emergency sell & pause** (type SELL to
confirm). **Viewer** login (e.g. a friend) can only look. Commands go through the
database and are carried out by the bot itself; the dashboard process never has
the wallet key.

1. **Free domain:** sign in at **duckdns.org** (Google/GitHub), add a sub-domain
   (e.g. `eatherbot`), set *current ip* to the droplet IP, press *update ip*.
2. **HTTPS (as root):**
   `bash /home/eather/Ether_trading_bot/backend/deploy/setup-dashboard.sh eatherbot.duckdns.org`
3. **Users (as `eather`):** `cd ~/Ether_trading_bot/backend && npm run dash:user` —
   once with role *admin* (you), once with *viewer* (your friend). Paste the printed
   `DASH_*` lines into `.env` (`DASH_SECRET` only once).
4. **Start it:** `pm2 start dashboard/server.js --name eather-dash && pm2 save`
5. Open **https://eatherbot.duckdns.org** and sign in. Change a password: run
   `npm run dash:user` again, replace that user's lines, `pm2 restart eather-dash`.

### Buy / sell trigger (dashboard)

The **Buy / sell trigger** card sets how far the price must move before the bot acts:
**Manual $** (default **$1 / $1**) — buy when price rises $X off the low, sell when it falls
$Y off the peak (sells only above break-even); use **− / +** ($0.25 steps, $0.10–$100) and
**Save trigger** — the bot applies it within ~3 s and keeps it across restarts.
**Auto (ATR)** switches back to the volatility-adaptive trigger. "In force now" shows what
the bot is actually using. Viewers can see it but not change it.

## 7. Circuit breaker (automatic loss stop)

Stops **new buys** (never sells) when losses pile up — defaults, all editable in `.env`:

| Limit | Default | Clears |
|---|---|---|
| `BOT_CB_MAX_CONSEC_LOSSES` | 5 losing trades in a row | manual reset |
| `BOT_CB_MAX_DAILY_LOSS_USD` | −$2 in one UTC day | automatically at 00:00 UTC |
| `BOT_CB_MAX_DRAWDOWN_USD` | P/L −$5 below its best | manual reset |

A trip shows on the dashboard and survives restarts. To resume after you've looked
at what happened: press **Reset circuit breaker** on the dashboard (or, on the
server, `npm run cb:reset && pm2 restart eather-bot`).

## Everyday commands (as `eather`)

| What | Command |
|---|---|
| Live log | `pm2 logs eather-bot` (Ctrl+C only stops watching) |
| Status / memory / restarts | `pm2 status` |
| Stop / start / restart | `pm2 stop eather-bot` · `pm2 start eather-bot` · `pm2 restart eather-bot` |
| Change settings | `nano ~/Ether_trading_bot/backend/.env` then `pm2 restart eather-bot` |
| Update code | `cd ~/Ether_trading_bot && git pull --ff-only && cd backend && npm ci --omit=dev && pm2 restart eather-bot` |
| Dashboard logs / restart | `pm2 logs eather-dash` · `pm2 restart eather-dash` |
| Simulation instead | `pm2 start botSimRunner.js --name eather-sim -- --live --mode regime` |

## Security checklist

- [ ] SSH key login only (the setup script disables passwords).
- [ ] `.env` is `chmod 600`, owned by `eather`, never committed.
- [ ] The wallet holds **only trading funds** — the key lives on the server.
- [ ] Atlas: droplet IP allow-listed; dedicated DB user limited to `jan25au_botsim`.
- [ ] RPC: the bot fails over `mainnet.base.org` → `base-rpc.publicnode.com` → `BASE_RPC_URL` (optional keyed backup, e.g. Alchemy, HTTP only).
      Price comes from the pool's Swap events over the free `wss://base-rpc.publicnode.com`.
      Never point `BASE_WSS_URL` at Alchemy and never set `BOT_FEED_MIN_READ_MS` ≈ the block time —
      per-block reads used up the Alchemy free monthly quota in Nov 2026 (bot sat stale ~6 days).
- [ ] Never run `npm run bot` on your PC while the droplet bot is running.
- [ ] If the droplet is ever compromised: move funds to a new wallet first, then rotate the DB password and RPC key.
