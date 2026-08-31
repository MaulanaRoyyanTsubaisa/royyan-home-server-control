#!/usr/bin/env python3
import json
import os
import re
import secrets
import subprocess
import sys
import time
from pathlib import Path

REG = Path('/etc/hermes-ops/apps.json')
GUARD = '/usr/local/sbin/hermes-resource-guard'


def fail(msg, code=1):
    print('ERROR: ' + msg, file=sys.stderr)
    raise SystemExit(code)


def run(args, timeout=120):
    return subprocess.run(
        args,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=timeout,
        check=False,
    )


def allowed_apps():
    data = json.loads(REG.read_text())
    return sorted({v.get('app') for v in data.get('apps', {}).values() if v.get('app')})


def latest_dump(app):
    root = Path('/srv/backups') / app
    if not root.exists():
        fail(f'backup directory not found: {root}')
    files = []
    for pattern in (f'{app}-*.dump', 'database-*.dump'):
        files.extend(root.glob(pattern))
    files = sorted(set(files), key=lambda p: p.stat().st_mtime, reverse=True)
    if not files:
        fail(f'no compatible dump found for {app}')
    return root, files[0]


def main():
    if os.geteuid() != 0:
        fail('must run as root')
    if len(sys.argv) != 2:
        fail('usage: hermes-backup-drill <app>', 2)
    app = sys.argv[1]
    if not re.fullmatch(r'[a-z][a-z0-9-]{1,48}', app):
        fail('invalid app', 2)
    if app not in allowed_apps():
        fail('app not registered in Hermes', 2)

    guard = run([GUARD], timeout=20)
    print(guard.stdout.strip())
    if guard.returncode != 0:
        fail('Resource Guard blocked restore drill', 75)

    backup_dir, dump = latest_dump(app)
    age_hours = (time.time() - dump.stat().st_mtime) / 3600
    if dump.stat().st_size < 1024:
        fail(f'backup too small: {dump}')

    name = f'hermes-drill-{app}-{os.getpid()}'
    password = secrets.token_hex(12)
    try:
        start = run([
            'docker', 'run', '-d', '--rm', '--name', name,
            '-e', f'POSTGRES_PASSWORD={password}',
            '-v', f'{backup_dir}:/backup:ro',
            'postgres:18'
        ], timeout=60)
        if start.returncode != 0:
            fail('cannot start isolated PostgreSQL drill container: ' + start.stdout[-600:])

        ready = False
        for _ in range(30):
            p = run(['docker', 'exec', name, 'pg_isready', '-U', 'postgres'], timeout=10)
            if p.returncode == 0:
                ready = True
                break
            time.sleep(1)
        if not ready:
            fail('isolated PostgreSQL drill container did not become ready')

        create = run(['docker', 'exec', name, 'createdb', '-U', 'postgres', 'restore_drill'], timeout=30)
        if create.returncode != 0:
            fail('cannot create drill database: ' + create.stdout[-600:])

        restore = run([
            'docker', 'exec', name,
            'pg_restore', '-U', 'postgres', '-d', 'restore_drill',
            '--no-owner', '--no-privileges', f'/backup/{dump.name}'
        ], timeout=180)
        if restore.returncode != 0:
            fail('restore drill failed: ' + restore.stdout[-1200:])

        check = run([
            'docker', 'exec', name, 'psql', '-U', 'postgres', '-d', 'restore_drill',
            '-Atc', "SELECT count(*) FROM pg_tables WHERE schemaname='public';"
        ], timeout=30)
        if check.returncode != 0:
            fail('post-restore SQL check failed: ' + check.stdout[-600:])

        table_count = check.stdout.strip().splitlines()[-1] if check.stdout.strip() else '0'
        print(
            f'RESTORE DRILL OK app={app} file={dump.name} size={dump.stat().st_size} '
            f'age_hours={age_hours:.1f} public_tables={table_count}'
        )
        print('Production database was not connected, modified, restored, or deleted.')
    finally:
        run(['docker', 'rm', '-f', name], timeout=30)


if __name__ == '__main__':
    main()
