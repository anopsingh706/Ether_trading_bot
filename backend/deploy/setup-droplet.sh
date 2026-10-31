#!/usr/bin/env bash
# deploy/setup-droplet.sh — one-time setup of a FRESH Ubuntu 22.04/24.04 droplet
# ─────────────────────────────────────────────────────────────────────────────
# Hardens the server and installs everything the bot needs. It does NOT copy any
# secrets and does NOT start the bot — you copy .env yourself (scp) and start it.
#
#   Run as root on the droplet:
#     curl -fsSL https://raw.githubusercontent.com/anopsingh706/Ether_trading_bot/main/backend/deploy/setup-droplet.sh -o setup.sh
#     less setup.sh          # read it first
#     bash setup.sh
#
# What it does:
#   • security updates (now + automatic), firewall (SSH only in), fail2ban
#   • SSH: key-only logins (passwords off), root by key only
#   • unprivileged user "eather" that runs the bot (same SSH key as root)
#   • 1 GB swap, UTC clock + NTP, Node.js 20, pm2 (+ log rotation, start on boot)
#   • clones the repo into /home/eather/Ether_trading_bot and installs packages
# Safe to re-run.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

BOT_USER=eather
REPO_URL="${REPO_URL:-https://github.com/anopsingh706/Ether_trading_bot.git}"
APP_DIR="/home/${BOT_USER}/Ether_trading_bot"

[ "$(id -u)" -eq 0 ] || { echo "Run this as root."; exit 1; }
# passwords get disabled below — refuse to continue unless key login already works
[ -s /root/.ssh/authorized_keys ] || { echo "root has no SSH key in /root/.ssh/authorized_keys — add one first, or you would be locked out."; exit 1; }

echo "== 1/9 system updates"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get upgrade -y
apt-get install -y git curl ca-certificates ufw fail2ban unattended-upgrades
dpkg-reconfigure -f noninteractive unattended-upgrades

echo "== 2/9 swap (1 GB) + clock"
if ! swapon --show | grep -q '/swapfile'; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
timedatectl set-timezone UTC || true
timedatectl set-ntp true || true

echo "== 3/9 bot user '${BOT_USER}' (no password, no sudo)"
id "${BOT_USER}" >/dev/null 2>&1 || adduser --disabled-password --gecos "" "${BOT_USER}"
install -d -m 700 -o "${BOT_USER}" -g "${BOT_USER}" "/home/${BOT_USER}/.ssh"
install -m 600 -o "${BOT_USER}" -g "${BOT_USER}" /root/.ssh/authorized_keys "/home/${BOT_USER}/.ssh/authorized_keys"

echo "== 4/9 SSH hardening (key-only)"
cat > /etc/ssh/sshd_config.d/99-eather-hardening.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
MaxAuthTries 3
X11Forwarding no
EOF
sshd -t
systemctl reload ssh 2>/dev/null || systemctl reload sshd

echo "== 5/9 firewall (deny all incoming except SSH) + fail2ban"
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw --force enable
systemctl enable --now fail2ban

echo "== 6/9 Node.js 20 + pm2"
if ! command -v node >/dev/null 2>&1 || ! node -v | grep -q '^v20\.'; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
npm install -g pm2

echo "== 7/9 code"
if [ -d "${APP_DIR}/.git" ]; then
  sudo -u "${BOT_USER}" git -C "${APP_DIR}" pull --ff-only
else
  sudo -u "${BOT_USER}" git clone "${REPO_URL}" "${APP_DIR}"
fi
sudo -u "${BOT_USER}" bash -c "cd '${APP_DIR}/backend' && npm ci --omit=dev"

echo "== 8/9 pm2: start on boot + log rotation"
env PATH="$PATH:/usr/bin" pm2 startup systemd -u "${BOT_USER}" --hp "/home/${BOT_USER}" >/dev/null
sudo -u "${BOT_USER}" -H bash -c "pm2 install pm2-logrotate >/dev/null && pm2 set pm2-logrotate:max_size 20M >/dev/null && pm2 set pm2-logrotate:retain 10 >/dev/null"

echo "== 9/9 checks"
code=$(curl -s -o /dev/null -w '%{http_code}' https://api.binance.com/api/v3/ping || true)
if [ "${code}" = "200" ]; then echo "   Binance reachable ✅"; else echo "   ⚠️  Binance returned HTTP ${code} — wrong region (e.g. US)? The volume/ATR/RSI filters need Binance."; fi
echo "   Droplet public IP (add it in MongoDB Atlas → Network Access): $(curl -s https://api.ipify.org || echo '?')"

cat <<EOF

✅ Server ready. Next (see backend/docs or docs/DEPLOY.md):
   1) from your PC:  node deploy/make-server-env.js
                     scp .env.server ${BOT_USER}@<IP>:Ether_trading_bot/backend/.env
   2) on the server: ssh ${BOT_USER}@<IP>
                     chmod 600 ~/Ether_trading_bot/backend/.env
                     cd ~/Ether_trading_bot/backend && pm2 start botRunner.js --name eather-bot && pm2 save
EOF
