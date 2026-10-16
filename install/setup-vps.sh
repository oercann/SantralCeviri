#!/usr/bin/env bash
# Çeviri Asistanı — VPS kurulum scripti (Ubuntu 24.04)
# Kullanım: sudo bash setup-vps.sh
set -euo pipefail

if [[ $EUID -ne 0 ]]; then echo "root olarak çalıştır (sudo)"; exit 1; fi

APP_DIR=/opt/ceviri
ENV_FILE=/etc/ceviri.env
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "==> Paketler"
apt-get update -y
apt-get install -y asterisk curl ufw git unzip sox rsync ca-certificates gnupg

echo "==> Node.js 20"
if ! command -v npm >/dev/null || ! command -v node >/dev/null || [[ "$(node -v | cut -c2-3)" -lt 20 ]]; then
  apt-get remove -y nodejs npm 2>/dev/null || true
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

echo "==> Ortam dosyası"
if [[ ! -f $ENV_FILE ]]; then
  cp "$HERE/ceviri.env.example" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "!! $ENV_FILE dosyasını düzenle (Telnyx, OpenAI anahtarları, numaralar)"
fi
set -a; source "$ENV_FILE"; set +a

PUBLIC_IP="${PUBLIC_IP:-$(curl -s4 https://api.ipify.org || true)}"
echo "Public IP: $PUBLIC_IP"

echo "==> Asterisk yapılandırması"
cp -n /etc/asterisk/pjsip.conf /etc/asterisk/pjsip.conf.orig 2>/dev/null || true
for f in pjsip.conf extensions.conf ari.conf http.conf rtp.conf; do
  sed -e "s|__PUBLIC_IP__|$PUBLIC_IP|g" \
      -e "s|__TRUNK_USER__|${TRUNK_USER:-}|g" \
      -e "s|__TRUNK_PASS__|${TRUNK_PASS:-}|g" \
      -e "s|__TRUNK_HOST__|${TRUNK_HOST:-sip.telnyx.com}|g" \
      -e "s|__ARI_USER__|${ARI_USER:-ceviri}|g" \
      -e "s|__ARI_PASS__|${ARI_PASS:-degistir}|g" \
      -e "s|__MY_CELL__|${MY_CELL:-}|g" \
      "$HERE/asterisk/$f" > /etc/asterisk/$f
done
chown asterisk:asterisk /etc/asterisk/*.conf
systemctl enable asterisk
systemctl restart asterisk

echo "==> Uygulama"
mkdir -p $APP_DIR
rsync -a --delete "$HERE/../server/" $APP_DIR/server/
rsync -a --delete "$HERE/../web/" $APP_DIR/web/
cd $APP_DIR/server && npm install --omit=dev

cat > /etc/systemd/system/ceviri.service <<EOF
[Unit]
Description=Ceviri Asistani
After=network.target asterisk.service

[Service]
EnvironmentFile=$ENV_FILE
WorkingDirectory=$APP_DIR/server
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=3
User=root

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now ceviri

echo "==> Sertleştirme"
apt-get install -y fail2ban
cat > /etc/fail2ban/jail.d/ceviri.local <<'JAIL'
[sshd]
enabled = true
maxretry = 4
bantime = 1h
[asterisk]
enabled = true
port = 5060
logpath = /var/log/asterisk/messages
maxretry = 3
bantime = 24h
JAIL
systemctl enable --now fail2ban
# SSH: sadece anahtar ile giriş (önce anahtarını eklediğinden emin ol!)
if [[ -s /root/.ssh/authorized_keys ]]; then
  sed -i 's/^#\?PasswordAuthentication .*/PasswordAuthentication no/' /etc/ssh/sshd_config
  systemctl restart ssh || systemctl restart sshd || true
fi

echo "==> Firewall"
ufw allow 22/tcp
# SIP sadece Telnyx sinyalleşme ağlarından (TRUNK_IPS ile değiştirilebilir)
for net in ${TRUNK_IPS:-192.76.120.0/24 64.16.250.0/24 185.246.41.0/24 50.114.136.0/21}; do
  ufw allow from "$net" to any port 5060 proto udp
done
ufw allow 10000:20000/udp
ufw allow 8443/tcp
ufw --force enable

echo
echo "Kurulum tamam."
echo "- Loglar: journalctl -u ceviri -f   |  asterisk -rvvv"
echo "- PWA: https://$PUBLIC_IP:8443  (veya Cloudflare Pages'tan)"
