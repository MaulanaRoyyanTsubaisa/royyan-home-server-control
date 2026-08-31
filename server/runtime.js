import 'dotenv/config'
import express from 'express'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { statfs } from 'node:fs/promises'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { registerControlPlaneV2 } from './controlPlaneV2.js'
import {
  getDetailedSelfTestState,
  getPublicSelfTestState,
  scheduleProductionSelfTest
} from './productionSelfTest.js'
import {
  getDetailedDeepAcceptanceState,
  getPublicDeepAcceptanceState,
  scheduleDeepProductionAcceptance
} from './deepProductionAcceptance.js'
import { getInfrastructureV3PublicState, registerInfrastructureV3 } from './infrastructureV3.js'
import {
  getV3SelfTestDetailedState,
  getV3SelfTestPublicState,
  scheduleV3Tests
} from './infrastructureV3SelfTest.js'
import {
  getGitOpsBridgePublicState,
  registerGitOpsBridge
} from './gitOpsBridge.js'
import {
  getControlReconcilerState,
  scheduleControlReconciler
} from './controlReconciler.js'

const execFileAsync = promisify(execFile)
const app = express()

const PORT = Number(process.env.PORT || 8787)
const HOST = process.env.HOST || '127.0.0.1'
const HERMES_OPS_BIN = process.env.HERMES_OPS_BIN || '/usr/local/bin/hermes-ops-safe'
const HERMES_DASHBOARD_BIN = process.env.HERMES_DASHBOARD_BIN || '/usr/local/bin/hermes-dashboard-safe'
const HERMES_TELEGRAM_SEND_BIN =
  process.env.HERMES_TELEGRAM_SEND_BIN || '/usr/local/bin/hermes-telegram-send-safe'

const APPS = (
  process.env.HERMES_APPS ||
  'portfolio,opspilot,bantuai,niagabot,sajiin,kontenin,lamarin,learnwithroyyan,rumahin,tagihin,janjiin'
)
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)

const GITHUB_OWNER = process.env.GITHUB_OWNER || 'MaulanaRoyyanTsubaisa'
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main'
const CONTROL_ADMIN_PASSWORD = process.env.CONTROL_ADMIN_PASSWORD || ''
const CONTROL_SESSION_SECRET = process.env.CONTROL_SESSION_SECRET || ''
const SESSION_TTL_MS = 12 * 60 * 60 * 1000

const allowedCommands = new Map([
  ['status', { appRequired: false }],
  ['health', { appRequired: false }],
  ['logs', { appRequired: true }],
  ['restart', { appRequired: true }],
  ['backup', { appRequired: true }],
  ['deploy', { appRequired: true }],
  ['timers', { appRequired: false }]
])

const allowedDashboardViews = new Set([
  'status',
  'apps',
  'backup',
  'deployments',
  'incidents',
  'help'
])

const telegramCommandViews = new Map([
  ['/server', 'status'],
  ['/home', 'status'],
  ['/apps', 'apps'],
  ['/backup', 'backup'],
  ['/deployments', 'deployments'],
  ['/incidents', 'incidents'],
  ['/serverhelp', 'help']
])

const activity = []
const loginAttempts = new Map()

app.disable('x-powered-by')
app.set('trust proxy', 'loopback')
app.use(express.json({ limit: '32kb' }))

function remember(type, message, meta = {}) {
  activity.unshift({
    id: crypto.randomUUID(),
    type,
    message,
    meta,
    at: new Date().toISOString()
  })
  activity.splice(80)
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left))
  const b = Buffer.from(String(right))
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

function signSession(expiresAt) {
  const payload = String(expiresAt)
  const signature = crypto
    .createHmac('sha256', CONTROL_SESSION_SECRET)
    .update(payload)
    .digest('hex')
  return payload + '.' + signature
}

function verifySession(value) {
  if (!CONTROL_SESSION_SECRET || !value) return false
  const [expiresRaw, signature] = String(value).split('.')
  const expiresAt = Number(expiresRaw)
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() || !signature) return false

  const expected = crypto
    .createHmac('sha256', CONTROL_SESSION_SECRET)
    .update(expiresRaw)
    .digest('hex')

  return safeEqual(signature, expected)
}

function getCookie(req, name) {
  const raw = req.headers.cookie || ''
  for (const part of raw.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return decodeURIComponent(rest.join('='))
  }
  return ''
}

function sessionCookie(req, value, maxAgeSeconds) {
  const secure =
    req.secure ||
    String(req.get('x-forwarded-proto') || '')
      .split(',')[0]
      .trim() === 'https'

  const parts = [
    'control_session=' + encodeURIComponent(value),
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=' + maxAgeSeconds
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

function isLoginBlocked(ip) {
  const entry = loginAttempts.get(ip)
  if (!entry) return false
  if (Date.now() - entry.first > 15 * 60 * 1000) {
    loginAttempts.delete(ip)
    return false
  }
  return entry.count >= 5
}

function recordLoginFailure(ip) {
  const now = Date.now()
  const entry = loginAttempts.get(ip)
  if (!entry || now - entry.first > 15 * 60 * 1000) {
    loginAttempts.set(ip, { first: now, count: 1 })
  } else {
    entry.count += 1
  }
}

function cpuSnapshot() {
  const cpus = os.cpus()
  return cpus.reduce(
    (acc, cpu) => {
      const times = cpu.times
      const total = times.user + times.nice + times.sys + times.idle + times.irq
      acc.total += total
      acc.idle += times.idle
      return acc
    },
    { total: 0, idle: 0 }
  )
}

async function getCpuUsage() {
  const first = cpuSnapshot()
  await new Promise((resolve) => setTimeout(resolve, 180))
  const second = cpuSnapshot()

  const total = second.total - first.total
  const idle = second.idle - first.idle
  if (total <= 0) return 0

  return Math.max(0, Math.min(100, Math.round((1 - idle / total) * 100)))
}

async function getDisk() {
  try {
    const info = await statfs('/')
    const blockSize = Number(info.bsize)
    const total = Number(info.blocks) * blockSize
    const free = Number(info.bavail) * blockSize
    return {
      total,
      free,
      used: Math.max(0, total - free),
      percent: total ? Math.round(((total - free) / total) * 100) : 0
    }
  } catch {
    return { total: 0, free: 0, used: 0, percent: 0 }
  }
}

async function runSafeOps(command, targetApp) {
  const rule = allowedCommands.get(command)
  if (!rule) {
    const error = new Error('Command is not allowed')
    error.status = 400
    throw error
  }

  if (rule.appRequired && !targetApp) {
    const error = new Error('This command requires an app')
    error.status = 400
    throw error
  }

  if (targetApp && !APPS.includes(targetApp)) {
    const error = new Error('Unknown app')
    error.status = 400
    throw error
  }

  const args = [command]
  if (targetApp) args.push(targetApp)

  const { stdout, stderr } = await execFileAsync(HERMES_OPS_BIN, args, {
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      PATH:
        process.env.PATH ||
        '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
    }
  })

  return {
    stdout: stdout?.trim() || '',
    stderr: stderr?.trim() || ''
  }
}

async function runDashboardView(view) {
  if (!allowedDashboardViews.has(view)) {
    const error = new Error('Dashboard view is not allowed')
    error.status = 400
    throw error
  }

  const { stdout, stderr } = await execFileAsync(HERMES_DASHBOARD_BIN, [view], {
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      PATH:
        process.env.PATH ||
        '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
    }
  })

  return {
    stdout: stdout?.trim() || '',
    stderr: stderr?.trim() || ''
  }
}

function sendViaHermesTelegram(text) {
  return new Promise((resolve, reject) => {
    const child = spawn(HERMES_TELEGRAM_SEND_BIN, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH:
          process.env.PATH ||
          '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
      }
    })

    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('Telegram sender timed out'))
    }, 20_000)

    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(stdout.trim())
      else reject(new Error(stderr.trim() || 'Hermes Telegram sender failed'))
    })

    child.stdin.end(text)
  })
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'royyan-home-server-control',
    phase: 'ready',
    authConfigured: Boolean(CONTROL_ADMIN_PASSWORD && CONTROL_SESSION_SECRET),
    selfTest: getPublicSelfTestState(),
    deepAcceptance: getPublicDeepAcceptanceState(),
    gitOpsBridge: getGitOpsBridgePublicState(),
    infrastructureV3: getInfrastructureV3PublicState(),
    v3Validation: getV3SelfTestPublicState(),
    controlReconciler: getControlReconcilerState(),
    at: new Date().toISOString()
  })
})

app.get('/api/auth/status', (req, res) => {
  const authenticated = verifySession(getCookie(req, 'control_session'))
  res.json({
    configured: Boolean(CONTROL_ADMIN_PASSWORD && CONTROL_SESSION_SECRET),
    authenticated
  })
})

app.post('/api/auth/login', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown'

  if (!CONTROL_ADMIN_PASSWORD || !CONTROL_SESSION_SECRET) {
    return res.status(503).json({
      ok: false,
      error: 'Dashboard authentication is not configured'
    })
  }

  if (isLoginBlocked(ip)) {
    return res.status(429).json({
      ok: false,
      error: 'Too many login attempts. Try again later.'
    })
  }

  const password = String(req.body?.password || '')
  if (!safeEqual(password, CONTROL_ADMIN_PASSWORD)) {
    recordLoginFailure(ip)
    return res.status(401).json({ ok: false, error: 'Invalid password' })
  }

  loginAttempts.delete(ip)
  const expiresAt = Date.now() + SESSION_TTL_MS
  res.setHeader(
    'Set-Cookie',
    sessionCookie(req, signSession(expiresAt), Math.floor(SESSION_TTL_MS / 1000))
  )
  remember('auth', 'Dashboard login')
  res.json({ ok: true, expiresAt })
})

app.post('/api/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', sessionCookie(req, '', 0))
  res.json({ ok: true })
})

app.use('/api', (req, res, next) => {
  if (req.path === '/health' || req.path.startsWith('/auth/')) return next()
  if (!verifySession(getCookie(req, 'control_session'))) {
    return res.status(401).json({ ok: false, error: 'Authentication required' })
  }
  next()
})

registerInfrastructureV3({
  app,
  APPS,
  runSafeOps,
  runDashboardView,
  sendViaHermesTelegram,
  githubOwner: GITHUB_OWNER,
  githubToken: process.env.GITHUB_TOKEN || '',
  selfTestGetter: getDetailedSelfTestState,
  deepAcceptanceGetter: getDetailedDeepAcceptanceState
})

registerGitOpsBridge({
  APPS,
  runSafeOps,
  runDashboardView,
  sendViaHermesTelegram
})

app.get('/api/selftest', (_req, res) => {
  res.json({ ok: true, ...getDetailedSelfTestState() })
})

app.get('/api/deep-acceptance', (_req, res) => {
  res.json({ ok: true, ...getDetailedDeepAcceptanceState() })
})

app.get('/api/v3-validation', (_req, res) => {
  res.json({ ok: true, ...getV3SelfTestDetailedState() })
})

registerControlPlaneV2({
  app,
  APPS,
  runSafeOps,
  runDashboardView,
  remember,
  sendViaHermesTelegram,
  HERMES_OPS_BIN,
  authConfigured: Boolean(CONTROL_ADMIN_PASSWORD && CONTROL_SESSION_SECRET)
})

app.get('/api/overview', async (_req, res) => {
  const [cpuPercent, disk] = await Promise.all([getCpuUsage(), getDisk()])
  const totalMem = os.totalmem()
  const freeMem = os.freemem()
  const usedMem = Math.max(0, totalMem - freeMem)

  res.json({
    cpu: {
      percent: cpuPercent,
      cores: os.cpus().length,
      model: os.cpus()[0]?.model || 'Unknown CPU'
    },
    memory: {
      total: totalMem,
      free: freeMem,
      used: usedMem,
      percent: totalMem ? Math.round((usedMem / totalMem) * 100) : 0
    },
    disk,
    system: {
      hostname: os.hostname(),
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      uptimeSeconds: os.uptime(),
      loadAverage: os.loadavg(),
      node: process.version
    },
    at: new Date().toISOString()
  })
})

app.get('/api/config', (_req, res) => {
  res.json({
    apps: APPS,
    safeCommands: [...allowedCommands.keys()],
    github: {
      owner: GITHUB_OWNER,
      branch: GITHUB_BRANCH
    },
    telegram: {
      mode: existsSync(HERMES_TELEGRAM_SEND_BIN)
        ? 'hermes-safe-sender'
        : 'unavailable',
      configured: existsSync(HERMES_TELEGRAM_SEND_BIN)
    },
    hermes: {
      dashboardSafe: existsSync(HERMES_DASHBOARD_BIN),
      opsSafe: existsSync(HERMES_OPS_BIN)
    }
  })
})

app.get('/api/activity', (_req, res) => {
  res.json({ activity })
})

app.get('/api/hermes/:view', async (req, res) => {
  try {
    const result = await runDashboardView(String(req.params.view || ''))
    res.json({ ok: true, view: req.params.view, ...result })
  } catch (error) {
    res.status(error.status || 500).json({
      ok: false,
      error: error.message || 'Hermes dashboard command failed'
    })
  }
})

app.post('/api/actions', async (req, res) => {
  const command = String(req.body?.command || '').trim()
  const targetApp = req.body?.app ? String(req.body.app).trim() : undefined

  try {
    const result = await runSafeOps(command, targetApp)
    remember('operation', command + (targetApp ? ' · ' + targetApp : ''), {
      ok: true
    })
    res.json({ ok: true, command, app: targetApp || null, ...result })
  } catch (error) {
    remember('operation', command + (targetApp ? ' · ' + targetApp : ''), {
      ok: false,
      error: error.message
    })
    res.status(error.status || 500).json({
      ok: false,
      error: error.message || 'Operation failed'
    })
  }
})

app.get('/api/github', async (_req, res) => {
  try {
    const headers = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'royyan-home-server-control'
    }

    if (process.env.GITHUB_TOKEN) {
      headers.Authorization = 'Bearer ' + process.env.GITHUB_TOKEN
    }

    const response = await fetch(
      'https://api.github.com/users/' +
        encodeURIComponent(GITHUB_OWNER) +
        '/repos?per_page=100&sort=updated',
      { headers }
    )

    if (!response.ok) {
      throw new Error('GitHub API returned ' + response.status)
    }

    const repos = await response.json()
    res.json({
      ok: true,
      owner: GITHUB_OWNER,
      branch: GITHUB_BRANCH,
      repositories: repos.slice(0, 12).map((repo) => ({
        name: repo.name,
        private: repo.private,
        url: repo.html_url,
        updatedAt: repo.updated_at,
        defaultBranch: repo.default_branch
      }))
    })
  } catch (error) {
    res.status(502).json({ ok: false, error: error.message })
  }
})

app.post('/api/telegram/command', async (req, res) => {
  const raw = String(req.body?.command || '').trim()
  const command = raw.split(/\s+/)[0]?.toLowerCase() || ''
  const view = telegramCommandViews.get(command)

  if (!view) {
    return res.status(400).json({
      ok: false,
      error: 'Unsupported Hermes Telegram command',
      allowed: [...telegramCommandViews.keys()]
    })
  }

  try {
    const result = await runDashboardView(view)
    remember('telegram-command', 'Web ran ' + command + ' through Hermes dashboard helper')
    res.json({ ok: true, command, view, ...result })
  } catch (error) {
    res.status(error.status || 500).json({
      ok: false,
      error: error.message || 'Hermes command failed'
    })
  }
})

app.post('/api/telegram/send', async (req, res) => {
  const text = String(req.body?.text || '').trim().slice(0, 1000)

  if (!text) {
    return res.status(400).json({ ok: false, error: 'Message is empty' })
  }

  if (!existsSync(HERMES_TELEGRAM_SEND_BIN)) {
    return res.status(503).json({
      ok: false,
      error: 'Hermes Telegram safe sender is not installed'
    })
  }

  try {
    await sendViaHermesTelegram(text)
    remember('telegram', 'Web dashboard sent a Telegram message')
    res.json({ ok: true })
  } catch (error) {
    res.status(502).json({ ok: false, error: error.message })
  }
})

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dist = path.resolve(__dirname, '../dist')

app.use(express.static(dist))
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next()
  res.sendFile(path.join(dist, 'index.html'), (error) => {
    if (error) next()
  })
})

export function startRuntime() {
  return new Promise((resolve, reject) => {
    const server = app.listen(PORT, HOST, () => {
      console.log('Royyan Home Server Control listening on http://' + HOST + ':' + PORT)
      scheduleProductionSelfTest({
        port: PORT,
        password: CONTROL_ADMIN_PASSWORD
      })
      scheduleDeepProductionAcceptance({
        port: PORT,
        password: CONTROL_ADMIN_PASSWORD
      })
      scheduleControlReconciler()
      scheduleV3Tests({
        port: PORT,
        password: CONTROL_ADMIN_PASSWORD
      })
      resolve(server)
    })
    server.on('error', reject)
  })
}
