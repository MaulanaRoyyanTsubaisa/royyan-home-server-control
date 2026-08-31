#!/usr/bin/env python3
import json
import os
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

ROUTER = Path('/etc/hermes-router/nginx.conf')
ENV = Path('/etc/royyan-home-server-control.env')
STATE_DIR = Path('/var/lib/hermes-control-maintenance')
DOMAIN = 'maulanaroyyantsubaisa.my.id'


def fail(msg, code=1):
    print('ERROR: ' + msg, file=sys.stderr)
    raise SystemExit(code)


def allowed_apps():
    apps = set()
    if ENV.exists():
        for line in ENV.read_text().splitlines():
            if line.startswith('HERMES_APPS='):
                apps.update(x.strip() for x in line.split('=', 1)[1].split(',') if x.strip())
    return apps


def find_server_block(text, host):
    needle = f'server_name {host};'
    pos = text.find(needle)
    if pos < 0:
        fail(f'router block not found for {host}')

    start = text.rfind('server {', 0, pos)
    if start < 0:
        fail(f'cannot locate server block start for {host}')

    brace = text.find('{', start)
    depth = 0
    for i in range(brace, len(text)):
        if text[i] == '{':
            depth += 1
        elif text[i] == '}':
            depth -= 1
            if depth == 0:
                return start, i + 1, text[start:i + 1]
    fail(f'cannot locate server block end for {host}')


def validate_and_reload(backup_text):
    test = subprocess.run(
        ['docker', 'exec', 'hermes-router', 'nginx', '-t'],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    if test.returncode != 0:
        ROUTER.write_text(backup_text)
        subprocess.run(['docker', 'exec', 'hermes-router', 'nginx', '-t'], check=False)
        subprocess.run(['docker', 'exec', 'hermes-router', 'nginx', '-s', 'reload'], check=False)
        fail('nginx validation failed; original router restored\n' + test.stdout[-1200:])

    reload_result = subprocess.run(
        ['docker', 'exec', 'hermes-router', 'nginx', '-s', 'reload'],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    if reload_result.returncode != 0:
        ROUTER.write_text(backup_text)
        subprocess.run(['docker', 'exec', 'hermes-router', 'nginx', '-t'], check=False)
        subprocess.run(['docker', 'exec', 'hermes-router', 'nginx', '-s', 'reload'], check=False)
        fail('nginx reload failed; original router restored\n' + reload_result.stdout[-1200:])


def state_file(app):
    return STATE_DIR / f'{app}.json'


def status(app):
    p = state_file(app)
    if p.exists():
        data = json.loads(p.read_text())
        print(f'MAINTENANCE ACTIVE app={app} since={data.get("enabled_at", "unknown")}')
    else:
        print(f'MAINTENANCE OFF app={app}')


def enable(app):
    p = state_file(app)
    if p.exists():
        status(app)
        return

    text = ROUTER.read_text()
    host = f'{app}.{DOMAIN}'
    start, end, original = find_server_block(text, host)
    html = (
        '<!doctype html><html><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">'
        '<title>Maintenance</title></head><body style="margin:0;background:#06090f;color:#e9eef7;font-family:system-ui;display:grid;place-items:center;min-height:100vh">'
        '<main style="text-align:center;max-width:620px;padding:36px"><h1>Maintenance in progress</h1>'
        f'<p style="color:#8f9bad">{app} sedang dalam maintenance terkontrol oleh Hermes. Coba lagi beberapa saat.</p>'
        '<p style="color:#5e6a7d;font-size:12px">Royyan Home Server Control</p></main></body></html>'
    )
    safe_html = html.replace('"', '\\"')
    replacement = f'''server {{
    listen 8090;
    server_name {host};
    location / {{
      default_type text/html;
      add_header Retry-After 300 always;
      return 503 "{safe_html}";
    }}
  }}'''

    STATE_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    data = {
        'app': app,
        'host': host,
        'enabled_at': datetime.now().astimezone().isoformat(),
        'original_block': original,
    }
    p.write_text(json.dumps(data, indent=2) + '\n')
    os.chmod(p, 0o600)

    ROUTER.write_text(text[:start] + replacement + text[end:])
    validate_and_reload(text)
    print(f'MAINTENANCE ACTIVE app={app} host={host}')


def disable(app):
    p = state_file(app)
    if not p.exists():
        print(f'MAINTENANCE OFF app={app}')
        return

    data = json.loads(p.read_text())
    text = ROUTER.read_text()
    host = data['host']
    start, end, _current = find_server_block(text, host)
    original = data.get('original_block')
    if not original:
        fail('saved original router block is missing')

    ROUTER.write_text(text[:start] + original + text[end:])
    validate_and_reload(text)
    p.unlink(missing_ok=True)
    print(f'MAINTENANCE OFF app={app} host={host}')


def main():
    if os.geteuid() != 0:
        fail('must run as root')
    if len(sys.argv) != 3:
        fail('usage: hermes-control-maintenance <on|off|status> <app>', 2)
    action, app = sys.argv[1:]
    if not re.fullmatch(r'[a-z][a-z0-9-]{1,48}', app):
        fail('invalid app', 2)
    if app not in allowed_apps():
        fail('app not in Hermes allowlist', 2)
    if not ROUTER.exists():
        fail(f'missing router config: {ROUTER}')

    if action == 'status':
        status(app)
    elif action == 'on':
        enable(app)
    elif action == 'off':
        disable(app)
    else:
        fail('unsupported action', 2)


if __name__ == '__main__':
    main()
