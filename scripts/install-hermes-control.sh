#!/usr/bin/env bash
set -Eeuo pipefail

[[ "$(id -u)" -eq 0 ]] || {
  echo "ERROR: run with sudo: sudo bash scripts/install-hermes-control.sh" >&2
  exit 1
}

REPO="MaulanaRoyyanTsubaisa/royyan-home-server-control"
APP_DIR="/srv/hermes-workspace/repos/royyan-home-server-control"
DOMAIN="maulanaroyyantsubaisa.my.id"
PUBLIC_HOST="control.${DOMAIN}"
CONTROL_PORT_START="8200"
CONTROL_PORT_END="8299"
PORT=""
ENV_FILE="/etc/royyan-home-server-control.env"
SERVICE_FILE="/etc/systemd/system/royyan-home-server-control.service"
ROUTER="/etc/hermes-router/nginx.conf"
DISPATCHER="/home/hermes/.hermes/scripts/github-autopilot-dispatch.py"
QUEUE_ROOT="/usr/local/sbin/hermes-control-queue"
WORKER_ROOT="/usr/local/sbin/hermes-control-deploy-worker"
QUEUE_SAFE="/usr/local/bin/hermes-control-queue-safe"
TG_ROOT="/usr/local/sbin/hermes-telegram-send"
TG_SAFE="/usr/local/bin/hermes-telegram-send-safe"
SUDOERS="/etc/sudoers.d/hermes-control"
PENDING="/run/hermes-control-deploy.pending"
UNIT="hermes-control-deploy.service"

for cmd in git node npm curl python3 systemctl systemd-run sudo openssl docker visudo flock; do
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "ERROR: required command missing: $cmd" >&2
    exit 1
  }
done

[[ -x /usr/local/bin/hermes-ops-safe ]] || {
  echo "ERROR: Hermes safe ops gateway is missing." >&2
  exit 1
}

[[ -x /usr/local/bin/hermes-dashboard-safe ]] || {
  echo "ERROR: Hermes dashboard safe helper is missing." >&2
  exit 1
}

echo "============================================================"
echo "ROYYAN HOME SERVER CONTROL × HERMES"
echo "============================================================"

echo "==> 1/9 Ensure repository exists"
if [[ ! -d "$APP_DIR/.git" ]]; then
  sudo -u hermes /usr/local/bin/hermes-ops-safe github-clone "$REPO"
fi

git -c safe.directory="$APP_DIR" -C "$APP_DIR" fetch origin main
git -c safe.directory="$APP_DIR" -C "$APP_DIR" reset --hard origin/main

echo "==> 2/9 Build dashboard"
cd "$APP_DIR"
npm install
npm run build

echo "==> 3/9 Select dedicated control port + protected environment"

existing_port=""
if [[ -f "$ENV_FILE" ]]; then
  existing_port="$(sed -n 's/^PORT=//p' "$ENV_FILE" | tail -1)"
fi

port_is_free() {
  local p="$1"
  ! ss -H -ltn "sport = :$p" | grep -q .
}

port_is_our_control() {
  local p="$1"
  local body=""
  body="$(curl -fsS --max-time 3 "http://127.0.0.1:$p/api/health" 2>/dev/null || true)"
  [[ "$body" == *'"service":"royyan-home-server-control"'* ]]
}

if [[ "$existing_port" =~ ^[0-9]+$ ]] &&
   (( existing_port >= CONTROL_PORT_START && existing_port <= CONTROL_PORT_END )); then
  if port_is_free "$existing_port" || port_is_our_control "$existing_port"; then
    PORT="$existing_port"
  fi
fi

if [[ -z "$PORT" ]]; then
  for p in $(seq "$CONTROL_PORT_START" "$CONTROL_PORT_END"); do
    if port_is_free "$p"; then
      PORT="$p"
      break
    fi
  done
fi

[[ -n "$PORT" ]] || {
  echo "ERROR: no free control port in ${CONTROL_PORT_START}-${CONTROL_PORT_END}" >&2
  exit 1
}

echo "Selected control port: $PORT"

NEW_PASSWORD=""
if [[ ! -f "$ENV_FILE" ]]; then
  NEW_PASSWORD="$(openssl rand -hex 12)"
  SESSION_SECRET="$(openssl rand -hex 32)"
  touch "$ENV_FILE"
fi

CURRENT_PASSWORD="$(sed -n 's/^CONTROL_ADMIN_PASSWORD=//p' "$ENV_FILE" | tail -1)"
CURRENT_SECRET="$(sed -n 's/^CONTROL_SESSION_SECRET=//p' "$ENV_FILE" | tail -1)"

if [[ -z "$CURRENT_PASSWORD" ]]; then
  CURRENT_PASSWORD="$(openssl rand -hex 12)"
  NEW_PASSWORD="$CURRENT_PASSWORD"
fi

if [[ -z "$CURRENT_SECRET" ]]; then
  CURRENT_SECRET="$(openssl rand -hex 32)"
fi

APPS="$(
  python3 - <<'PY'
import json
from pathlib import Path
p = Path("/etc/hermes-ops/apps.json")
apps = []
if p.exists():
    try:
        data = json.loads(p.read_text())
        apps = sorted({v.get("app") for v in data.get("apps", {}).values() if v.get("app")})
    except Exception:
        pass
print(",".join(apps))
PY
)"
[[ -n "$APPS" ]] || APPS="portfolio,opspilot,bantuai,niagabot,sajiin,kontenin,lamarin,learnwithroyyan,rumahin,tagihin,janjiin"

cp -a "$ENV_FILE" "${ENV_FILE}.bak-$(date +%Y%m%d-%H%M%S)" 2>/dev/null || true

python3 - "$ENV_FILE" "$PORT" "$APPS" "$PUBLIC_HOST" "$CURRENT_PASSWORD" "$CURRENT_SECRET" "$TG_SAFE" <<'PY'
import sys
from pathlib import Path

p = Path(sys.argv[1])
values = {
    "PORT": sys.argv[2],
    "HOST": "127.0.0.1",
    "HERMES_OPS_BIN": "/usr/local/bin/hermes-ops-safe",
    "HERMES_DASHBOARD_BIN": "/usr/local/bin/hermes-dashboard-safe",
    "HERMES_TELEGRAM_SEND_BIN": sys.argv[7],
    "HERMES_APPS": sys.argv[3],
    "GITHUB_OWNER": "MaulanaRoyyanTsubaisa",
    "GITHUB_BRANCH": "main",
    "PUBLIC_BASE_URL": "https://" + sys.argv[4],
    "CONTROL_ADMIN_PASSWORD": sys.argv[5],
    "CONTROL_SESSION_SECRET": sys.argv[6],
}

existing = []
if p.exists():
    existing = p.read_text().splitlines()

seen = set()
out = []
for line in existing:
    if "=" not in line or line.lstrip().startswith("#"):
        out.append(line)
        continue
    key = line.split("=", 1)[0]
    if key in values:
        if key not in seen:
            out.append(f"{key}={values[key]}")
            seen.add(key)
    else:
        out.append(line)

for key, value in values.items():
    if key not in seen:
        out.append(f"{key}={value}")

p.write_text("\n".join(out).rstrip() + "\n")
PY

chown root:hermes "$ENV_FILE"
chmod 0640 "$ENV_FILE"

echo "==> 4/9 Install safe Telegram bridge"
if [[ -x "$TG_ROOT" ]]; then
  cat > "$TG_SAFE" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
exec sudo -n /usr/local/sbin/hermes-telegram-send
EOF
  chown root:root "$TG_SAFE"
  chmod 0755 "$TG_SAFE"
else
  echo "WARNING: Hermes Telegram sender not found; outbound Telegram stays unavailable." >&2
fi

cat > "$SUDOERS" <<'EOF'
hermes ALL=(root) NOPASSWD: /usr/local/sbin/hermes-control-queue
hermes ALL=(root) NOPASSWD: /usr/local/sbin/hermes-telegram-send
EOF
chown root:root "$SUDOERS"
chmod 0440 "$SUDOERS"
visudo -cf "$SUDOERS"

echo "==> 5/9 Install systemd service"
NODE_BIN="$(command -v node)"
cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Royyan Home Server Control
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=hermes
Group=hermes
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN $APP_DIR/server/index.js
Restart=on-failure
RestartSec=3
PrivateTmp=true
ProtectHome=false

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now royyan-home-server-control.service
systemctl restart royyan-home-server-control.service

health_body=""
for _ in 1 2 3 4 5; do
  health_body="$(curl -fsS --max-time 5 "http://127.0.0.1:$PORT/api/health" 2>/dev/null || true)"
  [[ "$health_body" == *'"service":"royyan-home-server-control"'* ]] && break
  sleep 2
done

if [[ "$health_body" != *'"service":"royyan-home-server-control"'* ]]; then
  echo "ERROR: control service did not claim its selected port $PORT." >&2
  systemctl status royyan-home-server-control.service --no-pager -l || true
  ss -ltnp | grep -E ":$PORT\\b" || true
  exit 1
fi

echo "==> 6/9 Attach to Hermes wildcard router safely"
[[ -f "$ROUTER" ]] || {
  echo "ERROR: Hermes router config missing: $ROUTER" >&2
  exit 1
}

ROUTER_BACKUP="${ROUTER}.bak-control-$(date +%Y%m%d-%H%M%S)"
cp -a "$ROUTER" "$ROUTER_BACKUP"

python3 - "$ROUTER" "$PUBLIC_HOST" "$PORT" <<'PY'
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
host = sys.argv[2]
port = int(sys.argv[3])
s = path.read_text()

pattern = re.compile(
    rf'(?P<block>server\s*\{{(?:(?!server\s*\{{)[\s\S])*?server_name\s+{re.escape(host)};(?:(?!server\s*\{{)[\s\S])*?\}})',
    re.M
)
m = pattern.search(s)

if m:
    block = m.group("block")
    new_block, n = re.subn(
        r'proxy_pass\s+http://127\.0\.0\.1:\d+;',
        f'proxy_pass http://127.0.0.1:{port};',
        block,
        count=1,
    )
    if n == 0:
        raise SystemExit("ERROR: existing control router block has no proxy_pass")
    s = s[:m.start("block")] + new_block + s[m.end("block"):]
else:
    marker = "  server {\n    listen 8090 default_server;"
    if marker not in s:
        raise SystemExit("ERROR: Hermes default router marker not found")

    block = f"""  server {{
    listen 8090;
    server_name {host};
    location / {{
      proxy_pass http://127.0.0.1:{port};
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-Proto https;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_set_header X-Real-IP $remote_addr;
    }}
  }}

"""
    s = s.replace(marker, block + marker, 1)

path.write_text(s)
PY

if ! docker exec hermes-router nginx -t; then
  cp -a "$ROUTER_BACKUP" "$ROUTER"
  echo "ERROR: nginx test failed; original Hermes router restored." >&2
  exit 1
fi

docker exec hermes-router nginx -s reload
echo "Hermes router reloaded without container restart ✅"

ROUTER_BODY="$(
  curl -sS --max-time 10 \
    -H "Host: $PUBLIC_HOST" \
    "http://127.0.0.1:8090/api/health" || true
)"

if [[ "$ROUTER_BODY" != *'"service":"royyan-home-server-control"'* ]]; then
  cp -a "$ROUTER_BACKUP" "$ROUTER"
  docker exec hermes-router nginx -t >/dev/null
  docker exec hermes-router nginx -s reload >/dev/null
  echo "ERROR: router verification failed; original Hermes router restored." >&2
  exit 1
fi

echo "Router health: Royyan control plane OK"

echo "==> 7/9 Install zero-click control-panel deployment"
cat > "$WORKER_ROOT" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="/srv/hermes-workspace/repos/royyan-home-server-control"
SERVICE="royyan-home-server-control.service"
ENV_FILE="/etc/royyan-home-server-control.env"
PENDING="/run/hermes-control-deploy.pending"
LOCK="/run/lock/hermes-control-deploy.lock"
SEND="/usr/local/sbin/hermes-telegram-send"

notify() {
  [[ -x "$SEND" ]] && printf '%s' "$1" | "$SEND" || true
}

deploy_once() {
  exec 9>"$LOCK"
  flock -x 9

  local old_sha
  old_sha="$(git -c safe.directory="$APP_DIR" -C "$APP_DIR" rev-parse HEAD)"

  notify "🚀 CONTROL PANEL DEPLOY STARTED

📦 royyan-home-server-control
🔄 Updating main branch."

  git -c safe.directory="$APP_DIR" -C "$APP_DIR" fetch origin main
  git -c safe.directory="$APP_DIR" -C "$APP_DIR" reset --hard origin/main

  set +e
  (
    set -a
    source "$ENV_FILE"
    set +a
    cd "$APP_DIR"
    npm install &&
    npm run build &&
    systemctl restart "$SERVICE" &&
    sleep 2 &&
    health_body="$(curl -fsS --max-time 10 "http://127.0.0.1:$PORT/api/health")" &&
    [[ "$health_body" == *'"service":"royyan-home-server-control"'* ]]
  )
  rc=$?
  set -e

  if [[ "$rc" -eq 0 ]]; then
    local new_sha
    new_sha="$(git -c safe.directory="$APP_DIR" -C "$APP_DIR" rev-parse --short HEAD)"
    notify "✅ CONTROL PANEL DEPLOYED

📦 royyan-home-server-control
🧩 Commit: $new_sha
🌐 https://control.maulanaroyyantsubaisa.my.id
🩺 Local health: OK"
    return 0
  fi

  notify "⚠️ CONTROL PANEL DEPLOY FAILED

Rolling application source back to the previous commit."

  git -c safe.directory="$APP_DIR" -C "$APP_DIR" reset --hard "$old_sha"
  (
    cd "$APP_DIR"
    npm install
    npm run build
    systemctl restart "$SERVICE"
  ) || true

  notify "↩️ CONTROL PANEL ROLLBACK FINISHED

Previous commit restored. Check service logs if the panel is still unhealthy."
  return "$rc"
}

while :; do
  rm -f "$PENDING"
  set +e
  deploy_once
  rc=$?
  set -e
  [[ -e "$PENDING" ]] && continue
  exit "$rc"
done
EOF
chown root:root "$WORKER_ROOT"
chmod 0700 "$WORKER_ROOT"
bash -n "$WORKER_ROOT"

cat > "$QUEUE_ROOT" <<EOF
#!/usr/bin/env bash
set -Eeuo pipefail
touch "$PENDING"

if systemctl is-active --quiet "$UNIT"; then
  echo "QUEUED state=coalesced"
  exit 0
fi

systemd-run \
  --unit="$UNIT" \
  --collect \
  --property=Type=exec \
  "$WORKER_ROOT" >/dev/null

echo "QUEUED state=started"
EOF
chown root:root "$QUEUE_ROOT"
chmod 0700 "$QUEUE_ROOT"
bash -n "$QUEUE_ROOT"

cat > "$QUEUE_SAFE" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
exec sudo -n /usr/local/sbin/hermes-control-queue
EOF
chown root:root "$QUEUE_SAFE"
chmod 0755 "$QUEUE_SAFE"

echo "==> 8/9 Patch GitHub Hermes dispatcher"
[[ -f "$DISPATCHER" ]] || {
  echo "ERROR: Hermes GitHub dispatcher missing: $DISPATCHER" >&2
  exit 1
}

cp -a "$DISPATCHER" "$DISPATCHER.bak-control-$(date +%Y%m%d-%H%M%S)"

python3 - "$DISPATCHER" <<'PY'
import sys
from pathlib import Path

p = Path(sys.argv[1])
s = p.read_text()

if "CONTROL_REPO = " not in s:
    marker = 'OPS = "/usr/local/bin/hermes-ops-safe"\n'
    addition = (
        'CONTROL_REPO = "MaulanaRoyyanTsubaisa/royyan-home-server-control"\n'
        'CONTROL_QUEUE = "/usr/local/bin/hermes-control-queue-safe"\n'
    )
    if marker not in s:
        raise SystemExit("ERROR: OPS marker not found in dispatcher")
    s = s.replace(marker, marker + addition, 1)

if "Control panel automatic deployment queued." not in s:
    marker = 'rc, status = run("repo-status", repo)\n'
    block = '''real_push = (
    len(after) == 40
    and after != ("0" * 40)
    and all(ch in "0123456789abcdefABCDEF" for ch in after)
)

if repo == CONTROL_REPO and real_push:
    p = subprocess.run(
        [CONTROL_QUEUE],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=30,
        check=False,
    )
    if p.returncode != 0:
        fail("Control panel deploy queue failed.\\n" + p.stdout.strip())

    state = "coalesced" if "state=coalesced" in p.stdout else "started"
    emit(
        "🖥️ GitHub Autopilot\\n\\n"
        f"Repository: {repo}\\n"
        f"Commit: {after[:12]}\\n"
        f"Sender: {sender or '-'}\\n\\n"
        "🚀 Control panel automatic deployment queued.\\n"
        f"✅ Queue state: {state}\\n"
        "✅ Build, restart, health check and rollback are handled automatically."
    )

'''
    if marker not in s:
        raise SystemExit("ERROR: repo-status marker not found in dispatcher")
    s = s.replace(marker, block + marker, 1)

p.write_text(s)
PY

chown hermes:hermes "$DISPATCHER"
chmod 0700 "$DISPATCHER"
python3 -m py_compile "$DISPATCHER"

HUID="$(id -u hermes)"
if [[ -S "/run/user/$HUID/bus" ]]; then
  sudo -u hermes env \
    XDG_RUNTIME_DIR="/run/user/$HUID" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$HUID/bus" \
    systemctl --user restart hermes-gateway.service || true
fi

echo "==> 9/9 Final checks"
sudo -u hermes /usr/local/bin/hermes-dashboard-safe status >/dev/null
FINAL_HEALTH="$(curl -fsS --max-time 8 "http://127.0.0.1:$PORT/api/health")"
[[ "$FINAL_HEALTH" == *'"service":"royyan-home-server-control"'* ]] || {
  echo "ERROR: final local health identity check failed" >&2
  exit 1
}

PUBLIC_CODE="$(
  curl -sS -o /dev/null -w '%{http_code}' --max-time 20 \
    "https://$PUBLIC_HOST/api/health" || true
)"

echo
echo "============================================================"
echo "CONTROL PLANE INSTALLED ✅"
echo "============================================================"
echo "Local   : http://127.0.0.1:$PORT"
echo "Public  : https://$PUBLIC_HOST"
echo "Public health: HTTP ${PUBLIC_CODE:-000}"
echo
echo "Cloudflare behavior:"
echo "  Existing wildcard *.$DOMAIN -> http://localhost:8090 covers this hostname."
echo "  Hermes adds only the local router block; no per-app Cloudflare route is needed."
echo
echo "Future GitHub pushes to main:"
echo "  GitHub webhook -> Hermes -> queue -> build -> restart -> health -> rollback"
echo

ADMIN_PASSWORD="$(sed -n 's/^CONTROL_ADMIN_PASSWORD=//p' "$ENV_FILE" | tail -1)"
echo "ADMIN PASSWORD (terminal only; never sent to Telegram):"
echo "  $ADMIN_PASSWORD"
echo
echo "Store it safely."

if [[ ! "$PUBLIC_CODE" =~ ^(2|3)[0-9][0-9]$ ]]; then
  echo "WARNING: public Cloudflare health is not 2xx/3xx yet."
  echo "Verify the one wildcard published application:"
  echo "  *.$DOMAIN -> http://localhost:8090"
fi
