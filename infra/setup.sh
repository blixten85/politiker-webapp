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
CURRENT_USER="$(id -un)"

echo "=== politiker-webapp setup ==="
echo "Repokatalog: $REPO_DIR"

# --- 1. Beroenden ---
echo "[1/4] Kontrollerar beroenden..."
if ! command -v python3 &>/dev/null; then
  echo "  Installerar python3..."
  sudo apt-get install -y python3
fi

# --- 2. Miljövariabler ---
echo "[2/4] Konfigurerar .env..."
mkdir -p "$(dirname "$ENV_FILE")"
if [ ! -f "$ENV_FILE" ]; then
  install -m 600 "$REPO_DIR/infra/.env.example" "$ENV_FILE"
  echo "  Skapad: $ENV_FILE"
  echo "  OBS: Fyll i värdena i $ENV_FILE innan du fortsätter."
  echo "  Kör sedan: bash $REPO_DIR/infra/setup.sh"
  exit 0
else
  echo "  Finns redan: $ENV_FILE"
fi

# Läs specifika variabler utan att evaluera .env som shellkod
_get_env() {
  grep -m1 "^$1=" "$ENV_FILE" | cut -d= -f2- | tr -d '"'"'"
}
GMAIL_EMAIL="$(_get_env GMAIL_EMAIL)"
GMAIL_PASSWORD="$(_get_env GMAIL_PASSWORD)"

if [ -z "${GMAIL_EMAIL}" ] || [ -z "${GMAIL_PASSWORD}" ]; then
  echo "  FEL: GMAIL_EMAIL och GMAIL_PASSWORD måste vara ifyllda i $ENV_FILE"
  exit 1
fi

# --- 3. systemd-tjänster (med rätt användare och sökväg) ---
echo "[3/4] Installerar systemd-tjänster..."
for f in bounce-processor.service bounce-processor.timer; do
  sudo sed \
    -e "s|User=berduf|User=${CURRENT_USER}|g" \
    -e "s|/home/berduf/GitHub/politiker-webapp|${REPO_DIR}|g" \
    "$REPO_DIR/infra/$f" | sudo tee "$SERVICE_DIR/$f" > /dev/null
  echo "  Installerade: $f"
done

sudo systemctl daemon-reload
sudo systemctl enable --now bounce-processor.timer
echo "  bounce-processor.timer aktiverad"

# --- 4. Verifiera ---
echo "[4/4] Verifierar..."
systemctl is-active bounce-processor.timer && echo "  bounce-processor.timer: aktiv" || echo "  bounce-processor.timer: INTE aktiv"

echo ""
echo "=== Klar ==="
echo "bounce-processor körs dagligen kl 06:00."
echo ""
echo "Cloudflare Workers (campaign) deployas via:"
echo "  cd $REPO_DIR/campaign && npm install && npx wrangler deploy"
echo ""
echo "Secrets som måste sättas via 'wrangler secret put' i campaign/:"
echo "  ANTHROPIC_API_KEY"
echo "  GMAIL_EMAIL"
echo "  GMAIL_PASSWORD"
echo "  GITHUB_FEEDBACK_TOKEN"
