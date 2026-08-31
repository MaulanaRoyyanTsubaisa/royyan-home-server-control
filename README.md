# Royyan Home Server Control

A private-style control panel for monitoring and operating the Royyan home server through a safe web interface.

## Goals

- Live server health: CPU, RAM, disk, load, uptime, OS
- App status and safe operations
- Deployments, backups, timers, and incidents
- GitHub connection overview
- Telegram status and outbound notifications
- Mobile + desktop responsive dashboard
- No raw shell execution from the browser

## Safety model

All operational actions must pass through the existing `/usr/local/bin/hermes-ops-safe` wrapper. The web API only exposes an allowlist of safe commands and known apps.

## Stack

- React + Vite
- Node.js + Express
- Host-level systemd deployment

Work in progress.
