import path from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

const DATA_DIR = process.env.CONTROL_V3_DATA_DIR || '/home/hermes/.hermes/infrastructure-os-v3'
const ACCEPTANCE_VERSION = '2026-08-31-v3-real-acceptance-v1'
const ACCEPTANCE_FILE = path.join(DATA_DIR, 'v3-acceptance.json')

let recurringState = {
  status: 'pending',
  passed: 0,
  failed: 0,
  expected: 20,
  lastRun: null,
  checks: []
}
let acceptanceState = {
  version: ACCEPTANCE_VERSION,
  status: 'pending',
  passed: 0,
  failed: 0,
  expected: 5,
  lastRun: null,
  checks: []
}
let recurringBusy = false
let acceptanceBusy = false

function sanitize(value) {
  return String(value || '')
    .replace(/[A-Fa-f0-9]{24,}/g, '<redacted>')
    .replace(/(password|secret|token|authorization)[^\n]{0,160}/gi, '$1=<redacted>')
    .slice(0, 700)
}

async function login(base, password) {
  const response = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
    signal: AbortSignal.timeout(12000)
  })
  if (!response.ok) throw new Error('V3 self-test login failed: HTTP ' + response.status)
  const cookie = (response.headers.get('set-cookie') || '').split(';')[0]
  if (!cookie.startsWith('control_session=')) throw new Error('V3 self-test login returned no session cookie')
  return cookie
}

async function json(base, pathname, cookie, options = {}) {
  const response = await fetch(base + pathname, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(options.timeout || 90000)
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

async function check(rows, id, label, fn) {
  const started = Date.now()
  try {
    const note = await fn()
    rows.push({
      id,
      label,
      status: 'pass',
      durationMs: Date.now() - started,
      note: sanitize(note || '')
    })
  } catch (error) {
    rows.push({
      id,
      label,
      status: 'fail',
      durationMs: Date.now() - started,
      error: sanitize(error.message)
    })
  }
}

function publicize(state) {
  return {
    version: state.version,
    status: state.status,
    passed: state.passed,
    failed: state.failed,
    expected: state.expected,
    lastRun: state.lastRun,
    checks: (state.checks || []).map(({ id, status }) => ({ id, status }))
  }
}

export function getV3SelfTestPublicState() {
  return {
    recurring: publicize(recurringState),
    acceptance: publicize(acceptanceState)
  }
}

export function getV3SelfTestDetailedState() {
  return { recurring: recurringState, acceptance: acceptanceState }
}

export async function runV3RecurringSelfTest({ port, password }) {
  if (recurringBusy) return recurringState
  recurringBusy = true
  const rows = []
  const base = 'http://127.0.0.1:' + port

  try {
    const cookie = await login(base, password)

    await check(rows, '01', 'Digital Twin', async () => {
      const data = await json(base, '/api/v3/overview', cookie, { timeout: 120000 })
      if (data.version !== 3 || !Array.isArray(data.snapshot?.apps) || !data.snapshot.apps.length) {
        throw new Error('Digital Twin snapshot invalid')
      }
      return data.snapshot.online + '/' + data.snapshot.total + ' apps online'
    })

    await check(rows, '02', 'Infrastructure Time Machine', async () => {
      const data = await json(base, '/api/v3/time-machine?limit=10', cookie)
      if (!Array.isArray(data.samples) || data.count < 1) throw new Error('Time Machine has no real samples')
      return data.count + ' persisted samples'
    })

    await check(rows, '03', 'Chaos Engineering Lab', async () => {
      const overview = await json(base, '/api/v3/overview', cookie)
      const target = overview.snapshot.apps.find((x) => x.reachable && x.status !== 503)?.app
      if (!target) throw new Error('No healthy app available for chaos simulation')
      const data = await json(base, '/api/v3/chaos', cookie, {
        method: 'POST',
        body: JSON.stringify({ app: target, mode: 'simulation' })
      })
      if (data.mode !== 'simulation' || !Array.isArray(data.timeline)) throw new Error('Chaos simulation contract invalid')
      return 'safe simulation path valid for ' + target
    })

    await check(rows, '04', 'Autonomous Incident Commander', async () => {
      const data = await json(base, '/api/v3/incident-commander', cookie)
      if (typeof data.active !== 'boolean' || !Array.isArray(data.affectedApps) || !Array.isArray(data.plan)) {
        throw new Error('Incident Commander payload invalid')
      }
      return data.active ? data.severity + ' active' : 'standby'
    })

    await check(rows, '05', 'Root Cause Correlation', async () => {
      const data = await json(base, '/api/v3/root-cause', cookie)
      if (!Array.isArray(data.findings) || !Array.isArray(data.evidence) || data.mode !== 'telemetry-correlation') {
        throw new Error('RCA payload invalid')
      }
      return data.affectedApps.length + ' affected apps correlated'
    })

    await check(rows, '06', 'Automatic Postmortem', async () => {
      const data = await json(base, '/api/v3/postmortems?limit=5', cookie)
      if (!Array.isArray(data.reports)) throw new Error('Postmortem store unreadable')
      return data.reports.length + ' persisted reports available'
    })

    await check(rows, '07', 'Blue Green Canary', async () => {
      const data = await json(base, '/api/v3/canary/readiness', cookie)
      if (data.strategy !== 'blue-green/canary' || !Array.isArray(data.requirements)) {
        throw new Error('Canary readiness contract invalid')
      }
      return data.supported ? data.configuredApps.length + ' apps configured' : 'framework ready; no app opted in'
    })

    await check(rows, '08', 'Disaster Recovery Rehearsal', async () => {
      const data = await json(base, '/api/v3/dr/readiness', cookie)
      if (!Number.isFinite(data.score) || typeof data.verifiedRestoreEvidence !== 'boolean') {
        throw new Error('DR readiness invalid')
      }
      return 'DR score ' + data.score + '/100'
    })

    await check(rows, '09', 'Reliability Score', async () => {
      const data = await json(base, '/api/v3/reliability', cookie)
      if (!Number.isFinite(data.score?.total) || !data.score?.evidence) {
        throw new Error('Reliability score lacks measured evidence')
      }
      if (data.score.total < 0 || data.score.total > 100) throw new Error('Reliability score out of range')
      return 'measured reliability ' + data.score.total + '/100'
    })

    await check(rows, '10', 'Natural Language Command Center', async () => {
      const plan = await json(base, '/api/v3/command/plan', cookie, {
        method: 'POST',
        body: JSON.stringify({ text: 'cek kondisi server' })
      })
      if (plan.plan?.intent !== 'status' || plan.plan?.mutating !== false) throw new Error('Read-only command plan incorrect')
      const executed = await json(base, '/api/v3/command/execute', cookie, {
        method: 'POST',
        body: JSON.stringify({ text: 'cek kondisi server' }),
        timeout: 60000
      })
      if (!executed.ok || typeof executed.output !== 'string') throw new Error('Read-only command execution failed')
      return 'status command planned and executed via Hermes safe ops'
    })

    await check(rows, '11', 'Capacity Planner', async () => {
      const data = await json(base, '/api/v3/capacity', cookie)
      if (!data.latest || !data.forecast || !Number.isFinite(data.latest.diskPercent)) {
        throw new Error('Capacity planner payload invalid')
      }
      return data.samples + ' samples; disk ' + data.latest.diskPercent + '%'
    })

    await check(rows, '12', 'Power Intelligence', async () => {
      const data = await json(base, '/api/v3/power', cookie)
      if (typeof data.configured !== 'boolean' || typeof data.hardwareNeededForRealtime !== 'boolean') {
        throw new Error('Power integration readiness invalid')
      }
      return data.configured ? 'power telemetry configured' : 'software ready; power hardware not connected'
    })

    await check(rows, '13', 'Secondary Node Failover', async () => {
      const data = await json(base, '/api/v3/failover', cookie)
      if (typeof data.configured !== 'boolean' || !Array.isArray(data.requirements)) {
        throw new Error('Failover readiness invalid')
      }
      return data.configured ? 'secondary node configured' : 'software ready; node-2 not connected'
    })

    await check(rows, '14', 'Credential Vault', async () => {
      const data = await json(base, '/api/v3/vault', cookie)
      if (data.browserSecretsExposed !== false || !data.backend) {
        throw new Error('Vault posture invalid')
      }
      return data.encryptedVaultConfigured ? 'encrypted vault backend configured' : 'root-protected secrets remain hidden from browser'
    })

    await check(rows, '15', 'Cinematic War Room', async () => {
      const data = await json(base, '/api/v3/war-room', cookie)
      if (typeof data.active !== 'boolean' || !Array.isArray(data.timeline)) throw new Error('War Room payload invalid')
      return data.active ? 'war room active' : 'standby'
    })

    await check(rows, '16', 'Black Box Recorder', async () => {
      const data = await json(base, '/api/v3/blackbox?limit=10', cookie)
      if (!Array.isArray(data.events) || data.count < 1) throw new Error('Black Box has no persisted telemetry')
      return data.count + ' black-box events'
    })

    await check(rows, '17', 'Predictive Incident Detection', async () => {
      const data = await json(base, '/api/v3/predictive-risk', cookie)
      if (!Array.isArray(data.risks) || !data.prediction) throw new Error('Predictive risk payload invalid')
      return data.prediction + '; ' + data.risks.length + ' risks'
    })

    await check(rows, '18', 'Git Commit Risk Scoring', async () => {
      const data = await json(base, '/api/v3/commit-risk?repo=royyan-home-server-control', cookie, { timeout: 30000 })
      if (!Number.isFinite(data.risk) || !['LOW','MEDIUM','HIGH'].includes(data.level)) {
        throw new Error('Commit risk scorer invalid')
      }
      return data.level + ' ' + data.risk + '/100 for ' + data.sha
    })

    await check(rows, '19', 'Visual Deployment Replay', async () => {
      const data = await json(base, '/api/v3/deployment-replay', cookie)
      if (!Array.isArray(data.timeline) || data.source !== 'persistent-control-plane-deployment-history') {
        throw new Error('Deployment replay payload invalid')
      }
      if (!data.timeline.length) throw new Error('No persisted deployment event available for real replay')
      return data.timeline.length + ' actual deployment events'
    })

    await check(rows, '20', 'Hermes Skill System', async () => {
      const list = await json(base, '/api/v3/skills', cookie)
      if (!Array.isArray(list.skills) || list.skills.length < 8) throw new Error('Hermes skill registry incomplete')
      const output = await json(base, '/api/v3/skills/fleet-health/run', cookie, {
        method: 'POST',
        body: JSON.stringify({}),
        timeout: 120000
      })
      if (!output.ok || output.skill?.id !== 'fleet-health') throw new Error('Hermes skill execution failed')
      return list.skills.length + ' skills registered; fleet-health executed'
    })
  } catch (error) {
    rows.push({ id: 'bootstrap', label: 'V3 self-test bootstrap', status: 'fail', error: sanitize(error.message) })
  } finally {
    const passed = rows.filter((x) => x.status === 'pass').length
    const failed = rows.filter((x) => x.status === 'fail').length
    recurringState = {
      status: passed === 20 && failed === 0 ? 'pass' : 'fail',
      passed,
      failed,
      expected: 20,
      lastRun: new Date().toISOString(),
      checks: rows
    }
    recurringBusy = false
  }

  return recurringState
}

async function loadAcceptance() {
  try {
    const stored = JSON.parse(await readFile(ACCEPTANCE_FILE, 'utf8'))
    if (stored.version === ACCEPTANCE_VERSION && stored.status === 'pass') {
      acceptanceState = stored
      return true
    }
  } catch {
    // First run.
  }
  return false
}

export async function runV3RealAcceptance({ port, password }) {
  if (acceptanceBusy) return acceptanceState
  if (await loadAcceptance()) return acceptanceState
  acceptanceBusy = true
  const base = 'http://127.0.0.1:' + port
  const rows = []

  try {
    const cookie = await login(base, password)
    const overview = await json(base, '/api/v3/overview', cookie, { timeout: 120000 })
    const replay = await json(base, '/api/v3/deployment-replay', cookie)
    const healthyApps = overview.snapshot.apps.filter((x) => x.reachable && x.status !== 503)
    const target =
      healthyApps.find((x) => x.app === replay.app)?.app ||
      healthyApps.find((x) => x.app === 'rumahin')?.app ||
      healthyApps[0]?.app
    if (!target) throw new Error('No healthy app available for V3 real acceptance')

    await check(rows, 'A', 'Real safe restart chaos recovery', async () => {
      const result = await json(base, '/api/v3/chaos', cookie, {
        method: 'POST',
        body: JSON.stringify({
          app: target,
          mode: 'safe-restart',
          confirm: 'CHAOS_SAFE_RESTART'
        }),
        timeout: 120000
      })
      if (!result.ok || !result.after?.reachable || result.after?.status === 503) {
        throw new Error('Real safe-restart chaos test did not recover')
      }
      return target + ' recovered in ' + result.recoveryMs + 'ms'
    })

    await check(rows, 'B', 'Real postmortem persistence', async () => {
      const generated = await json(base, '/api/v3/postmortem/generate', cookie, {
        method: 'POST',
        body: JSON.stringify({ title: 'V3 acceptance postmortem' })
      })
      if (!generated.report?.id) throw new Error('Postmortem generation failed')
      const list = await json(base, '/api/v3/postmortems?limit=20', cookie)
      if (!list.reports.some((x) => x.id === generated.report.id)) throw new Error('Generated postmortem was not persisted')
      return 'postmortem persisted and readable'
    })

    await check(rows, 'C', 'Mutation approval boundary', async () => {
      const response = await fetch(base + '/api/v3/command/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ text: 'restart ' + target }),
        signal: AbortSignal.timeout(30000)
      })
      if (response.status !== 409) throw new Error('Mutating natural-language command was not blocked without approval')
      return 'unsafe implicit mutation correctly blocked with HTTP 409'
    })

    await check(rows, 'D', 'Real Resource Guard skill', async () => {
      const result = await json(base, '/api/v3/skills/resource-guard/run', cookie, {
        method: 'POST',
        body: JSON.stringify({}),
        timeout: 30000
      })
      if (!result.ok || result.skill?.id !== 'resource-guard') throw new Error('Resource Guard skill execution failed')
      return 'actual Resource Guard safe helper executed'
    })

    await check(rows, 'E', 'Real deployment replay evidence', async () => {
      const result = await json(base, '/api/v3/deployment-replay?app=' + encodeURIComponent(target), cookie)
      if (!Array.isArray(result.timeline) || !result.timeline.length) {
        throw new Error('No real deployment history for ' + target)
      }
      return result.timeline.length + ' persisted deploy events replayed for ' + target
    })
  } catch (error) {
    rows.push({ id: 'bootstrap', label: 'V3 real acceptance bootstrap', status: 'fail', error: sanitize(error.message) })
  } finally {
    const passed = rows.filter((x) => x.status === 'pass').length
    const failed = rows.filter((x) => x.status === 'fail').length
    acceptanceState = {
      version: ACCEPTANCE_VERSION,
      status: passed === 5 && failed === 0 ? 'pass' : 'fail',
      passed,
      failed,
      expected: 5,
      lastRun: new Date().toISOString(),
      checks: rows
    }
    try {
      await mkdir(DATA_DIR, { recursive: true, mode: 0o700 })
      await writeFile(ACCEPTANCE_FILE, JSON.stringify(acceptanceState, null, 2) + '\n', { mode: 0o600 })
    } catch {
      // In-memory result still available.
    }
    acceptanceBusy = false
  }

  return acceptanceState
}

export function scheduleV3Tests({ port, password }) {
  const startup = setTimeout(() => {
    runV3RecurringSelfTest({ port, password }).catch(() => {})
    runV3RealAcceptance({ port, password }).catch(() => {})
  }, 35000)
  startup.unref?.()

  const recurring = setInterval(() => {
    runV3RecurringSelfTest({ port, password }).catch(() => {})
  }, 30 * 60 * 1000)
  recurring.unref?.()
}
