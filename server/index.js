import 'dotenv/config'
import express from 'express'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { statfs } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const app = express()

const PORT = Number(process.env.PORT || 8787)
const HOST = process.env.HOST || '127.0.0.1'
const HERMES_OPS_BIN = process.env.HERMES_OPS_BIN || '/usr/local/bin/hermes-ops-safe'
const APPS = (process.env.HERMES_APPS || 'portfolio,opspilot,bantuai,niagabot,sajiin')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)

const GITHUB_OWNER = process.env.GITHUB_OWNER || 'MaulanaRoyyanTsubaisa'
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main'

const allowedCommands = new Map([
  ['status', { appRequired: false }],
  ['health', { appRequired: false }],
  ['logs', { appRequired: true }],
  ['restart', { appRequired: true }],
  ['backup', { appRequired: false }],
  ['deploy', { appRequired: true }],
  ['timers', { appRequired: false }]
])

const telegramMessages = []
const activity = []

app.disable('x-powered-by')
app.use(express.json({ limit: '32kb' }))

function remember(type, message, meta = {}) {
  activity.unshift({
    id: crypto.randomUUID(),
    type,
    message,
    meta,
    at: new Date().toISOString()
  })
  activity.splice(50)
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
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
    }
  })

  return {
    stdout: stdout?.trim() || '',
    stderr: stderr?.trim() || ''
  }
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'royyan-home-server-control',
    at: new Date().toISOString()
  })
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
      configured: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
      webhookConfigured: Boolean(process.env.TELEGRAM_WEBHOOK_SECRET)
    }
  })
})

app.get('/api/activity', (_req, res) => {
  res.json({ activity })
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
      'https://api.github.com/users/' + encodeURIComponent(GITHUB_OWNER) + '/repos?per_page=100&sort=updated',
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

app.get('/api/telegram/messages', (_req, res) => {
  res.json({ messages: telegramMessages })
})

app.post('/api/telegram/webhook', (req, res) => {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET
  const received = req.get('X-Telegram-Bot-Api-Secret-Token')

  if (expected && received !== expected) {
    return res.status(403).json({ ok: false })
  }

  const message = req.body?.message || req.body?.edited_message
  if (message?.text) {
    telegramMessages.unshift({
      id: message.message_id,
      chatId: message.chat?.id || null,
      from: message.from?.username || message.from?.first_name || 'Telegram',
      text: message.text,
      at: message.date ? new Date(message.date * 1000).toISOString() : new Date().toISOString()
    })
    telegramMessages.splice(30)
    remember('telegram', 'Incoming Telegram message')
  }

  res.json({ ok: true })
})

app.post('/api/telegram/send', async (req, res) => {
  const token = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID
  const text = String(req.body?.text || '').trim().slice(0, 1000)

  if (!token || !chatId) {
    return res.status(503).json({ ok: false, error: 'Telegram is not configured' })
  }

  if (!text) {
    return res.status(400).json({ ok: false, error: 'Message is empty' })
  }

  try {
    const response = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text })
    })

    const payload = await response.json()
    if (!response.ok || !payload.ok) {
      throw new Error(payload?.description || 'Telegram API failed')
    }

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

app.listen(PORT, HOST, () => {
  console.log('Royyan Home Server Control listening on http://' + HOST + ':' + PORT)
})
