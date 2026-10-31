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

## Everyday commands (as `eather`)

| What | Command |
|---|---|
| Live log | `pm2 logs eather-bot` (Ctrl+C only stops watching) |
| Status / memory / restarts | `pm2 status` |
| Stop / start / restart | `pm2 stop eather-bot` · `pm2 start eather-bot` · `pm2 restart eather-bot` |
| Change settings | `nano ~/Ether_trading_bot/backend/.env` then `pm2 restart eather-bot` |
| Update code | `cd ~/Ether_trading_bot && git pull --ff-only && cd backend && npm ci --omit=dev && pm2 restart eather-bot` |
| Simulation instead | `pm2 start botSimRunner.js --name eather-sim -- --live --mode regime` |

## Security checklist

- [ ] SSH key login only (the setup script disables passwords).
- [ ] `.env` is `chmod 600`, owned by `eather`, never committed.
- [ ] The wallet holds **only trading funds** — the key lives on the server.
- [ ] Atlas: droplet IP allow-listed; dedicated DB user limited to `jan25au_botsim`.
- [ ] Private RPC (e.g. Alchemy with Base enabled) instead of the public `mainnet.base.org`.
- [ ] Never run `npm run bot` on your PC while the droplet bot is running.
- [ ] If the droplet is ever compromised: move funds to a new wallet first, then rotate the DB password and RPC key.
