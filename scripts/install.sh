#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_SRC="$ROOT/systemd/royyan-home-server-control.service"
SERVICE_DST="/etc/systemd/system/royyan-home-server-control.service"
ENV_DST="/etc/royyan-home-server-control.env"
RUN_USER="${SUDO_USER:-$USER}"
NODE_BIN="$(command -v node)"

echo "[1/5] Installing dependencies"
cd "$ROOT"
npm install

echo "[2/5] Building dashboard"
npm run build

echo "[3/5] Preparing environment"
if [[ ! -f "$ENV_DST" ]]; then
  sudo cp "$ROOT/.env.example" "$ENV_DST"
  sudo chmod 600 "$ENV_DST"
  echo "Created $ENV_DST — edit Telegram/GitHub values there when needed."
fi

echo "[4/5] Installing systemd service"
tmp="$(mktemp)"
sed \
  -e "s|__USER__|$RUN_USER|g" \
  -e "s|__WORKDIR__|$ROOT|g" \
  -e "s|__NODE__|$NODE_BIN|g" \
  "$SERVICE_SRC" > "$tmp"
sudo install -m 0644 "$tmp" "$SERVICE_DST"
rm -f "$tmp"

sudo systemctl daemon-reload
sudo systemctl enable --now royyan-home-server-control.service

echo "[5/5] Service status"
sudo systemctl --no-pager --full status royyan-home-server-control.service || true

echo
echo "Dashboard API is listening on the HOST/PORT from $ENV_DST."
echo "Default: http://127.0.0.1:8787"
