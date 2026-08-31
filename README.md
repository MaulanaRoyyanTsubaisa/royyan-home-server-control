# Royyan Home Server Control

Protected web control plane for the Royyan home server.

## What it controls

- Live host metrics: CPU, RAM, disk, load, uptime, OS
- Hermes-managed application operations
- Deployments, logs, restarts, backups, timers and incidents
- GitHub repository overview
- Web -> Telegram through the existing Hermes safe Telegram sender
- Shared Hermes state between Telegram quick commands and the web dashboard
- Responsive desktop/mobile UI

## Architecture

```text
GitHub push
    |
    v
Hermes GitHub webhook
    |
    +--> normal managed apps -> existing Hermes Autopilot
    |
    +--> royyan-home-server-control
             |
             v
       dedicated safe queue
             |
             v
      build -> systemd restart
             |
             +--> health OK -> keep release
             |
             +--> health FAIL -> rollback

Browser
    |
    v
Cloudflare wildcard tunnel
*.maulanaroyyantsubaisa.my.id -> localhost:8090
    |
    v
hermes-router
    |
    v
control.maulanaroyyantsubaisa.my.id -> localhost:<dedicated port 8200-8299>
    |
    v
Royyan Home Server Control
    |
    +--> /usr/local/bin/hermes-dashboard-safe
    +--> /usr/local/bin/hermes-ops-safe
    +--> /usr/local/bin/hermes-telegram-send-safe
```

## Why this app uses a dedicated Hermes profile

The generic Hermes new-repository auto-provisioner is intentionally limited to the supported Next.js + Prisma + PostgreSQL application family.

This repository is different: it is the **server control plane itself** and needs access to the existing root-controlled Hermes safe gateways. It therefore runs as a host-level systemd service instead of receiving Docker or raw host privileges.

It still participates in Hermes automation: the installer adds a dedicated GitHub deploy queue with health checking and rollback.

## Cloudflare

No new Cloudflare hostname needs to be created for every application when the existing wildcard published application is active:

```text
*.maulanaroyyantsubaisa.my.id -> http://localhost:8090
```

Hermes only adds the matching local Nginx route to `hermes-router`.

The control-panel hostname is:

```text
https://control.maulanaroyyantsubaisa.my.id
```

## Authentication

The public dashboard is protected by its own server-side login before any operational API is accessible.

The installer generates:

- `CONTROL_ADMIN_PASSWORD`
- `CONTROL_SESSION_SECRET`

The password is printed in the local terminal after a successful installer run and is never sent to Telegram.

Sessions use an HttpOnly, SameSite=Strict cookie.

## One-time server integration

After the repository is available in the Hermes workspace, do not change workspace ownership or permissions. Run it by absolute path:

```bash
sudo -u hermes git -C /srv/hermes-workspace/repos/royyan-home-server-control fetch origin main
sudo -u hermes git -C /srv/hermes-workspace/repos/royyan-home-server-control reset --hard origin/main
sudo bash /srv/hermes-workspace/repos/royyan-home-server-control/scripts/install-hermes-control.sh
```

The installer keeps the existing Hermes workspace isolation intact and selects a free control-plane port from 8200-8299, outside the generic Hermes auto-provision range.

The installer is idempotent and handles:

1. repository update
2. frontend build
3. protected environment
4. safe Telegram bridge
5. systemd service
6. Hermes wildcard router
7. zero-click deployment queue
8. GitHub Hermes dispatcher integration
9. local/router/public health checks

After this one-time registration, future pushes to `main` are handled by Hermes automatically.

## Safety model

The browser never gets:

- raw shell access
- Docker socket access
- sudo access
- Telegram bot token
- Cloudflare credentials
- GitHub private key

Operational commands pass through existing restricted helpers only.

## Stack

- React + Vite
- Node.js + Express
- host-level systemd
- Hermes safe operation gateways
- Hermes local Nginx wildcard router
- Cloudflare Tunnel
