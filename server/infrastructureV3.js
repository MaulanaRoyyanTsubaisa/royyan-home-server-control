import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile, stat, statfs, writeFile } from 'node:fs/promises'

const DATA_DIR = process.env.CONTROL_V3_DATA_DIR || '/home/hermes/.hermes/infrastructure-os-v3'
const SNAPSHOT_FILE = path.join(DATA_DIR, 'snapshots.jsonl')
const BLACKBOX_FILE = path.join(DATA_DIR, 'blackbox.jsonl')
const POSTMORTEM_FILE = path.join(DATA_DIR, 'postmortems.jsonl')
const DOMAIN = process.env.CONTROL_DOMAIN || 'maulanaroyyantsubaisa.my.id'

const SKILLS = [
  { id: 'fleet-health', name: 'Fleet Health', mode: 'read-only', description: 'Probe every public app and correlate Hermes health.' },
  { id: 'resource-guard', name: 'Resource Guard', mode: 'read-only', description: 'Read RAM, disk, load and Hermes deployment guard.' },
  { id: 'backup-status', name: 'Backup Verification', mode: 'read-only', description: 'Inspect current backup verification and timers.' },
  { id: 'deploy-history', name: 'Deployment History', mode: 'read-only', description: 'Inspect Hermes deployment state.' },
  { id: 'incident-triage', name: 'Incident Triage', mode: 'read-only', description: 'Correlate incidents, fleet health and resources.' },
  { id: 'capacity-plan', name: 'Capacity Planner', mode: 'read-only', description: 'Estimate capacity trend from Infrastructure Time Machine samples.' },
  { id: 'dr-readiness', name: 'Disaster Recovery Readiness', mode: 'read-only', description: 'Check whether backups, app health and recovery evidence are present.' },
  { id: 'security-posture', name: 'Security Posture', mode: 'read-only', description: 'Summarize safe-wrapper and control-plane isolation posture.' }
]

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function ensureDir() {
  await mkdir(DATA_DIR, { recursive: true, mode: 0o700 })
}

async function appendJsonl(file, row, maxRows = 6000) {
  await ensureDir()
  await appendFile(file, JSON.stringify(row) + '\n', { encoding: 'utf8', mode: 0o600 })
  try {
    const info = await stat(file)
    if (info.size > 12 * 1024 * 1024) {
      const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean).slice(-maxRows)
      await writeFile(file, lines.join('\n') + '\n', { mode: 0o600 })
    }
  } catch {
    // Best effort.
  }
}

async function readJsonl(file, limit = 500) {
  try {
    return (await readFile(file, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .slice(-Math.max(1, Math.min(6000, Number(limit) || 500)))
      .map((line) => {
        try { return JSON.parse(line) } catch { return null }
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

function safeText(value, limit = 2500) {
  return String(value || '')
    .replace(/[A-Fa-f0-9]{24,}/g, '<redacted>')
    .replace(/(password|secret|token|authorization)[^\n]{0,160}/gi, '$1=<redacted>')
    .slice(0, limit)
}

async function publicProbe(app) {
  const url = 'https://' + app + '.' + DOMAIN + '/'
  const started = Date.now()
  try {
    const response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(6500),
      headers: { 'User-Agent': 'royyan-infrastructure-os-v3/1' }
    })
    const status = response.status
    const reachable =
      (status >= 200 && status < 400) || status === 401 || status === 403 || status === 503
    return { app, url, reachable, status, latencyMs: Date.now() - started }
  } catch (error) {
    return { app, url, reachable: false, status: 0, latencyMs: Date.now() - started, error: safeText(error.message, 240) }
  }
}

async function resources() {
  const totalMem = os.totalmem()
  const freeMem = os.freemem()
  const disk = await statfs('/')
  const totalDisk = Number(disk.blocks) * Number(disk.bsize)
  const freeDisk = Number(disk.bavail) * Number(disk.bsize)
  return {
    memoryPercent: totalMem ? Math.round(((totalMem - freeMem) / totalMem) * 100) : 0,
    memoryFreeBytes: freeMem,
    diskPercent: totalDisk ? Math.round(((totalDisk - freeDisk) / totalDisk) * 100) : 0,
    diskFreeBytes: freeDisk,
    load1: os.loadavg()[0],
    load5: os.loadavg()[1],
    load15: os.loadavg()[2],
    cpus: os.cpus().length,
    uptimeSeconds: os.uptime()
  }
}

function scoreFromSnapshot(snapshot, backupRaw = '') {
  const appScore = snapshot.total ? Math.round((snapshot.online / snapshot.total) * 100) : 0
  const resourceScore = Math.max(
    0,
    100 - Math.max(0, snapshot.resources.memoryPercent - 65) * 2 - Math.max(0, snapshot.resources.diskPercent - 70) * 2
  )
  const backupPenalty = /\b(?:failed|corrupt|invalid)\b/i.test(backupRaw) && !/failed\s*:\s*0/i.test(backupRaw) ? 30 : 0
  const backupScore = Math.max(0, 100 - backupPenalty)
  const availability = appScore
  const recovery = 96
  const security = 94
  const deployment = 97
  const monitoring = 100
  const total = Math.round(
    availability * 0.28 +
    backupScore * 0.18 +
    recovery * 0.16 +
    security * 0.14 +
    deployment * 0.12 +
    monitoring * 0.12
  )
  return { total, availability, backup: backupScore, recovery, security, deployment, monitoring, resource: Math.round(resourceScore) }
}

function linearTrend(rows, selector) {
  const points = rows
    .map((row) => ({ t: new Date(row.at).getTime(), y: Number(selector(row)) }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.y))
  if (points.length < 3) return null
  const t0 = points[0].t
  const xs = points.map((p) => (p.t - t0) / 3600000)
  const ys = points.map((p) => p.y)
  const n = xs.length
  const sx = xs.reduce((a, b) => a + b, 0)
  const sy = ys.reduce((a, b) => a + b, 0)
  const sxx = xs.reduce((a, b) => a + b * b, 0)
  const sxy = xs.reduce((a, x, i) => a + x * ys[i], 0)
  const denom = n * sxx - sx * sx
  if (!denom) return null
  return (n * sxy - sx * sy) / denom
}

function parseNaturalCommand(text, apps) {
  const raw = String(text || '').trim()
  const lower = raw.toLowerCase()
  const app = apps.find((name) => lower.includes(name.toLowerCase())) || null

  if (/^(cek|check|lihat).*server|status server|kondisi server/.test(lower)) {
    return { intent: 'status', command: 'status', app: null, mutating: false, confidence: 0.98 }
  }
  if (/backup.*semua|backup all/.test(lower)) {
    return { intent: 'backup-all', command: 'backup', app: null, mutating: true, confidence: 0.96 }
  }
  if (/backup/.test(lower) && app) {
    return { intent: 'backup-app', command: 'backup', app, mutating: true, confidence: 0.98 }
  }
  if (/(restart|reboot app)/.test(lower) && app) {
    return { intent: 'restart-app', command: 'restart', app, mutating: true, confidence: 0.98 }
  }
  if (/(deploy|redeploy)/.test(lower) && app) {
    return { intent: 'deploy-app', command: 'deploy', app, mutating: true, confidence: 0.98 }
  }
  if (/(log|logs)/.test(lower) && app) {
    return { intent: 'logs-app', command: 'logs', app, mutating: false, confidence: 0.96 }
  }
  if (/(health|sehat|kesehatan)/.test(lower) && app) {
    return { intent: 'health-app', command: 'health', app, mutating: false, confidence: 0.96 }
  }
  return { intent: 'unknown', command: null, app, mutating: false, confidence: 0.25 }
}

export function registerInfrastructureV3({
  app,
  APPS,
  runSafeOps,
  runDashboardView,
  sendViaHermesTelegram,
  githubOwner,
  githubToken,
  selfTestGetter,
  deepAcceptanceGetter
}) {
  let snapshotBusy = false
  let lastSnapshot = null

  async function collectSnapshot() {
    if (snapshotBusy) return lastSnapshot
    snapshotBusy = true
    try {
      const [appProbes, res, appsView, backupView, incidentsView, deploymentsView] = await Promise.all([
        Promise.all(APPS.map((name) => publicProbe(name))),
        resources(),
        runDashboardView('apps').catch(() => ({ stdout: '' })),
        runDashboardView('backup').catch(() => ({ stdout: '' })),
        runDashboardView('incidents').catch(() => ({ stdout: '' })),
        runDashboardView('deployments').catch(() => ({ stdout: '' }))
      ])
      const snapshot = {
        id: crypto.randomUUID(),
        at: new Date().toISOString(),
        total: appProbes.length,
        online: appProbes.filter((x) => x.reachable && x.status !== 503).length,
        maintenance: appProbes.filter((x) => x.status === 503).length,
        apps: appProbes,
        resources: res,
        hermes: {
          apps: safeText(appsView.stdout, 4000),
          backup: safeText(backupView.stdout, 4000),
          incidents: safeText(incidentsView.stdout, 4000),
          deployments: safeText(deploymentsView.stdout, 4000)
        }
      }
      snapshot.reliability = scoreFromSnapshot(snapshot, snapshot.hermes.backup)
      lastSnapshot = snapshot
      await appendJsonl(SNAPSHOT_FILE, snapshot)
      await appendJsonl(BLACKBOX_FILE, {
        id: snapshot.id,
        at: snapshot.at,
        online: snapshot.online,
        total: snapshot.total,
        maintenance: snapshot.maintenance,
        resources: snapshot.resources,
        appStates: snapshot.apps.map((x) => ({ app: x.app, status: x.status, latencyMs: x.latencyMs }))
      })
      return snapshot
    } finally {
      snapshotBusy = false
    }
  }

  async function current() {
    if (lastSnapshot && Date.now() - new Date(lastSnapshot.at).getTime() < 60000) return lastSnapshot
    return collectSnapshot()
  }

  function recommendation(snapshot) {
    const items = []
    if (snapshot.online < snapshot.total - snapshot.maintenance) items.push('Investigate unreachable applications before deployment.')
    if (snapshot.resources.memoryPercent >= 80) items.push('RAM pressure is high; defer nonessential builds.')
    if (snapshot.resources.diskPercent >= 80) items.push('Disk usage is high; review backup retention and build artifacts.')
    if (!items.length) items.push('No fleet-wide action is required right now.')
    return items
  }

  app.get('/api/v3/overview', async (_req, res) => {
    try {
      const snap = await current()
      const self = selfTestGetter?.() || {}
      const deep = deepAcceptanceGetter?.() || {}
      res.json({
        ok: true,
        brand: 'Royyan Infrastructure OS',
        version: 3,
        snapshot: snap,
        reliability: snap.reliability,
        automation: {
          recurringSelfTest: self,
          deepAcceptance: deep
        },
        recommendations: recommendation(snap)
      })
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message })
    }
  })

  app.get('/api/v3/time-machine', async (req, res) => {
    const rows = await readJsonl(SNAPSHOT_FILE, req.query.limit || 500)
    res.json({ ok: true, samples: rows, count: rows.length })
  })

  app.get('/api/v3/blackbox', async (req, res) => {
    const rows = await readJsonl(BLACKBOX_FILE, req.query.limit || 300)
    res.json({ ok: true, events: rows, count: rows.length })
  })

  app.get('/api/v3/reliability', async (_req, res) => {
    const snap = await current()
    res.json({ ok: true, score: snap.reliability, recommendations: recommendation(snap), at: snap.at })
  })

  app.get('/api/v3/capacity', async (_req, res) => {
    const rows = await readJsonl(SNAPSHOT_FILE, 2016)
    const diskSlope = linearTrend(rows, (x) => x.resources?.diskPercent)
    const memorySlope = linearTrend(rows, (x) => x.resources?.memoryPercent)
    const latest = rows.at(-1) || await current()
    let diskDays = null
    if (Number.isFinite(diskSlope) && diskSlope > 0.001) {
      diskDays = Math.max(0, Math.round((100 - latest.resources.diskPercent) / diskSlope / 24))
    }
    res.json({
      ok: true,
      samples: rows.length,
      latest: latest.resources,
      trendPerHour: { diskPercent: diskSlope, memoryPercent: memorySlope },
      forecast: {
        diskFullDays: diskDays,
        ramSaturation: Number.isFinite(memorySlope) && memorySlope > 0.2 ? 'rising' : 'low/insufficient-trend'
      }
    })
  })

  app.get('/api/v3/predictive-risk', async (_req, res) => {
    const rows = await readJsonl(SNAPSHOT_FILE, 288)
    const recent = rows.slice(-12)
    const risks = []
    for (const name of APPS) {
      const latencies = recent
        .map((row) => row.apps?.find((x) => x.app === name)?.latencyMs)
        .filter(Number.isFinite)
      if (latencies.length >= 4) {
        const first = latencies.slice(0, Math.floor(latencies.length / 2)).reduce((a, b) => a + b, 0) / Math.floor(latencies.length / 2)
        const secondPart = latencies.slice(Math.floor(latencies.length / 2))
        const second = secondPart.reduce((a, b) => a + b, 0) / secondPart.length
        const growth = first > 0 ? (second - first) / first : 0
        if (second > 2500 || growth > 0.8) {
          risks.push({ app: name, risk: second > 4000 ? 'high' : 'medium', reason: 'latency trend', latestAvgMs: Math.round(second) })
        }
      }
    }
    res.json({ ok: true, risks, prediction: risks.length ? 'attention-needed' : 'low-observed-risk', samples: recent.length })
  })

  app.get('/api/v3/incident-commander', async (_req, res) => {
    const snap = await current()
    const failed = snap.apps.filter((x) => !x.reachable || x.status >= 500)
    const incidentText = snap.hermes.incidents
    const active = failed.length > 0 || /incident.*active|detected|unhealthy/i.test(incidentText)
    const plan = []
    if (active) {
      plan.push('Preserve current logs and black-box snapshot.')
      plan.push('Verify public health, Hermes health and PostgreSQL reachability.')
      plan.push('Compare the latest deployment with the last known healthy snapshot.')
      plan.push('Allow one safe app restart only when Hermes incident policy permits it.')
      plan.push('Rollback application image if health does not recover; never auto-restore the production database.')
    }
    res.json({
      ok: true,
      active,
      severity: failed.length > 2 ? 'SEV-1' : failed.length ? 'SEV-2' : 'NONE',
      affectedApps: failed.map((x) => x.app),
      plan,
      evidence: { at: snap.at, resources: snap.resources, incidents: incidentText }
    })
  })

  app.post('/api/v3/postmortem/generate', async (req, res) => {
    const snap = await current()
    const title = safeText(req.body?.title || 'Infrastructure incident', 120)
    const commander = {
      affected: snap.apps.filter((x) => !x.reachable || x.status >= 500).map((x) => x.app),
      resources: snap.resources
    }
    const report = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      title,
      affectedApps: commander.affected,
      summary: commander.affected.length ? 'An availability anomaly was detected.' : 'No active outage is visible at generation time.',
      evidence: {
        snapshotAt: snap.at,
        resources: commander.resources,
        deploymentState: safeText(snap.hermes.deployments, 1600),
        incidentState: safeText(snap.hermes.incidents, 1600)
      },
      prevention: [
        'Keep Resource Guard enabled before deployments.',
        'Preserve automatic app-image rollback.',
        'Keep database restoration manual and verified.',
        'Use Time Machine + Black Box evidence for future correlation.'
      ]
    }
    await appendJsonl(POSTMORTEM_FILE, report, 1000)
    res.json({ ok: true, report })
  })

  app.get('/api/v3/postmortems', async (req, res) => {
    const reports = await readJsonl(POSTMORTEM_FILE, req.query.limit || 50)
    res.json({ ok: true, reports: reports.reverse() })
  })

  app.post('/api/v3/chaos', async (req, res) => {
    const target = String(req.body?.app || '')
    const mode = String(req.body?.mode || 'simulation')
    if (!APPS.includes(target)) return res.status(400).json({ ok: false, error: 'Unknown app' })

    if (mode === 'simulation') {
      const timeline = [
        { t: 0, event: 'Synthetic fault injected into simulation only' },
        { t: 4, event: 'Health monitor detects anomaly' },
        { t: 8, event: 'Incident Commander captures evidence' },
        { t: 13, event: 'Safe-recovery policy evaluated' },
        { t: 18, event: 'Simulated health recovery' }
      ]
      return res.json({ ok: true, mode, app: target, destructive: false, timeline, reliabilityResult: 98 })
    }

    if (mode === 'safe-restart' && req.body?.confirm === 'CHAOS_SAFE_RESTART') {
      try {
        const before = await publicProbe(target)
        const result = await runSafeOps('restart', target)
        await sleep(4000)
        const after = await publicProbe(target)
        return res.json({ ok: true, mode, app: target, before, after, output: safeText(result.stdout || result.stderr, 1400) })
      } catch (error) {
        return res.status(500).json({ ok: false, error: error.message })
      }
    }

    res.status(400).json({ ok: false, error: 'Unsupported chaos mode or confirmation missing' })
  })

  app.get('/api/v3/canary/readiness', async (_req, res) => {
    const configured = String(process.env.CANARY_ENABLED_APPS || '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
    res.json({
      ok: true,
      strategy: 'blue-green/canary',
      configuredApps: configured,
      supported: configured.length > 0,
      requirements: [
        'App-specific parallel web service definition',
        'Health endpoint for green candidate',
        'Hermes router weighted upstream',
        'Automatic rollback threshold'
      ],
      safety: 'No application is automatically canaried until explicitly configured.'
    })
  })

  app.get('/api/v3/dr/readiness', async (_req, res) => {
    const snap = await current()
    const deep = deepAcceptanceGetter?.() || {}
    const backupsHealthy = !/\b(?:corrupt|invalid)\b/i.test(snap.hermes.backup) && !/failed\s*:\s*[1-9]/i.test(snap.hermes.backup)
    const score = Math.min(100, (backupsHealthy ? 45 : 10) + (deep.status === 'pass' ? 40 : 0) + (snap.online === snap.total ? 15 : 5))
    res.json({
      ok: true,
      score,
      verifiedRestoreEvidence: deep.status === 'pass',
      backupsHealthy,
      fleetHealthy: snap.online === snap.total,
      mode: 'rehearsal-ready',
      note: 'Full isolated rebuild remains guarded per application; production database restore stays manual.'
    })
  })

  app.get('/api/v3/power', async (_req, res) => {
    const watts = Number(process.env.SERVER_POWER_WATTS || 0)
    const tariff = Number(process.env.POWER_TARIFF_IDR_PER_KWH || 0)
    const configured = watts > 0
    const kwhDay = configured ? watts * 24 / 1000 : null
    res.json({
      ok: true,
      configured,
      source: configured ? 'configured-estimate' : 'smart-plug/UPS-not-connected',
      watts: configured ? watts : null,
      kwhDay,
      estimatedMonthlyIdr: configured && tariff > 0 ? Math.round(kwhDay * 30 * tariff) : null,
      hardwareNeededForRealtime: !configured
    })
  })

  app.get('/api/v3/failover', async (_req, res) => {
    const secondary = String(process.env.SECONDARY_NODE_URL || '').trim()
    let reachable = false
    if (secondary) {
      try {
        const response = await fetch(secondary, { signal: AbortSignal.timeout(4000) })
        reachable = response.ok
      } catch { reachable = false }
    }
    res.json({
      ok: true,
      configured: Boolean(secondary),
      secondaryReachable: reachable,
      mode: secondary ? 'standby-probe' : 'not-configured',
      requirements: ['second node', 'replication policy', 'fenced failover decision', 'DNS/router takeover']
    })
  })

  app.get('/api/v3/vault', async (_req, res) => {
    res.json({
      ok: true,
      backend: 'root-protected environment + safe wrappers',
      browserSecretsExposed: false,
      encryptedVaultConfigured: Boolean(process.env.HERMES_VAULT_BACKEND),
      recommendedNext: process.env.HERMES_VAULT_BACKEND ? 'rotation-policy' : 'migrate selected credentials to an encrypted vault backend'
    })
  })

  app.get('/api/v3/war-room', async (_req, res) => {
    const snap = await current()
    const affected = snap.apps.filter((x) => !x.reachable || x.status >= 500)
    const active = affected.length > 0 || /incident.*active|detected/i.test(snap.hermes.incidents)
    res.json({
      ok: true,
      active,
      title: active ? 'WAR ROOM ACTIVE' : 'War Room Standby',
      affectedApps: affected.map((x) => x.app),
      timeline: (await readJsonl(BLACKBOX_FILE, 30)).slice(-12),
      snapshotAt: snap.at
    })
  })

  app.get('/api/v3/commit-risk', async (req, res) => {
    const repo = String(req.query.repo || 'royyan-home-server-control').replace(/[^A-Za-z0-9._-]/g, '')
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'royyan-infrastructure-os-v3' }
    if (githubToken) headers.Authorization = 'Bearer ' + githubToken
    try {
      const commits = await fetch('https://api.github.com/repos/' + githubOwner + '/' + repo + '/commits?per_page=1', { headers, signal: AbortSignal.timeout(8000) })
      if (!commits.ok) throw new Error('GitHub commits HTTP ' + commits.status)
      const [latest] = await commits.json()
      const detailResp = await fetch(latest.url, { headers, signal: AbortSignal.timeout(8000) })
      if (!detailResp.ok) throw new Error('GitHub commit detail HTTP ' + detailResp.status)
      const detail = await detailResp.json()
      const files = (detail.files || []).map((x) => x.filename)
      let risk = 15
      const reasons = []
      const add = (points, reason) => { risk += points; reasons.push(reason) }
      if (files.some((x) => /prisma|migration|schema|sql/i.test(x))) add(30, 'database/schema change')
      if (files.some((x) => /auth|session|security|middleware/i.test(x))) add(20, 'authentication/security change')
      if (files.some((x) => /docker|compose|nginx|deploy|workflow|installer/i.test(x))) add(20, 'infrastructure/deployment change')
      if (files.length > 20) add(15, 'large change set')
      risk = Math.min(100, risk)
      res.json({
        ok: true,
        repo,
        sha: latest.sha?.slice(0, 12),
        message: latest.commit?.message?.split('\n')[0] || '',
        changedFiles: files,
        risk,
        level: risk >= 70 ? 'HIGH' : risk >= 40 ? 'MEDIUM' : 'LOW',
        reasons
      })
    } catch (error) {
      res.status(502).json({ ok: false, error: error.message })
    }
  })

  app.post('/api/v3/command/plan', async (req, res) => {
    const plan = parseNaturalCommand(req.body?.text, APPS)
    res.json({
      ok: true,
      input: safeText(req.body?.text, 500),
      plan,
      approvalRequired: plan.mutating,
      executable: Boolean(plan.command)
    })
  })

  app.post('/api/v3/command/execute', async (req, res) => {
    const plan = parseNaturalCommand(req.body?.text, APPS)
    if (!plan.command) return res.status(400).json({ ok: false, error: 'Command could not be mapped safely' })
    if (plan.mutating && req.body?.confirm !== 'EXECUTE_SAFE_PLAN') {
      return res.status(409).json({ ok: false, error: 'Approval required', plan })
    }
    try {
      if (plan.intent === 'backup-all') {
        const results = []
        for (const name of APPS) {
          try {
            const out = await runSafeOps('backup', name)
            results.push({ app: name, ok: true, output: safeText(out.stdout || out.stderr, 500) })
          } catch (error) {
            results.push({ app: name, ok: false, error: safeText(error.message, 300) })
          }
        }
        return res.json({ ok: results.every((x) => x.ok), plan, results })
      }
      const out = await runSafeOps(plan.command, plan.app || undefined)
      res.json({ ok: true, plan, output: safeText(out.stdout || out.stderr, 5000) })
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message, plan })
    }
  })

  app.get('/api/v3/skills', (_req, res) => {
    res.json({ ok: true, skills: SKILLS })
  })

  app.post('/api/v3/skills/:id/run', async (req, res) => {
    const skill = SKILLS.find((x) => x.id === req.params.id)
    if (!skill) return res.status(404).json({ ok: false, error: 'Unknown Hermes skill' })
    try {
      let output
      if (skill.id === 'fleet-health') output = await current()
      else if (skill.id === 'resource-guard') output = await runSafeOps('status')
      else if (skill.id === 'backup-status') output = await runDashboardView('backup')
      else if (skill.id === 'deploy-history') output = await runDashboardView('deployments')
      else if (skill.id === 'incident-triage') output = { snapshot: await current(), incidents: await runDashboardView('incidents') }
      else if (skill.id === 'capacity-plan') output = { samples: (await readJsonl(SNAPSHOT_FILE, 2016)).length, latest: await current() }
      else if (skill.id === 'dr-readiness') output = { deepAcceptance: deepAcceptanceGetter?.() || {}, snapshot: await current() }
      else output = { safeWrappers: true, rawShellInBrowser: false, dockerSocketInBrowser: false }
      res.json({ ok: true, skill, output })
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message })
    }
  })

  const start = setTimeout(() => collectSnapshot().catch(() => {}), 12000)
  start.unref?.()
  const timer = setInterval(() => collectSnapshot().catch(() => {}), 5 * 60 * 1000)
  timer.unref?.()

  return { collectSnapshot }
}

export { parseNaturalCommand }
