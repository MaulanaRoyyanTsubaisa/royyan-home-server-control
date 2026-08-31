import path from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'

const STATE_DIR = process.env.CONTROL_DATA_DIR || '/home/hermes/.hermes/control-plane-v2'
const STATE_FILE = path.join(STATE_DIR, 'production-selftest.json')

let publicState = {
  status: 'pending',
  passed: 0,
  failed: 0,
  lastRun: null,
  checks: []
}
let detailedState = { ...publicState, details: [] }
let running = false

const FEATURE_NAMES = new Map([
  ['01', 'Live App Health'],
  ['02', 'Deployment Center'],
  ['03', 'Live Logs Streaming'],
  ['04', 'Backup Center + Restore Drill'],
  ['05', 'Incident Center + Self-Healing'],
  ['06', 'Resource Guard 2.0'],
  ['07', 'One-Click New App Autopilot'],
  ['08', 'Per-App Maintenance Mode'],
  ['09', 'Hermes Ops Copilot'],
  ['10', 'Infrastructure Map'],
  ['11', 'Telegram Mini Control'],
  ['12', 'PWA + Mobile Control'],
  ['13', 'Permanent Audit Log'],
  ['14', 'Security Center'],
  ['15', 'Daily Smart Morning Report']
])

function sanitizeMessage(value) {
  return String(value || '')
    .replace(/[A-Fa-f0-9]{24,}/g, '<redacted>')
    .replace(/(password|secret|token|authorization)[^\n]{0,160}/gi, '$1=<redacted>')
    .slice(0, 500)
}

async function fetchJson(base, urlPath, cookie, options = {}) {
  const response = await fetch(base + urlPath, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(options.headers || {})
    },
    signal: options.signal || AbortSignal.timeout(options.timeout || 45_000)
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(data.error || `HTTP ${response.status} for ${urlPath}`)
    error.status = response.status
    error.payload = data
    throw error
  }
  return data
}

async function login(base, password) {
  const response = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
    signal: AbortSignal.timeout(10_000)
  })
  if (!response.ok) throw new Error(`self-test login failed: HTTP ${response.status}`)
  const setCookie = response.headers.get('set-cookie') || ''
  const cookie = setCookie.split(';')[0]
  if (!cookie.startsWith('control_session=')) {
    throw new Error('self-test login did not return a session cookie')
  }
  return cookie
}

async function assertStatic(base, urlPath, predicate) {
  const response = await fetch(base + urlPath, { signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error(`${urlPath} returned HTTP ${response.status}`)
  const text = await response.text()
  if (!predicate(text, response)) throw new Error(`${urlPath} content validation failed`)
}

async function runCheck(details, id, mode, fn) {
  const started = Date.now()
  try {
    const note = await fn()
    details.push({
      id,
      feature: FEATURE_NAMES.get(id),
      status: 'pass',
      mode,
      durationMs: Date.now() - started,
      note: sanitizeMessage(note || '')
    })
  } catch (error) {
    details.push({
      id,
      feature: FEATURE_NAMES.get(id),
      status: 'fail',
      mode,
      durationMs: Date.now() - started,
      error: sanitizeMessage(error.message)
    })
  }
}

export function getPublicSelfTestState() {
  return publicState
}

export function getDetailedSelfTestState() {
  return detailedState
}

export async function runProductionSelfTest({ port, password }) {
  if (running) return detailedState
  running = true

  const details = []
  const base = `http://127.0.0.1:${port}`
  const startedAt = new Date().toISOString()

  try {
    if (!password) throw new Error('CONTROL_ADMIN_PASSWORD is missing')
    const cookie = await login(base, password)
    const config = await fetchJson(base, '/api/config', cookie)
    const apps = Array.isArray(config.apps) ? config.apps : []
    const firstApp = apps[0]
    if (!firstApp) throw new Error('No Hermes apps are configured')

    await runCheck(details, '01', 'read-only-live', async () => {
      const data = await fetchJson(base, '/api/v2/health/apps?force=1', cookie, { timeout: 80_000 })
      if (!Array.isArray(data.apps) || data.apps.length !== apps.length) {
        throw new Error('live health did not return the configured fleet')
      }
      return `${data.online}/${data.total} public probes returned reachable`
    })

    await runCheck(details, '02', 'dry-run+read-only', async () => {
      const history = await fetchJson(base, '/api/v2/deployments?limit=5', cookie)
      if (!Array.isArray(history.events)) throw new Error('deployment history shape invalid')
      const dry = await fetchJson(base, '/api/v2/deploy/' + encodeURIComponent(firstApp), cookie, {
        method: 'POST',
        body: JSON.stringify({ dryRun: true }),
        timeout: 60_000
      })
      if (!dry.dryRun || dry.capability?.mutatingActionExecuted !== false) {
        throw new Error('deployment dry-run contract invalid')
      }
      return `deploy path validated for ${firstApp}; mutation skipped`
    })

    await runCheck(details, '03', 'read-only-live', async () => {
      const logs = await fetchJson(base, '/api/actions', cookie, {
        method: 'POST',
        body: JSON.stringify({ command: 'logs', app: firstApp }),
        timeout: 70_000
      })
      if (typeof logs.stdout !== 'string' && typeof logs.stderr !== 'string') {
        throw new Error('safe logs command returned invalid payload')
      }

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 10_000)
      try {
        const stream = await fetch(
          base + '/api/v2/logs/stream?app=' + encodeURIComponent(firstApp),
          { headers: { Cookie: cookie }, signal: controller.signal }
        )
        if (!stream.ok || !String(stream.headers.get('content-type')).includes('text/event-stream')) {
          throw new Error('SSE live-log endpoint did not open correctly')
        }
        await stream.body?.cancel()
      } finally {
        clearTimeout(timer)
      }
      return `safe logs + SSE validated for ${firstApp}`
    })

    await runCheck(details, '04', 'read-only+dry-run', async () => {
      const data = await fetchJson(base, '/api/v2/backups', cookie, { timeout: 60_000 })
      if (!data.summary || typeof data.timers !== 'string') {
        throw new Error('backup center payload invalid')
      }
      const drill = await fetchJson(
        base,
        '/api/v2/backups/' + encodeURIComponent(firstApp) + '/drill',
        cookie,
        {
          method: 'POST',
          body: JSON.stringify({ dryRun: true }),
          timeout: 60_000
        }
      )
      if (!drill.dryRun || !drill.helperInstalled) throw new Error('restore-drill safe helper unavailable')
      return `backup center + isolated drill capability validated for ${firstApp}`
    })

    await runCheck(details, '05', 'read-only', async () => {
      const data = await fetchJson(base, '/api/v2/incidents?limit=5', cookie)
      if (!Array.isArray(data.events) || typeof data.hermesRaw !== 'string') {
        throw new Error('incident center payload invalid')
      }
      return 'incident state and Hermes incident view readable'
    })

    await runCheck(details, '06', 'read-only-live', async () => {
      const data = await fetchJson(base, '/api/v2/preflight', cookie, { timeout: 60_000 })
      if (
        typeof data.allowed !== 'boolean' ||
        !Number.isFinite(data.resources?.memoryPercent) ||
        !Number.isFinite(data.resources?.diskPercent)
      ) {
        throw new Error('Resource Guard payload invalid')
      }
      return `guard=${data.allowed ? 'SAFE' : 'BLOCKED'}, RAM=${data.resources.memoryPercent}%, disk=${data.resources.diskPercent}%`
    })

    await runCheck(details, '07', 'dry-run', async () => {
      const data = await fetchJson(base, '/api/v2/autopilot/new-app', cookie, {
        method: 'POST',
        body: JSON.stringify({
          repo: 'MaulanaRoyyanTsubaisa/sajiin',
          dryRun: true
        }),
        timeout: 45_000
      })
      if (!data.dryRun || data.mutatingActionExecuted !== false || !data.ownerAllowed) {
        throw new Error('Autopilot dry-run guard contract invalid')
      }
      return 'owner allowlist + repo-status path validated; no clone/provision performed'
    })

    await runCheck(details, '08', 'read-only+dry-run', async () => {
      const state = await fetchJson(base, '/api/v2/maintenance', cookie, { timeout: 60_000 })
      if (!state.helperInstalled) throw new Error('maintenance safe helper missing')
      const dry = await fetchJson(
        base,
        '/api/v2/maintenance/' + encodeURIComponent(firstApp),
        cookie,
        {
          method: 'POST',
          body: JSON.stringify({ enabled: true, dryRun: true }),
          timeout: 30_000
        }
      )
      if (!dry.dryRun || dry.mutatingActionExecuted !== false) {
        throw new Error('maintenance dry-run contract invalid')
      }
      return `maintenance helper validated for ${firstApp}; routing unchanged`
    })

    await runCheck(details, '09', 'read-only-analysis', async () => {
      const data = await fetchJson(base, '/api/v2/copilot', cookie, {
        method: 'POST',
        body: JSON.stringify({ question: 'Self-test: apakah telemetry safe-ops bisa dianalisis?' }),
        timeout: 90_000
      })
      if (!data.answer || !Array.isArray(data.findings) || !Array.isArray(data.recommendations)) {
        throw new Error('copilot response shape invalid')
      }
      return `copilot mode=${data.mode || 'unknown'}`
    })

    await runCheck(details, '10', 'read-only', async () => {
      const data = await fetchJson(base, '/api/v2/topology', cookie)
      if (!Array.isArray(data.nodes) || !Array.isArray(data.edges) || data.nodes.length < 3) {
        throw new Error('topology graph is incomplete')
      }
      return `${data.nodes.length} nodes / ${data.edges.length} edges`
    })

    await runCheck(details, '11', 'read-only-command', async () => {
      const data = await fetchJson(base, '/api/telegram/command', cookie, {
        method: 'POST',
        body: JSON.stringify({ command: '/server' }),
        timeout: 45_000
      })
      if (!data.ok || data.view !== 'status' || typeof data.stdout !== 'string') {
        throw new Error('Telegram/Hermes command bridge failed')
      }
      return '/server executed through Hermes dashboard helper; no bot-message impersonation'
    })

    await runCheck(details, '12', 'static-read-only', async () => {
      await assertStatic(base, '/manifest.webmanifest', (text) => {
        try {
          const data = JSON.parse(text)
          return data.display === 'standalone' && data.start_url === '/'
        } catch {
          return false
        }
      })
      await assertStatic(base, '/sw.js', (text) => text.includes("self.addEventListener('fetch'"))
      await assertStatic(base, '/control-icon.svg', (text, response) =>
        String(response.headers.get('content-type')).includes('svg') && text.includes('<svg')
      )
      return 'manifest + service worker + icon are publicly served'
    })

    await runCheck(details, '13', 'read-only+persistent-write', async () => {
      const data = await fetchJson(base, '/api/v2/audit?limit=20', cookie)
      if (!Array.isArray(data.events)) throw new Error('audit log payload invalid')
      const hasSelfTestActivity = data.events.some((item) => item.type === 'copilot-analysis')
      return hasSelfTestActivity ? 'persistent audit log recorded self-test activity' : 'audit log readable'
    })

    await runCheck(details, '14', 'read-only', async () => {
      const data = await fetchJson(base, '/api/v2/security', cookie)
      if (!Number.isFinite(data.score) || data.score < 0 || data.score > 100) {
        throw new Error('security score invalid')
      }
      const required = ['opsSafe', 'dashboardSafe', 'telegramSafe', 'maintenanceSafe', 'backupDrillSafe']
      const missing = required.filter((key) => data.wrappers?.[key] !== true)
      if (missing.length) throw new Error('missing safe wrappers: ' + missing.join(', '))
      if (data.headers?.rawShell !== false || data.headers?.dockerSocketExposedToBrowser !== false) {
        throw new Error('browser isolation posture invalid')
      }
      return `security score=${data.score}/100; required safe wrappers present`
    })

    await runCheck(details, '15', 'read-only', async () => {
      const data = await fetchJson(base, '/api/v2/daily-report', cookie, { timeout: 60_000 })
      if (!data.preview || typeof data.timers !== 'string') {
        throw new Error('daily report preview/timer payload invalid')
      }
      return 'daily report preview + existing Hermes timer readable; no Telegram message sent by self-test'
    })
  } catch (error) {
    details.push({
      id: 'bootstrap',
      feature: 'Self-test bootstrap',
      status: 'fail',
      mode: 'internal',
      durationMs: 0,
      error: sanitizeMessage(error.message)
    })
  }

  const passed = details.filter((item) => item.status === 'pass').length
  const failed = details.filter((item) => item.status === 'fail').length
  const status = failed === 0 && passed === FEATURE_NAMES.size ? 'pass' : 'fail'
  const finishedAt = new Date().toISOString()

  detailedState = {
    status,
    passed,
    failed,
    expected: FEATURE_NAMES.size,
    startedAt,
    lastRun: finishedAt,
    details
  }
  publicState = {
    status,
    passed,
    failed,
    expected: FEATURE_NAMES.size,
    lastRun: finishedAt,
    checks: details
      .filter((item) => /^\d{2}$/.test(item.id))
      .map(({ id, status: checkStatus, mode }) => ({ id, status: checkStatus, mode }))
  }

  try {
    await mkdir(STATE_DIR, { recursive: true, mode: 0o700 })
    await writeFile(STATE_FILE, JSON.stringify(detailedState, null, 2) + '\n', { mode: 0o600 })
  } catch {
    // Runtime state is still available if persistence fails.
  } finally {
    running = false
  }

  return detailedState
}

export function scheduleProductionSelfTest({ port, password }) {
  const run = () => {
    runProductionSelfTest({ port, password }).catch(() => {})
  }
  const startup = setTimeout(run, 8_000)
  startup.unref?.()
  const interval = setInterval(run, 30 * 60 * 1000)
  interval.unref?.()
}
