import path from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

const STATE_DIR = process.env.CONTROL_DATA_DIR || '/home/hermes/.hermes/control-plane-v2'
const VERSION = '2026-08-31-full-v1'
const STATE_FILE = path.join(STATE_DIR, 'deep-production-acceptance.json')

let publicState = {
  version: VERSION,
  status: 'pending',
  passed: 0,
  failed: 0,
  startedAt: null,
  finishedAt: null,
  checks: []
}
let detailedState = { ...publicState, details: [] }
let running = false

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function sanitize(value) {
  return String(value || '')
    .replace(/[A-Fa-f0-9]{24,}/g, '<redacted>')
    .replace(/(password|secret|token|authorization)[^\n]{0,160}/gi, '$1=<redacted>')
    .slice(0, 800)
}

async function fetchJson(base, pathname, cookie, options = {}) {
  const response = await fetch(base + pathname, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(options.headers || {})
    },
    signal: options.signal || AbortSignal.timeout(options.timeout || 60_000)
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(payload.error || 'HTTP ' + response.status + ' for ' + pathname)
    error.status = response.status
    error.payload = payload
    throw error
  }
  return payload
}

async function login(base, password) {
  const response = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
    signal: AbortSignal.timeout(12_000)
  })
  if (!response.ok) throw new Error('deep acceptance login failed: HTTP ' + response.status)
  const cookie = (response.headers.get('set-cookie') || '').split(';')[0]
  if (!cookie.startsWith('control_session=')) throw new Error('deep acceptance login returned no session cookie')
  return cookie
}

async function publicHttp(url, timeout = 15_000) {
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'User-Agent': 'royyan-control-deep-acceptance/1' },
      signal: AbortSignal.timeout(timeout)
    })
    return response.status
  } catch {
    return 0
  }
}

async function pollPublic(url, predicate, attempts = 18, delayMs = 5000) {
  let last = 0
  for (let i = 0; i < attempts; i += 1) {
    last = await publicHttp(url)
    if (predicate(last)) return last
    if (i + 1 < attempts) await sleep(delayMs)
  }
  throw new Error('public health did not reach expected state; last HTTP ' + last)
}

async function addCheck(details, id, label, fn) {
  const started = Date.now()
  try {
    const note = await fn()
    details.push({
      id,
      label,
      status: 'pass',
      durationMs: Date.now() - started,
      note: sanitize(note)
    })
    return true
  } catch (error) {
    details.push({
      id,
      label,
      status: 'fail',
      durationMs: Date.now() - started,
      error: sanitize(error.message)
    })
    return false
  }
}

async function persist() {
  try {
    await mkdir(STATE_DIR, { recursive: true, mode: 0o700 })
    await writeFile(STATE_FILE, JSON.stringify(detailedState, null, 2) + '\n', { mode: 0o600 })
  } catch {
    // In-memory state remains available.
  }
}

async function loadPersisted() {
  try {
    const data = JSON.parse(await readFile(STATE_FILE, 'utf8'))
    if (data.version === VERSION && data.status === 'pass') {
      detailedState = data
      publicState = {
        version: data.version,
        status: data.status,
        passed: data.passed,
        failed: data.failed,
        startedAt: data.startedAt,
        finishedAt: data.finishedAt,
        checks: (data.details || []).map(({ id, status }) => ({ id, status }))
      }
      return true
    }
  } catch {
    // No previous pass.
  }
  return false
}

export function getPublicDeepAcceptanceState() {
  return publicState
}

export function getDetailedDeepAcceptanceState() {
  return detailedState
}

export async function runDeepProductionAcceptance({ port, password }) {
  if (running) return detailedState
  if (await loadPersisted()) return detailedState

  running = true
  const base = 'http://127.0.0.1:' + port
  const details = []
  const startedAt = new Date().toISOString()
  publicState = { version: VERSION, status: 'running', passed: 0, failed: 0, startedAt, finishedAt: null, checks: [] }

  try {
    const cookie = await login(base, password)
    const config = await fetchJson(base, '/api/config', cookie)
    const apps = Array.isArray(config.apps) ? config.apps : []
    if (!apps.length) throw new Error('no apps configured for deep acceptance')

    const health = await fetchJson(base, '/api/v2/health/apps?force=1', cookie, { timeout: 90_000 })
    const reachable = (health.apps || []).filter((item) => item.reachable)
    const maintenanceTarget = reachable.find((item) => item.app === 'rumahin')?.app || reachable[0]?.app || apps[0]
    const deployTarget = reachable.find((item) => item.app === 'rumahin')?.app || reachable[0]?.app || apps[0]

    await addCheck(details, 'A', 'Actual backup + isolated restore drill', async () => {
      let lastError = ''
      for (const candidate of [deployTarget, ...apps.filter((name) => name !== deployTarget)]) {
        try {
          const backup = await fetchJson(base, '/api/v2/backups/' + encodeURIComponent(candidate) + '/run', cookie, {
            method: 'POST',
            body: JSON.stringify({}),
            timeout: 180_000
          })
          const drill = await fetchJson(base, '/api/v2/backups/' + encodeURIComponent(candidate) + '/drill', cookie, {
            method: 'POST',
            body: JSON.stringify({}),
            timeout: 300_000
          })
          if (!drill.ok) throw new Error('restore drill returned not-ok')
          return 'actual backup and disposable PostgreSQL restore drill passed for ' + candidate + '; production DB untouched'
        } catch (error) {
          lastError = candidate + ': ' + error.message
        }
      }
      throw new Error('no backup-capable app completed restore drill; last=' + lastError)
    })

    await addCheck(details, 'B', 'Actual maintenance traffic cutover + recovery', async () => {
      const url = 'https://' + maintenanceTarget + '.maulanaroyyantsubaisa.my.id/'
      let enabled = false
      try {
        const before = await publicHttp(url)
        if (!((before >= 200 && before < 400) || before === 401 || before === 403)) {
          throw new Error('target app not healthy before maintenance: HTTP ' + before)
        }

        await fetchJson(base, '/api/v2/maintenance/' + encodeURIComponent(maintenanceTarget), cookie, {
          method: 'POST',
          body: JSON.stringify({ enabled: true }),
          timeout: 45_000
        })
        enabled = true

        const during = await pollPublic(url, (code) => code === 503, 12, 3000)
        if (during !== 503) throw new Error('maintenance did not return 503')
      } finally {
        if (enabled) {
          await fetchJson(base, '/api/v2/maintenance/' + encodeURIComponent(maintenanceTarget), cookie, {
            method: 'POST',
            body: JSON.stringify({ enabled: false }),
            timeout: 45_000
          }).catch(() => {})
        }
      }

      const recovered = await pollPublic(
        url,
        (code) => (code >= 200 && code < 400) || code === 401 || code === 403,
        20,
        4000
      )
      return 'maintenance 503 observed and ' + maintenanceTarget + ' recovered to HTTP ' + recovered
    })

    await addCheck(details, 'C', 'Actual Hermes-managed app deploy + post-deploy health', async () => {
      const preflight = await fetchJson(base, '/api/v2/preflight', cookie, { timeout: 60_000 })
      if (!preflight.allowed) throw new Error('Resource Guard blocked actual deploy: ' + (preflight.blockers || []).join('; '))

      await fetchJson(base, '/api/v2/deploy/' + encodeURIComponent(deployTarget), cookie, {
        method: 'POST',
        body: JSON.stringify({}),
        timeout: 120_000
      })

      const url = 'https://' + deployTarget + '.maulanaroyyantsubaisa.my.id/'
      const recovered = await pollPublic(
        url,
        (code) => (code >= 200 && code < 400) || code === 401 || code === 403,
        30,
        5000
      )
      return 'actual deploy path executed for ' + deployTarget + ' and public health recovered to HTTP ' + recovered
    })

    await addCheck(details, 'D', 'Actual known-repo Autopilot path', async () => {
      const knownRepos = [
        'MaulanaRoyyanTsubaisa/sajiin',
        'MaulanaRoyyanTsubaisa/royyan-home-server-control'
      ]
      let last = ''
      for (const repo of knownRepos) {
        try {
          const result = await fetchJson(base, '/api/v2/autopilot/new-app', cookie, {
            method: 'POST',
            body: JSON.stringify({ repo }),
            timeout: 60_000
          })
          if (result.state === 'known') {
            return 'real Autopilot repo-status path accepted known repo ' + repo + ' without creating junk resources'
          }
          last = repo + ' returned state=' + String(result.state)
        } catch (error) {
          last = repo + ': ' + error.message
        }
      }
      throw new Error('known-repo Autopilot test did not return known; last=' + last)
    })

    await addCheck(details, 'E', 'Actual Telegram outbound sender', async () => {
      const result = await fetchJson(base, '/api/v2/daily-report/send-now', cookie, {
        method: 'POST',
        body: JSON.stringify({}),
        timeout: 90_000
      })
      if (!result.ok || !result.message) throw new Error('Telegram report sender returned invalid payload')
      return 'one real enhanced server report was delivered through the existing Hermes Telegram sender'
    })
  } catch (error) {
    details.push({
      id: 'bootstrap',
      label: 'Deep acceptance bootstrap',
      status: 'fail',
      durationMs: 0,
      error: sanitize(error.message)
    })
  }

  const passed = details.filter((item) => item.status === 'pass').length
  const failed = details.filter((item) => item.status === 'fail').length
  const status = failed === 0 && passed === 5 ? 'pass' : 'fail'
  const finishedAt = new Date().toISOString()

  detailedState = { version: VERSION, status, passed, failed, expected: 5, startedAt, finishedAt, details }
  publicState = {
    version: VERSION,
    status,
    passed,
    failed,
    expected: 5,
    startedAt,
    finishedAt,
    checks: details.filter((item) => item.id !== 'bootstrap').map(({ id, status: s }) => ({ id, status: s }))
  }

  await persist()
  running = false
  return detailedState
}

export function scheduleDeepProductionAcceptance({ port, password }) {
  const timer = setTimeout(() => {
    runDeepProductionAcceptance({ port, password }).catch(() => {})
  }, 25_000)
  timer.unref?.()
}
