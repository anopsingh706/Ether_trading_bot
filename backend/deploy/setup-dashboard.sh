#!/usr/bin/env bash
# deploy/setup-dashboard.sh — put the dashboard on https://<your-name>.duckdns.org
# ─────────────────────────────────────────────────────────────────────────────
# Run ONCE as root on the droplet, after the DuckDNS name points to this server:
#     bash ~eather/Ether_trading_bot/backend/deploy/setup-dashboard.sh yourname.duckdns.org
#
# Installs Caddy (web server with automatic, auto-renewing HTTPS certificates),
# forwards the domain to the dashboard on 127.0.0.1:8080, and opens ports 80/443.
# The dashboard itself never listens on a public port.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

DOMAIN="${1:-}"
[ "$(id -u)" -eq 0 ] || { echo "Run this as root."; exit 1; }
[ -n "${DOMAIN}" ] || { echo "Usage: bash setup-dashboard.sh yourname.duckdns.org"; exit 1; }
[[ "${DOMAIN}" =~ ^[A-Za-z0-9.-]+$ ]] || { echo "That doesn't look like a domain name."; exit 1; }

echo "== 1/4 checking that ${DOMAIN} points to this server"
MYIP=$(curl -s https://api.ipify.org || true)
DNSIP=$(getent ahostsv4 "${DOMAIN}" | awk 'NR==1{print $1}' || true)
if [ -z "${DNSIP}" ] || [ "${MYIP}" != "${DNSIP}" ]; then
  echo "   ${DOMAIN} points to '${DNSIP:-nothing}', but this server is ${MYIP}."
  echo "   Fix it on duckdns.org (current ip = ${MYIP}), wait a minute, then run this again."
  exit 1
fi
echo "   ✅ ${DOMAIN} → ${MYIP}"

echo "== 2/4 installing Caddy"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y caddy

echo "== 3/4 configuring HTTPS → dashboard (127.0.0.1:8080)"
cat > /etc/caddy/Caddyfile <<EOF
${DOMAIN} {
	encode gzip
	header Strict-Transport-Security "max-age=31536000"
	reverse_proxy 127.0.0.1:8080
}
EOF
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl enable caddy
systemctl restart caddy

echo "== 4/4 firewall: open 80 (certificate check + redirect) and 443 (HTTPS)"
ufw allow 80/tcp
ufw allow 443/tcp

cat <<EOF

✅ Caddy is serving https://${DOMAIN} (the certificate is fetched automatically on the
   first visit — it can take ~30 s). Next, as the eather user:
     cd ~/Ether_trading_bot/backend
     npm run dash:user            # once for you (admin), once for your friend (viewer)
     nano .env                    # paste the DASH_* lines it printed
     pm2 start dashboard/server.js --name eather-dash && pm2 save
EOF
