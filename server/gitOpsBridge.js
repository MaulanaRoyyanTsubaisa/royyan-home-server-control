import path from 'node:path'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

const DATA_DIR = process.env.CONTROL_V3_DATA_DIR || '/home/hermes/.hermes/infrastructure-os-v3'
const REQUEST_FILE =
  process.env.GITOPS_REQUEST_FILE ||
  '/srv/hermes-workspace/repos/royyan-home-server-control/ops/remote-request.json'
const STATE_FILE = path.join(DATA_DIR, 'gitops-bridge-state.json')

const READ_VIEWS = new Set(['status', 'apps', 'backup-status', 'deployments', 'incidents'])
const OPS = new Set(['health', 'logs', 'restart', 'backup', 'deploy', 'timers'])
const MUTATING = new Set(['restart', 'backup', 'deploy'])

let publicState = {
  enabled: true,
  mode: 'github-safe-ops-bridge',
  lastId: null,
  status: 'idle',
  action: null,
  target: null,
  finishedAt: null,
  lastError: null
}

function safe(value, limit = 1600) {
  return String(value || '')
    .replace(/[A-Fa-f0-9]{24,}/g, '<redacted>')
    .replace(/(password|secret|token|authorization)[^\n]{0,160}/gi, '$1=<redacted>')
    .slice(0, limit)
}

async function persist(detail) {
  await mkdir(DATA_DIR, { recursive: true, mode: 0o700 })
  await writeFile(STATE_FILE, JSON.stringify(detail, null, 2) + '\n', { mode: 0o600 })
}

async function previous() {
  try {
    return JSON.parse(await readFile(STATE_FILE, 'utf8'))
  } catch {
    return null
  }
}

function validateRequest(value, apps) {
  if (!value || typeof value !== 'object') throw new Error('request must be an object')
  const id = String(value.id || '').trim()
  const action = String(value.action || '').trim()
  const target = value.target ? String(value.target).trim() : null
  if (!/^[A-Za-z0-9._-]{6,80}$/.test(id)) throw new Error('invalid request id')
  if (![...READ_VIEWS, ...OPS, 'telegram-note'].includes(action)) throw new Error('action is not allowlisted')
  if (target && !apps.includes(target)) throw new Error('target is not in Hermes app allowlist')
  if (['health', 'logs', 'restart', 'backup', 'deploy'].includes(action) && !target) {
    throw new Error('action requires an app target')
  }
  if (MUTATING.has(action) && value.confirm !== 'GITOPS_SAFE_EXECUTE') {
    throw new Error('mutating GitOps request missing confirmation')
  }
  return {
    id,
    action,
    target,
    note: safe(value.note || '', 500),
    confirm: value.confirm || null
  }
}

export function getGitOpsBridgePublicState() {
  return publicState
}

export function registerGitOpsBridge({
  APPS,
  runSafeOps,
  runDashboardView,
  sendViaHermesTelegram
}) {
  let busy = false

  async function execute(request) {
    if (READ_VIEWS.has(request.action)) {
      const map = {
        status: 'status',
        apps: 'apps',
        'backup-status': 'backup',
        deployments: 'deployments',
        incidents: 'incidents'
      }
      return runDashboardView(map[request.action])
    }

    if (request.action === 'telegram-note') {
      if (!request.note) throw new Error('telegram-note requires note')
      await sendViaHermesTelegram(request.note)
      return { stdout: 'Telegram note sent', stderr: '' }
    }

    return runSafeOps(request.action, request.target || undefined)
  }

  async function poll() {
    if (busy || !existsSync(REQUEST_FILE)) return
    busy = true
    try {
      const raw = JSON.parse(await readFile(REQUEST_FILE, 'utf8'))
      if (raw.enabled === false) return

      const request = validateRequest(raw, APPS)
      const old = await previous()
      if (old?.id === request.id && ['success', 'failed'].includes(old.status)) {
        publicState = {
          enabled: true,
          mode: 'github-safe-ops-bridge',
          lastId: old.id,
          status: old.status,
          action: old.action,
          target: old.target || null,
          finishedAt: old.finishedAt || null,
          lastError: old.error ? safe(old.error, 300) : null
        }
        return
      }

      const startedAt = new Date().toISOString()
      publicState = {
        enabled: true,
        mode: 'github-safe-ops-bridge',
        lastId: request.id,
        status: 'running',
        action: request.action,
        target: request.target,
        finishedAt: null,
        lastError: null
      }

      try {
        const result = await execute(request)
        const detail = {
          id: request.id,
          status: 'success',
          action: request.action,
          target: request.target,
          startedAt,
          finishedAt: new Date().toISOString(),
          output: safe(result?.stdout || result?.stderr || result || '', 4000)
        }
        await persist(detail)
        publicState = {
          enabled: true,
          mode: 'github-safe-ops-bridge',
          lastId: detail.id,
          status: detail.status,
          action: detail.action,
          target: detail.target,
          finishedAt: detail.finishedAt,
          lastError: null
        }

        if (MUTATING.has(request.action)) {
          await sendViaHermesTelegram(
            [
              '🛰️ GITOPS SAFE OPS COMPLETED',
              '',
              'Action: ' + request.action,
              'App: ' + (request.target || '-'),
              'Request: ' + request.id,
              'Status: SUCCESS'
            ].join('\n')
          ).catch(() => {})
        }
      } catch (error) {
        const detail = {
          id: request.id,
          status: 'failed',
          action: request.action,
          target: request.target,
          startedAt,
          finishedAt: new Date().toISOString(),
          error: safe(error.message, 1600)
        }
        await persist(detail)
        publicState = {
          enabled: true,
          mode: 'github-safe-ops-bridge',
          lastId: detail.id,
          status: detail.status,
          action: detail.action,
          target: detail.target,
          finishedAt: detail.finishedAt,
          lastError: detail.error
        }
      }
    } catch (error) {
      publicState = {
        ...publicState,
        status: 'invalid-request',
        finishedAt: new Date().toISOString(),
        lastError: safe(error.message, 300)
      }
    } finally {
      busy = false
    }
  }

  const first = setTimeout(() => poll().catch(() => {}), 18_000)
  first.unref?.()
  const timer = setInterval(() => poll().catch(() => {}), 60_000)
  timer.unref?.()

  return { poll }
}
