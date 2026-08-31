import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile, stat, writeFile, statfs } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const DOMAIN = process.env.CONTROL_DOMAIN || 'maulanaroyyantsubaisa.my.id'
const DATA_DIR = process.env.CONTROL_DATA_DIR || '/home/hermes/.hermes/control-plane-v2'
const AUDIT_FILE = path.join(DATA_DIR, 'audit.jsonl')
const DEPLOY_FILE = path.join(DATA_DIR, 'deployments.jsonl')
const INCIDENT_FILE = path.join(DATA_DIR, 'incidents.jsonl')
const MAINTENANCE_SAFE =
  process.env.HERMES_MAINTENANCE_BIN || '/usr/local/bin/hermes-control-maintenance-safe'
const BACKUP_DRILL_SAFE =
  process.env.HERMES_BACKUP_DRILL_BIN || '/usr/local/bin/hermes-backup-drill-safe'

const REPO_RE = /^MaulanaRoyyanTsubaisa\/[A-Za-z0-9._-]{1,100}$/

async function ensureState() {
  await mkdir(DATA_DIR, { recursive: true, mode: 0o700 })
}

async function appendJsonl(file, value) {
  await ensureState()
  await appendFile(file, JSON.stringify(value) + '\n', { encoding: 'utf8', mode: 0o600 })
  try {
    const info = await stat(file)
    if (info.size > 5 * 1024 * 1024) {
      const rows = (await readFile(file, 'utf8')).trim().split('\n').slice(-1200)
      await writeFile(file, rows.join('\n') + '\n', { mode: 0o600 })
    }
  } catch {
    // Best-effort rotation only.
  }
}

async function readJsonl(file, limit = 100) {
  try {
    return (await readFile(file, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .slice(-Math.max(1, Math.min(500, Number(limit) || 100)))
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      })
      .filter(Boolean)
      .reverse()
  } catch {
    return []
  }
}

function event(source, type, detail = {}) {
  return {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    source,
    type,
    ...detail
  }
}

async function publicProbe(app) {
  const url = `https://${app}.${DOMAIN}/`
  const started = Date.now()
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(6000),
      headers: { 'User-Agent': 'royyan-home-server-control/2' }
    })
    const latencyMs = Date.now() - started
    const reachable =
      (response.status >= 200 && response.status < 400) ||
      response.status === 401 ||
      response.status === 403
    return { app, url, reachable, status: response.status, latencyMs }
  } catch (error) {
    return {
      app,
      url,
      reachable: false,
      status: 0,
      latencyMs: Date.now() - started,
      error: error.message
    }
  }
}

async function resourceSnapshot() {
  const totalMem = os.totalmem()
  const freeMem = os.freemem()
  const memoryPercent = totalMem ? Math.round(((totalMem - freeMem) / totalMem) * 100) : 0
  const diskInfo = await statfs('/')
  const totalDisk = Number(diskInfo.blocks) * Number(diskInfo.bsize)
  const freeDisk = Number(diskInfo.bavail) * Number(diskInfo.bsize)
  const diskPercent = totalDisk ? Math.round(((totalDisk - freeDisk) / totalDisk) * 100) : 0
  const cpus = Math.max(1, os.cpus().length)
  const load1 = os.loadavg()[0]
  const loadLimit = cpus * 2.5

  return {
    memoryPercent,
    diskPercent,
    load1,
    loadLimit,
    cpus,
    memoryFreeBytes: freeMem,
    diskFreeBytes: freeDisk
  }
}

export function backupSummary(raw = '') {
  const text = String(raw || '')
  const ratio =
    text.match(/backup\s+verification:\s*(\d+)\s*\/\s*(\d+)\s*ok/i) ||
    text.match(/(\d+)\s*\/\s*(\d+)\s*(?:verified|ok)/i)
  const verifiedLine = text.match(/(?:verified|ok)\s*:\s*(\d+)/i)
  const failedLine = text.match(/(?:failed|failures?)\s*:\s*(\d+)/i)
  const staleLine = text.match(/stale\s*:\s*(\d+)/i)

  const verified = ratio ? Number(ratio[1]) : verifiedLine ? Number(verifiedLine[1]) : null
  const total = ratio ? Number(ratio[2]) : null
  const failedCount = failedLine ? Number(failedLine[1]) : null
  const staleCount = staleLine ? Number(staleLine[1]) : null

  const failure =
    failedCount !== null
      ? failedCount > 0
      : /\b(?:corrupt|invalid)\b/i.test(text) ||
        /\bfailed\b(?!\s*:\s*0\b)/i.test(text)
  const stale =
    staleCount !== null
      ? staleCount > 0
      : /\bstale\b(?!\s*:\s*0\b)/i.test(text)

  return {
    verified,
    total,
    failedCount,
    staleCount,
    failure,
    stale,
    raw: text
  }
}

export function healthHint(raw, app) {
  const line = String(raw || '')
    .split('\n')
    .find((candidate) => candidate.toLowerCase().includes(app.toLowerCase()))
  if (!line) return null
  const lower = line.toLowerCase()
  if (/✅|online|healthy|\bok\b/.test(lower)) return 'healthy'
  if (/❌|offline|failed|unhealthy/.test(lower)) return 'unhealthy'
  return 'unknown'
}

async function execSafe(bin, args, timeout = 120_000) {
  const { stdout, stderr } = await execFileAsync(bin, args, {
    timeout,
    maxBuffer: 2 * 1024 * 1024,
    env: {
      ...process.env,
      PATH:
        process.env.PATH ||
        '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
    }
  })
  return { stdout: stdout?.trim() || '', stderr: stderr?.trim() || '' }
}

export function registerControlPlaneV2({
  app,
  APPS,
  runSafeOps,
  runDashboardView,
  remember,
  sendViaHermesTelegram,
  HERMES_OPS_BIN,
  authConfigured
}) {
  const healthCache = { at: 0, value: null }

  async function audit(source, type, detail = {}) {
    const row = event(source, type, detail)
    await appendJsonl(AUDIT_FILE, row)
    return row
  }

  async function getHealthSnapshot(force = false) {
    if (!force && healthCache.value && Date.now() - healthCache.at < 12_000) {
      return healthCache.value
    }

    let dashboardRaw = ''
    try {
      const dashboard = await runDashboardView('apps')
      dashboardRaw = dashboard.stdout || dashboard.stderr || ''
    } catch {
      dashboardRaw = ''
    }

    const probes = await Promise.all(APPS.map((name) => publicProbe(name)))
    const apps = probes.map((probe) => ({
      ...probe,
      hermes: healthHint(dashboardRaw, probe.app)
    }))

    const value = {
      at: new Date().toISOString(),
      online: apps.filter((entry) => entry.reachable).length,
      total: apps.length,
      apps,
      hermesRaw: dashboardRaw
    }
    healthCache.at = Date.now()
    healthCache.value = value
    return value
  }

  async function getGuard() {
    const resources = await resourceSnapshot()
    let guardRaw = ''
    let guardRc = 0

    if (existsSync('/usr/local/bin/hermes-resource-guard-safe')) {
      try {
        const result = await execSafe('/usr/local/bin/hermes-resource-guard-safe', [], 20_000)
        guardRaw = result.stdout || result.stderr
      } catch (error) {
        guardRc = Number(error.code) || 1
        guardRaw = String(error.stdout || error.stderr || error.message || '')
      }
    } else {
      const reasons = []
      if (resources.memoryPercent >= 85) reasons.push(`RAM ${resources.memoryPercent}% >= 85%`)
      if (resources.diskPercent >= 85) reasons.push(`Disk ${resources.diskPercent}% >= 85%`)
      if (resources.load1 >= resources.loadLimit) {
        reasons.push(`Load ${resources.load1.toFixed(2)} >= ${resources.loadLimit.toFixed(2)}`)
      }
      guardRc = reasons.length ? 75 : 0
      guardRaw = reasons.length ? `UNSAFE: ${reasons.join('; ')}` : 'SAFE (dashboard fallback)'
    }

    let backup = { raw: '', failure: false, stale: false, verified: null, total: null }
    try {
      const out = await runDashboardView('backup')
      backup = backupSummary(out.stdout || out.stderr || '')
    } catch {
      // Keep backup status unknown rather than guessing.
    }

    const blockers = []
    if (guardRc !== 0) blockers.push(guardRaw || 'Resource Guard rejected deployment')
    if (backup.failure) blockers.push('Backup verification reports a failure')

    const warnings = []
    if (backup.stale) warnings.push('One or more backups are stale')
    if (backup.verified === null) warnings.push('Structured backup verification count unavailable')

    return {
      allowed: blockers.length === 0,
      blockers,
      warnings,
      guardRaw,
      backup,
      resources,
      at: new Date().toISOString()
    }
  }

  app.get('/api/v2/health/apps', async (req, res) => {
    try {
      res.json({ ok: true, ...(await getHealthSnapshot(req.query.force === '1')) })
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message })
    }
  })

  app.get('/api/v2/preflight', async (_req, res) => {
    try {
      res.json({ ok: true, ...(await getGuard()) })
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message })
    }
  })

  app.post('/api/v2/deploy/:app', async (req, res) => {
    const target = String(req.params.app || '').trim()
    if (!APPS.includes(target)) return res.status(400).json({ ok: false, error: 'Unknown app' })

    const guard = await getGuard()
    if (req.body?.dryRun === true) {
      return res.json({
        ok: true,
        dryRun: true,
        app: target,
        allowed: guard.allowed,
        guard,
        capability: {
          safeOps: existsSync(HERMES_OPS_BIN),
          command: 'deploy',
          mutatingActionExecuted: false
        }
      })
    }

    if (!guard.allowed) {
      await audit('web', 'deploy-blocked', { app: target, blockers: guard.blockers })
      return res.status(409).json({ ok: false, error: 'Deployment blocked by Resource Guard', guard })
    }

    await appendJsonl(DEPLOY_FILE, event('web', 'deploy-started', { app: target }))
    await audit('web', 'deploy-started', { app: target })

    try {
      const result = await runSafeOps('deploy', target)
      await appendJsonl(
        DEPLOY_FILE,
        event('web', 'deploy-finished', {
          app: target,
          status: 'queued-or-success',
          output: (result.stdout || result.stderr || '').slice(-3000)
        })
      )
      remember('deployment', `Deploy ${target}`, { ok: true })
      res.json({ ok: true, guard, ...result })
    } catch (error) {
      await appendJsonl(DEPLOY_FILE, event('web', 'deploy-failed', { app: target, error: error.message }))
      await appendJsonl(INCIDENT_FILE, event('web', 'deploy-failure', { app: target, error: error.message }))
      res.status(error.status || 500).json({ ok: false, error: error.message, guard })
    }
  })

  app.get('/api/v2/deployments', async (req, res) => {
    let hermesRaw = ''
    try {
      const result = await runDashboardView('deployments')
      hermesRaw = result.stdout || result.stderr || ''
    } catch {
      // Local history remains useful.
    }
    res.json({ ok: true, events: await readJsonl(DEPLOY_FILE, req.query.limit), hermesRaw })
  })

  app.get('/api/v2/incidents', async (req, res) => {
    let hermesRaw = ''
    try {
      const result = await runDashboardView('incidents')
      hermesRaw = result.stdout || result.stderr || ''
    } catch {
      // Persistent local incident history remains available.
    }
    res.json({ ok: true, events: await readJsonl(INCIDENT_FILE, req.query.limit), hermesRaw })
  })

  app.get('/api/v2/backups', async (_req, res) => {
    try {
      const [backup, timers] = await Promise.all([runDashboardView('backup'), runSafeOps('timers')])
      res.json({
        ok: true,
        summary: backupSummary(backup.stdout || backup.stderr || ''),
        timers: timers.stdout || timers.stderr || ''
      })
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message })
    }
  })

  app.post('/api/v2/backups/:app/run', async (req, res) => {
    const target = String(req.params.app || '')
    if (!APPS.includes(target)) return res.status(400).json({ ok: false, error: 'Unknown app' })
    try {
      const result = await runSafeOps('backup', target)
      await audit('web', 'backup-run', { app: target })
      res.json({ ok: true, ...result })
    } catch (error) {
      await audit('web', 'backup-failed', { app: target, error: error.message })
      res.status(error.status || 500).json({ ok: false, error: error.message })
    }
  })

  app.post('/api/v2/backups/:app/drill', async (req, res) => {
    const target = String(req.params.app || '')
    if (!APPS.includes(target)) return res.status(400).json({ ok: false, error: 'Unknown app' })
    if (!existsSync(BACKUP_DRILL_SAFE)) {
      return res.status(501).json({ ok: false, error: 'Backup restore-drill helper is not installed yet' })
    }
    if (req.body?.dryRun === true) {
      const guard = await getGuard()
      return res.json({
        ok: true,
        dryRun: true,
        app: target,
        helperInstalled: true,
        resourceGuardAllowed: guard.allowed,
        mutatingActionExecuted: false
      })
    }
    try {
      const result = await execSafe(BACKUP_DRILL_SAFE, [target], 240_000)
      await audit('web', 'backup-restore-drill', { app: target, ok: true })
      res.json({ ok: true, ...result })
    } catch (error) {
      await audit('web', 'backup-restore-drill', { app: target, ok: false, error: error.message })
      res.status(500).json({
        ok: false,
        error: error.message,
        output: String(error.stdout || error.stderr || '').slice(-4000)
      })
    }
  })

  app.get('/api/v2/logs/stream', async (req, res) => {
    const target = String(req.query.app || '')
    if (!APPS.includes(target)) return res.status(400).end('Unknown app')

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders?.()

    let closed = false
    let previous = ''
    req.on('close', () => {
      closed = true
    })

    const tick = async () => {
      if (closed) return
      try {
        const result = await runSafeOps('logs', target)
        const output = result.stdout || result.stderr || ''
        if (output !== previous) {
          previous = output
          res.write(`event: logs\ndata: ${JSON.stringify({ app: target, output, at: new Date().toISOString() })}\n\n`)
        } else {
          res.write(`event: ping\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`)
        }
      } catch (error) {
        res.write(`event: error\ndata: ${JSON.stringify({ error: error.message })}\n\n`)
      }
      if (!closed) setTimeout(tick, 4000)
    }

    tick()
  })

  app.post('/api/v2/autopilot/new-app', async (req, res) => {
    const repo = String(req.body?.repo || '').trim()
    if (!REPO_RE.test(repo)) {
      return res.status(400).json({
        ok: false,
        error: 'Repository must be MaulanaRoyyanTsubaisa/<repo>'
      })
    }

    try {
      const status = await execSafe(HERMES_OPS_BIN, ['repo-status', repo], 30_000)
      const statusText = status.stdout || status.stderr || ''

      if (req.body?.dryRun === true) {
        return res.json({
          ok: true,
          dryRun: true,
          repo,
          status: statusText,
          ownerAllowed: true,
          mutatingActionExecuted: false
        })
      }

      if (statusText.startsWith('KNOWN ')) {
        return res.json({ ok: true, state: 'known', repo, status: statusText })
      }

      const clone = await execSafe(HERMES_OPS_BIN, ['github-clone', repo], 120_000)
      await audit('web', 'autopilot-repo-added', { repo })
      res.json({
        ok: true,
        state: 'prepared',
        repo,
        status: statusText,
        clone: clone.stdout || clone.stderr || '',
        note: 'Hermes guarded auto-provision scanner will evaluate .home-server.json on its next run.'
      })
    } catch (error) {
      await audit('web', 'autopilot-repo-failed', { repo, error: error.message })
      res.status(500).json({ ok: false, error: error.message })
    }
  })

  app.get('/api/v2/maintenance', async (_req, res) => {
    const states = []
    for (const target of APPS) {
      if (!existsSync(MAINTENANCE_SAFE)) {
        states.push({ app: target, supported: false, active: false })
        continue
      }
      try {
        const result = await execSafe(MAINTENANCE_SAFE, ['status', target], 10_000)
        states.push({
          app: target,
          supported: true,
          active: /ACTIVE/i.test(result.stdout || result.stderr || ''),
          detail: result.stdout || result.stderr || ''
        })
      } catch (error) {
        states.push({ app: target, supported: true, active: false, error: error.message })
      }
    }
    res.json({ ok: true, helperInstalled: existsSync(MAINTENANCE_SAFE), apps: states })
  })

  app.post('/api/v2/maintenance/:app', async (req, res) => {
    const target = String(req.params.app || '')
    const action = req.body?.enabled ? 'on' : 'off'
    if (!APPS.includes(target)) return res.status(400).json({ ok: false, error: 'Unknown app' })
    if (!existsSync(MAINTENANCE_SAFE)) {
      return res.status(501).json({ ok: false, error: 'Maintenance helper is not installed yet' })
    }
    try {
      if (req.body?.dryRun === true) {
        const status = await execSafe(MAINTENANCE_SAFE, ['status', target], 10_000)
        return res.json({
          ok: true,
          dryRun: true,
          app: target,
          requestedAction: action,
          status: status.stdout || status.stderr || '',
          helperInstalled: true,
          mutatingActionExecuted: false
        })
      }

      const result = await execSafe(MAINTENANCE_SAFE, [action, target], 30_000)
      await audit('web', `maintenance-${action}`, { app: target })
      res.json({ ok: true, app: target, enabled: action === 'on', ...result })
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message })
    }
  })

  app.get('/api/v2/topology', async (_req, res) => {
    const health = await getHealthSnapshot()
    const nodes = [
      { id: 'cloudflare', type: 'edge', label: 'Cloudflare' },
      { id: 'router', type: 'router', label: 'hermes-router :8090' },
      ...health.apps.map((entry) => ({
        id: entry.app,
        type: 'app',
        label: entry.app,
        status: entry.reachable ? 'online' : 'offline',
        latencyMs: entry.latencyMs,
        httpStatus: entry.status
      }))
    ]
    const edges = [
      { from: 'cloudflare', to: 'router' },
      ...health.apps.map((entry) => ({ from: 'router', to: entry.app }))
    ]
    res.json({ ok: true, nodes, edges, at: health.at })
  })

  app.post('/api/v2/copilot', async (req, res) => {
    const question = String(req.body?.question || '').trim().slice(0, 1000)
    if (!question) return res.status(400).json({ ok: false, error: 'Question is empty' })

    const [health, guard, incidents, deployments] = await Promise.all([
      getHealthSnapshot(true),
      getGuard(),
      readJsonl(INCIDENT_FILE, 30),
      readJsonl(DEPLOY_FILE, 30)
    ])

    const findings = []
    const recommendations = []
    const offline = health.apps.filter((entry) => !entry.reachable)
    const slow = health.apps.filter((entry) => entry.reachable && entry.latencyMs > 2500)
    const failedDeploy = deployments.find((entry) => entry.type === 'deploy-failed')

    if (offline.length) {
      findings.push(
        `${offline.length} application(s) are not publicly reachable: ${offline.map((x) => x.app).join(', ')}`
      )
      recommendations.push('Inspect the affected app health/logs before restarting anything.')
    }
    if (slow.length) {
      findings.push(
        `Slow public response detected: ${slow.map((x) => `${x.app} ${x.latencyMs}ms`).join(', ')}`
      )
      recommendations.push('Compare slow apps with CPU/RAM/load and the most recent deployment.')
    }
    if (!guard.allowed) {
      findings.push(`Resource Guard is blocking deploys: ${guard.blockers.join('; ')}`)
      recommendations.push('Do not deploy until Resource Guard returns SAFE.')
    }
    if (guard.backup.failure || guard.backup.stale) {
      findings.push('Backup verification is not fully healthy.')
      recommendations.push('Run backup verification or a restore drill before risky changes.')
    }
    if (failedDeploy) {
      findings.push(`A recent deploy failure exists for ${failedDeploy.app || 'an app'}.`)
      recommendations.push('Compare the failed deployment with the previous healthy release and rollback evidence.')
    }
    if (!findings.length) {
      findings.push('No obvious fleet-wide fault is visible in the current safe telemetry.')
      recommendations.push('If the issue is app-specific, open Live Logs for that app and ask again with the symptom.')
    }

    const answer = [
      `Question: ${question}`,
      '',
      'Findings:',
      ...findings.map((item) => `• ${item}`),
      '',
      'Recommended next actions:',
      ...recommendations.map((item) => `• ${item}`),
      '',
      'Safety: no destructive action or automatic database restore was performed.'
    ].join('\n')

    await audit('web', 'copilot-analysis', { question: question.slice(0, 180) })
    res.json({
      ok: true,
      answer,
      findings,
      recommendations,
      evidence: {
        healthAt: health.at,
        offline: offline.map((item) => item.app),
        guardAllowed: guard.allowed,
        activeLocalIncidents: incidents.length
      },
      mode: 'deterministic-safe-ops'
    })
  })

  app.get('/api/v2/security', async (_req, res) => {
    let listeners = []
    try {
      const result = await execFileAsync('ss', ['-H', '-ltn'], { timeout: 5000 })
      listeners = result.stdout
        .split('\n')
        .filter(Boolean)
        .map((line) => line.trim().split(/\s+/).slice(-2)[0] || '')
        .filter(Boolean)
        .slice(0, 100)
    } catch {
      listeners = []
    }

    const wrappers = {
      opsSafe: existsSync('/usr/local/bin/hermes-ops-safe'),
      dashboardSafe: existsSync('/usr/local/bin/hermes-dashboard-safe'),
      telegramSafe: existsSync('/usr/local/bin/hermes-telegram-send-safe'),
      maintenanceSafe: existsSync(MAINTENANCE_SAFE),
      backupDrillSafe: existsSync(BACKUP_DRILL_SAFE)
    }

    const score = Math.max(
      0,
      100 -
        (authConfigured ? 0 : 35) -
        (wrappers.opsSafe ? 0 : 25) -
        (wrappers.dashboardSafe ? 0 : 20) -
        (wrappers.telegramSafe ? 0 : 10)
    )

    res.json({
      ok: true,
      score,
      authConfigured,
      wrappers,
      listeners,
      headers: {
        session: 'HttpOnly + SameSite=Strict',
        rawShell: false,
        dockerSocketExposedToBrowser: false,
        secretsExposedToBrowser: false
      }
    })
  })

  app.get('/api/v2/audit', async (req, res) => {
    res.json({ ok: true, events: await readJsonl(AUDIT_FILE, req.query.limit) })
  })

  app.get('/api/v2/daily-report', async (_req, res) => {
    let timers = ''
    try {
      const result = await runSafeOps('timers')
      timers = result.stdout || result.stderr || ''
    } catch {
      timers = ''
    }
    const [health, guard] = await Promise.all([getHealthSnapshot(), getGuard()])
    res.json({
      ok: true,
      schedule: 'Existing Hermes daily report timer (08:00 WIB, randomized delay up to 5m)',
      timers,
      preview: {
        apps: `${health.online}/${health.total} reachable`,
        memory: `${guard.resources.memoryPercent}%`,
        disk: `${guard.resources.diskPercent}%`,
        load: guard.resources.load1,
        backups: guard.backup
      }
    })
  })

  app.post('/api/v2/daily-report/send-now', async (_req, res) => {
    const [health, guard] = await Promise.all([getHealthSnapshot(true), getGuard()])
    const message = [
      '🏠 HOME SERVER CONTROL REPORT',
      '',
      `📦 Apps: ${health.online}/${health.total} reachable`,
      `🧠 RAM: ${guard.resources.memoryPercent}%`,
      `💾 Disk: ${guard.resources.diskPercent}%`,
      `📈 Load: ${guard.resources.load1.toFixed(2)}/${guard.resources.loadLimit.toFixed(2)}`,
      `🛡️ Resource Guard: ${guard.allowed ? 'SAFE' : 'BLOCKED'}`,
      `🗄️ Backups: ${
        guard.backup.failure
          ? 'verification issue'
          : guard.backup.stale
            ? 'stale warning'
            : 'no failure detected'
      }`,
      '',
      guard.allowed && health.online === health.total
        ? '✅ Overall: no immediate action required.'
        : '⚠️ Open Mission Control for details.'
    ].join('\n')

    try {
      await sendViaHermesTelegram(message)
      await audit('web', 'daily-report-send-now')
      res.json({ ok: true, message })
    } catch (error) {
      res.status(502).json({ ok: false, error: error.message })
    }
  })

  ensureState().catch(() => {})

  return { audit }
}
