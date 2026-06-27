#!/usr/bin/env bash
# setup.sh — Installerar bounce-processor på en ny server (eller fork).
# Allt annat (monitor, letter-generator, letter-sender, bounce-sweep, issue-fixer)
# körs som Cloudflare Workers och kräver ingen serverinstallation.
#
# Krav: Ubuntu/Debian, sudo-behörighet, git-repot utcheckat.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$HOME/.appdata/.config/.env"
SERVICE_DIR="/etc/systemd/system"

echo "=== politiker-webapp setup ==="
echo "Repokatalog: $REPO_DIR"

# --- 1. Beroenden ---
echo "[1/5] Kontrollerar beroenden..."
if ! command -v python3 &>/dev/null; then
  echo "  Installerar python3..."
  sudo apt-get install -y python3
fi
if ! command -v msmtp &>/dev/null; then
  echo "  Installerar msmtp..."
  sudo apt-get install -y msmtp
fi

# --- 2. Miljövariabler ---
echo "[2/5] Konfigurerar .env..."
mkdir -p "$(dirname "$ENV_FILE")"
if [ ! -f "$ENV_FILE" ]; then
  cp "$REPO_DIR/infra/.env.example" "$ENV_FILE"
  echo "  Skapad: $ENV_FILE"
  echo "  OBS: Fyll i värdena i $ENV_FILE innan du fortsätter."
  echo "  Kör sedan: bash $REPO_DIR/infra/setup.sh"
  exit 0
else
  echo "  Finns redan: $ENV_FILE"
fi

# Läs variabler
source <(grep -v '^#' "$ENV_FILE" | grep '=' | sed 's/^/export /')

if [ -z "${GMAIL_EMAIL:-}" ] || [ -z "${GMAIL_PASSWORD:-}" ]; then
  echo "  FEL: GMAIL_EMAIL och GMAIL_PASSWORD måste vara ifyllda i $ENV_FILE"
  exit 1
fi

# --- 3. msmtp ---
echo "[3/5] Konfigurerar msmtp..."
if [ ! -f /etc/msmtprc ]; then
  sudo tee /etc/msmtprc > /dev/null <<MSMTPRC
defaults
auth           on
tls            on
tls_trust_file /etc/ssl/certs/ca-certificates.crt
logfile        /var/log/msmtp.log

account        gmail
host           smtp.gmail.com
port           587
from           ${GMAIL_EMAIL}
user           ${GMAIL_EMAIL}
password       ${GMAIL_PASSWORD}

account default : gmail
MSMTPRC
  sudo chmod 600 /etc/msmtprc
  echo "  /etc/msmtprc skapad"
else
  echo "  /etc/msmtprc finns redan (rör inte)"
fi

# --- 4. systemd-tjänster ---
echo "[4/5] Installerar systemd-tjänster..."
for f in bounce-processor.service bounce-processor.timer; do
  sudo cp "$REPO_DIR/infra/$f" "$SERVICE_DIR/$f"
  echo "  Installerade: $f"
done

sudo systemctl daemon-reload
sudo systemctl enable --now bounce-processor.timer
echo "  bounce-processor.timer aktiverad"

# --- 5. Verifiera ---
echo "[5/5] Verifierar..."
systemctl is-active bounce-processor.timer && echo "  bounce-processor.timer: aktiv" || echo "  bounce-processor.timer: INTE aktiv"

echo ""
echo "=== Klar ==="
echo "bounce-processor körs dagligen kl 06:00."
echo ""
echo "Cloudflare Workers (campaign) deployas via:"
echo "  cd $REPO_DIR/campaign && npm install && npx wrangler deploy"
echo ""
echo "Secrets som måste sättas via 'wrangler secret put':"
echo "  ANTHROPIC_API_KEY"
echo "  GMAIL_EMAIL"
echo "  GMAIL_PASSWORD"
echo "  GITHUB_FEEDBACK_TOKEN"
