import { useEffect, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  AppWindow,
  Archive,
  Bot,
  Boxes,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  CloudCog,
  Code2,
  Cpu,
  DatabaseBackup,
  Github,
  HardDrive,
  HeartPulse,
  KeyRound,
  LayoutDashboard,
  MemoryStick,
  LogOut,
  MessageCircle,
  Play,
  RefreshCw,
  Rocket,
  RotateCcw,
  Server,
  ShieldCheck,
  Terminal,
  TimerReset,
  Zap
} from 'lucide-react'
import MissionControl from './MissionControl.jsx'
import InfrastructureOS from './InfrastructureOS.jsx'

const navItems = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'mission', label: 'Mission Control', icon: Zap },
  { id: 'infra', label: 'Infrastructure OS', icon: CloudCog },
  { id: 'apps', label: 'Apps', icon: AppWindow },
  { id: 'deployments', label: 'Deployments', icon: Rocket },
  { id: 'backups', label: 'Backups', icon: DatabaseBackup },
  { id: 'incidents', label: 'Incidents', icon: AlertTriangle },
  { id: 'github', label: 'GitHub', icon: Github },
  { id: 'telegram', label: 'Telegram', icon: MessageCircle },
  { id: 'system', label: 'System', icon: Server }
]

async function api(path, options) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options?.headers || {}) },
    ...options
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(payload.error || 'Request failed')
    error.status = response.status
    throw error
  }
  return payload
}

function formatBytes(value = 0) {
  if (!value) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let number = value
  let index = 0
  while (number >= 1024 && index < units.length - 1) {
    number /= 1024
    index += 1
  }
  return number.toFixed(index > 2 ? 2 : 1) + ' ' + units[index]
}

function formatUptime(seconds = 0) {
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days) return days + 'd ' + hours + 'h'
  if (hours) return hours + 'h ' + minutes + 'm'
  return minutes + 'm'
}

function timeAgo(value) {
  if (!value) return '—'
  const ms = Date.now() - new Date(value).getTime()
  const minutes = Math.max(0, Math.round(ms / 60000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return minutes + 'm ago'
  const hours = Math.round(minutes / 60)
  if (hours < 24) return hours + 'h ago'
  return Math.round(hours / 24) + 'd ago'
}

function Panel({ title, eyebrow, action, children, className = '' }) {
  return (
    <section className={'panel ' + className}>
      <div className="panel-head">
        <div>
          {eyebrow && <span className="eyebrow">{eyebrow}</span>}
          <h2>{title}</h2>
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

function Metric({ icon: Icon, label, value, sub, percent }) {
  const safe = Math.max(0, Math.min(100, Number(percent || 0)))
  return (
    <article className="metric-card">
      <div className="metric-top">
        <span className="icon-box"><Icon size={18} /></span>
        <span className="metric-label">{label}</span>
      </div>
      <div className="metric-value">{value}</div>
      <div className="metric-sub">{sub}</div>
      <div className="meter"><span style={{ width: safe + '%' }} /></div>
    </article>
  )
}

function StatusPill({ online = true, children }) {
  return (
    <span className={'status-pill ' + (online ? 'ok' : 'warn')}>
      <span className="status-dot" />
      {children}
    </span>
  )
}

function LoginScreen({ configured, onAuthenticated }) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (event) => {
    event.preventDefault()
    if (!password) return
    setBusy(true)
    setError('')
    try {
      await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ password })
      })
      setPassword('')
      onAuthenticated()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-shell">
      <div className="login-card">
        <div className="brand-mark login-mark"><CloudCog size={27} /></div>
        <span className="eyebrow">ROYyan HOME INFRASTRUCTURE</span>
        <h1>Server Control</h1>
        <p>
          Protected control plane for Hermes, deployments, backups, GitHub,
          Telegram and server health.
        </p>

        {!configured ? (
          <div className="alert login-alert">
            <AlertTriangle size={17} />
            Authentication has not been configured on the server yet.
          </div>
        ) : (
          <form className="login-form" onSubmit={submit}>
            <label>
              <span>Admin password</span>
              <div className="password-field">
                <KeyRound size={17} />
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="current-password"
                  autoFocus
                  placeholder="Enter control password"
                />
              </div>
            </label>
            {error && <div className="login-error">{error}</div>}
            <button className="primary-btn full" disabled={busy || !password}>
              <ShieldCheck size={17} />
              {busy ? 'Authenticating…' : 'Open control panel'}
            </button>
          </form>
        )}

        <div className="login-foot">
          <ShieldCheck size={14} />
          No raw shell is exposed to the browser.
        </div>
      </div>
    </div>
  )
}

function AppCard({ name, onAction, busy }) {
  return (
    <article className="app-card">
      <div className="app-card-main">
        <span className="app-symbol"><Boxes size={18} /></span>
        <div>
          <strong>{name}</strong>
          <div className="app-meta">Managed by Hermes safe ops</div>
        </div>
      </div>
      <div className="app-card-actions">
        <button className="ghost-btn" disabled={busy} onClick={() => onAction('logs', name)}>
          <Terminal size={15} /> Logs
        </button>
        <button className="ghost-btn" disabled={busy} onClick={() => onAction('restart', name)}>
          <RotateCcw size={15} /> Restart
        </button>
        <button className="ghost-btn" disabled={busy} onClick={() => onAction('backup', name)}>
          <DatabaseBackup size={15} /> Backup
        </button>
        <button className="primary-btn compact" disabled={busy} onClick={() => onAction('deploy', name)}>
          <Rocket size={15} /> Deploy
        </button>
      </div>
    </article>
  )
}

export default function App() {
  const [auth, setAuth] = useState({ checked: false, configured: false, authenticated: false })
  const [active, setActive] = useState('overview')
  const [overview, setOverview] = useState(null)
  const [config, setConfig] = useState(null)
  const [online, setOnline] = useState(false)
  const [busy, setBusy] = useState('')
  const [consoleOutput, setConsoleOutput] = useState('Ready. No raw shell is exposed to the browser.')
  const [activity, setActivity] = useState([])
  const [github, setGithub] = useState(null)
  const [hermesStatus, setHermesStatus] = useState('')
  const [telegramText, setTelegramText] = useState('')
  const [telegramCommand, setTelegramCommand] = useState('/server')
  const [telegramCommandOutput, setTelegramCommandOutput] = useState('Run a Hermes command from the web without impersonating your Telegram account.')
  const [error, setError] = useState('')

  const checkAuth = async () => {
    try {
      const status = await api('/api/auth/status')
      setAuth({
        checked: true,
        configured: Boolean(status.configured),
        authenticated: Boolean(status.authenticated)
      })
    } catch {
      setAuth({ checked: true, configured: false, authenticated: false })
    }
  }

  useEffect(() => {
    checkAuth()
  }, [])

  const refreshCore = async () => {
    try {
      const [health, metrics, settings, recent] = await Promise.all([
        api('/api/health'),
        api('/api/overview'),
        api('/api/config'),
        api('/api/activity')
      ])
      setOnline(Boolean(health.ok))
      setOverview(metrics)
      setConfig(settings)
      setActivity(recent.activity || [])
      setError('')
    } catch (err) {
      setOnline(false)
      setError(err.message)
    }
  }

  useEffect(() => {
    if (!auth.authenticated) return
    refreshCore()
    const timer = setInterval(refreshCore, 5000)
    return () => clearInterval(timer)
  }, [auth.authenticated])

  useEffect(() => {
    if (!auth.authenticated || active !== 'github') return
    api('/api/github').then(setGithub).catch((err) => setGithub({ ok: false, error: err.message }))
  }, [active, auth.authenticated])

  useEffect(() => {
    if (!auth.authenticated || active !== 'telegram') return
    const load = () =>
      api('/api/hermes/status')
        .then((data) => setHermesStatus(data.stdout || data.stderr || 'Hermes status unavailable.'))
        .catch((err) => setHermesStatus('ERROR: ' + err.message))
    load()
    const timer = setInterval(load, 10000)
    return () => clearInterval(timer)
  }, [active, auth.authenticated])

  const runAction = async (command, appName) => {
    const key = command + ':' + (appName || '')
    setBusy(key)
    setConsoleOutput('Running ' + command + (appName ? ' on ' + appName : '') + '…')
    try {
      const result = await api('/api/actions', {
        method: 'POST',
        body: JSON.stringify({ command, app: appName })
      })
      setConsoleOutput(result.stdout || result.stderr || 'Operation completed successfully.')
      await refreshCore()
    } catch (err) {
      setConsoleOutput('ERROR: ' + err.message)
    } finally {
      setBusy('')
    }
  }

  const runTelegramCommand = async (event, explicitCommand) => {
    event?.preventDefault?.()
    const command = String(explicitCommand || telegramCommand).trim()
    if (!command) return

    setBusy('telegram-command')
    setTelegramCommand(command)
    setTelegramCommandOutput('Running ' + command + ' through Hermes…')
    try {
      const result = await api('/api/telegram/command', {
        method: 'POST',
        body: JSON.stringify({ command })
      })
      setTelegramCommandOutput(result.stdout || result.stderr || 'Command completed.')
      await refreshCore()
    } catch (err) {
      setTelegramCommandOutput('ERROR: ' + err.message)
    } finally {
      setBusy('')
    }
  }

  const sendTelegram = async (event) => {
    event.preventDefault()
    if (!telegramText.trim()) return
    setBusy('telegram')
    try {
      await api('/api/telegram/send', {
        method: 'POST',
        body: JSON.stringify({ text: telegramText })
      })
      setTelegramText('')
      setConsoleOutput('Telegram message sent.')
    } catch (err) {
      setConsoleOutput('ERROR: ' + err.message)
    } finally {
      setBusy('')
    }
  }

  const logout = async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' })
    } finally {
      setAuth((current) => ({ ...current, authenticated: false }))
    }
  }

  if (!auth.checked) {
    return (
      <div className="login-shell">
        <div className="login-card loading-card">
          <RefreshCw className="spin" size={24} />
          <span>Checking control-plane session…</span>
        </div>
      </div>
    )
  }

  if (!auth.authenticated) {
    return (
      <LoginScreen
        configured={auth.configured}
        onAuthenticated={() =>
          setAuth((current) => ({ ...current, authenticated: true }))
        }
      />
    )
  }

  const serverName = overview?.system?.hostname || 'home-server'
  const currentTitle = navItems.find((item) => item.id === active)?.label || 'Overview'

  const load = overview?.system?.loadAverage?.[0]
  const loadText = Number.isFinite(load) ? load.toFixed(2) : '—'

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><CloudCog size={24} /></div>
          <div>
            <strong>Royyan</strong>
            <span>Server Control</span>
          </div>
        </div>

        <nav className="nav-list">
          {navItems.map((item) => {
            const Icon = item.icon
            return (
              <button
                key={item.id}
                className={'nav-item ' + (active === item.id ? 'active' : '')}
                onClick={() => setActive(item.id)}
              >
                <Icon size={18} />
                <span>{item.label}</span>
              </button>
            )
          })}
        </nav>

        <div className="sidebar-foot">
          <StatusPill online={online}>{online ? 'Server online' : 'Server offline'}</StatusPill>
          <span className="tiny">{serverName}</span>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <span className="eyebrow">HOME INFRASTRUCTURE</span>
            <h1>{currentTitle}</h1>
          </div>
          <div className="top-actions">
            <StatusPill online={online}>{online ? 'Connected' : 'Disconnected'}</StatusPill>
            <button className="icon-btn" onClick={refreshCore} aria-label="Refresh">
              <RefreshCw size={17} />
            </button>
            <button className="icon-btn" onClick={logout} aria-label="Log out">
              <LogOut size={17} />
            </button>
          </div>
        </header>

        {error && (
          <div className="alert">
            <AlertTriangle size={17} />
            Dashboard API unavailable: {error}
          </div>
        )}

        {active === 'overview' && (
          <>
            <section className="hero">
              <div>
                <span className="eyebrow">CONTROL PLANE</span>
                <h2>Everything important, without SSH gymnastics.</h2>
                <p>Monitor the machine, operate known apps, trigger safe actions, and keep GitHub + Telegram in one place.</p>
              </div>
              <div className="hero-actions">
                <button className="primary-btn" disabled={busy} onClick={() => runAction('health')}>
                  <HeartPulse size={17} /> Health check
                </button>
                <button className="secondary-btn" disabled={busy} onClick={() => setActive('backups')}>
                  <Archive size={17} /> Backup center
                </button>
              </div>
            </section>

            <section className="metrics-grid">
              <Metric
                icon={Cpu}
                label="CPU"
                value={(overview?.cpu?.percent ?? 0) + '%'}
                sub={(overview?.cpu?.cores ?? 0) + ' logical cores'}
                percent={overview?.cpu?.percent}
              />
              <Metric
                icon={MemoryStick}
                label="Memory"
                value={(overview?.memory?.percent ?? 0) + '%'}
                sub={formatBytes(overview?.memory?.used) + ' / ' + formatBytes(overview?.memory?.total)}
                percent={overview?.memory?.percent}
              />
              <Metric
                icon={HardDrive}
                label="Disk"
                value={(overview?.disk?.percent ?? 0) + '%'}
                sub={formatBytes(overview?.disk?.used) + ' / ' + formatBytes(overview?.disk?.total)}
                percent={overview?.disk?.percent}
              />
              <Metric
                icon={Activity}
                label="Load"
                value={loadText}
                sub={'Uptime ' + formatUptime(overview?.system?.uptimeSeconds)}
                percent={Math.min(100, Number(loadText || 0) * 10)}
              />
            </section>

            <div className="two-col">
              <Panel
                title="Applications"
                eyebrow={(config?.apps?.length || 0) + ' configured'}
                action={<button className="text-btn" onClick={() => setActive('apps')}>Manage <ChevronRight size={15} /></button>}
              >
                <div className="mini-apps">
                  {(config?.apps || []).slice(0, 5).map((name) => (
                    <div className="mini-app-row" key={name}>
                      <span className="app-symbol small"><Boxes size={14} /></span>
                      <div>
                        <strong>{name}</strong>
                        <span>Safe ops enabled</span>
                      </div>
                      <CheckCircle2 size={17} className="ok-icon" />
                    </div>
                  ))}
                </div>
              </Panel>

              <Panel title="Quick operations" eyebrow="ALLOWLIST ONLY">
                <div className="quick-grid">
                  <button onClick={() => runAction('status')} disabled={busy}>
                    <CircleDot size={18} />
                    <span>Status</span>
                  </button>
                  <button onClick={() => runAction('health')} disabled={busy}>
                    <ShieldCheck size={18} />
                    <span>Health</span>
                  </button>
                  <button onClick={() => runAction('timers')} disabled={busy}>
                    <TimerReset size={18} />
                    <span>Timers</span>
                  </button>
                  <button onClick={() => setActive('backups')} disabled={busy}>
                    <DatabaseBackup size={18} />
                    <span>Backups</span>
                  </button>
                </div>
              </Panel>
            </div>

            <div className="two-col">
              <Panel title="Ops console" eyebrow="HERMES SAFE OUTPUT">
                <pre className="console">{consoleOutput}</pre>
              </Panel>
              <Panel title="Recent activity" eyebrow="THIS SESSION">
                <div className="activity-list">
                  {activity.length ? activity.slice(0, 7).map((item) => (
                    <div className="activity-row" key={item.id}>
                      <span className="activity-dot" />
                      <div>
                        <strong>{item.message}</strong>
                        <span>{timeAgo(item.at)}</span>
                      </div>
                    </div>
                  )) : <div className="empty">No actions yet.</div>}
                </div>
              </Panel>
            </div>
          </>
        )}

        {active === 'mission' && (
          <MissionControl
            apps={config?.apps || []}
            onOpenTelegram={() => setActive('telegram')}
          />
        )}

        {active === 'infra' && (
          <InfrastructureOS apps={config?.apps || []} />
        )}

        {active === 'apps' && (
          <Panel title="Managed applications" eyebrow="SAFE OPERATIONS">
            <div className="apps-list">
              {(config?.apps || []).map((name) => (
                <AppCard key={name} name={name} onAction={runAction} busy={Boolean(busy)} />
              ))}
            </div>
            <pre className="console spaced">{consoleOutput}</pre>
          </Panel>
        )}

        {active === 'deployments' && (
          <div className="two-col">
            <Panel title="Deployment control" eyebrow="MAIN BRANCH">
              <p className="muted">Deploy actions are restricted to configured applications and go through Hermes safe ops.</p>
              <div className="apps-list compact-list">
                {(config?.apps || []).map((name) => (
                  <button className="row-action" key={name} onClick={() => runAction('deploy', name)} disabled={busy}>
                    <span><Rocket size={16} /> {name}</span>
                    <Play size={15} />
                  </button>
                ))}
              </div>
            </Panel>
            <Panel title="Deployment output" eyebrow="LIVE RESULT">
              <pre className="console tall">{consoleOutput}</pre>
            </Panel>
          </div>
        )}

        {active === 'backups' && (
          <div className="two-col">
            <Panel title="Backup control" eyebrow="PER APPLICATION">
              <div className="feature-callout">
                <DatabaseBackup size={28} />
                <div>
                  <strong>Manual safe backup</strong>
                  <p>Each backup goes through the existing Hermes allowlist. No raw sudo is exposed to the browser.</p>
                </div>
              </div>
              <div className="apps-list compact-list">
                {(config?.apps || []).map((name) => (
                  <button className="row-action" key={name} onClick={() => runAction('backup', name)} disabled={busy}>
                    <span><DatabaseBackup size={16} /> {name}</span>
                    <Play size={15} />
                  </button>
                ))}
              </div>
            </Panel>
            <Panel title="Timers & output" eyebrow="AUTOMATION">
              <button className="secondary-btn" onClick={() => runAction('timers')} disabled={busy}>
                <TimerReset size={17} /> Inspect backup timers
              </button>
              <pre className="console spaced tall">{consoleOutput}</pre>
            </Panel>
          </div>
        )}

        {active === 'incidents' && (
          <div className="two-col">
            <Panel title="Incident signals" eyebrow="HEALTH">
              <div className="feature-callout">
                <ShieldCheck size={28} />
                <div>
                  <strong>{online ? 'No dashboard outage detected' : 'Dashboard API is unreachable'}</strong>
                  <p>Use the safe health command for deeper host and application checks.</p>
                </div>
              </div>
              <button className="primary-btn" onClick={() => runAction('health')} disabled={busy}>
                <HeartPulse size={17} /> Run health check
              </button>
            </Panel>
            <Panel title="Diagnostic output" eyebrow="READ ONLY">
              <pre className="console tall">{consoleOutput}</pre>
            </Panel>
          </div>
        )}

        {active === 'github' && (
          <div className="two-col wide-left">
            <Panel title="GitHub connection" eyebrow="SOURCE CONTROL">
              <div className="connection-card">
                <Github size={30} />
                <div>
                  <strong>{config?.github?.owner || 'GitHub owner'}</strong>
                  <span>Allowed branch: {config?.github?.branch || 'main'}</span>
                </div>
                <StatusPill online={github?.ok !== false}>{github?.ok === false ? 'API issue' : 'Connected'}</StatusPill>
              </div>
              {github?.error && <div className="alert small-alert">{github.error}</div>}
              <div className="repo-list">
                {(github?.repositories || []).map((repo) => (
                  <a className="repo-row" key={repo.name} href={repo.url} target="_blank" rel="noreferrer">
                    <Code2 size={16} />
                    <div>
                      <strong>{repo.name}</strong>
                      <span>{repo.defaultBranch} · updated {timeAgo(repo.updatedAt)}</span>
                    </div>
                    <ChevronRight size={15} />
                  </a>
                ))}
              </div>
            </Panel>
            <Panel title="GitHub policy" eyebrow="GUARDRAILS">
              <ul className="policy-list">
                <li><CheckCircle2 size={16} /> Owner allowlist stays server-side.</li>
                <li><CheckCircle2 size={16} /> Production branch defaults to main.</li>
                <li><CheckCircle2 size={16} /> No GitHub token is sent to the browser.</li>
                <li><CheckCircle2 size={16} /> Deploy still passes through Hermes safe ops.</li>
              </ul>
            </Panel>
          </div>
        )}

        {active === 'telegram' && (
          <div className="two-col wide-left">
            <Panel title="Hermes command bridge" eyebrow="WEB → HERMES">
              <div className="connection-card">
                <Bot size={30} />
                <div>
                  <strong>Hermes Telegram controls</strong>
                  <span>Web commands execute the same safe Hermes helpers as Telegram quick commands.</span>
                </div>
                <StatusPill online={config?.telegram?.configured}>
                  {config?.telegram?.configured ? 'Ready' : 'Setup needed'}
                </StatusPill>
              </div>

              <div className="command-note">
                <ShieldCheck size={16} />
                <span>The web cannot impersonate your Telegram user account. Typing <strong>/server</strong> here runs the same Hermes command directly instead of sending "/server" as a bot message.</span>
              </div>

              <form className="telegram-command-form" onSubmit={(event) => runTelegramCommand(event)}>
                <div className="telegram-command-input">
                  <Terminal size={17} />
                  <input
                    value={telegramCommand}
                    onChange={(event) => setTelegramCommand(event.target.value)}
                    placeholder="/server"
                    autoComplete="off"
                  />
                  <button className="primary-btn compact" disabled={busy === 'telegram-command' || !telegramCommand.trim()}>
                    <Play size={15} /> Run
                  </button>
                </div>
                <div className="command-chips">
                  {['/server', '/apps', '/backup', '/deployments', '/incidents', '/serverhelp'].map((command) => (
                    <button
                      type="button"
                      key={command}
                      onClick={() => runTelegramCommand(null, command)}
                      disabled={busy === 'telegram-command'}
                    >
                      {command}
                    </button>
                  ))}
                </div>
              </form>

              <pre className="console spaced tall">{telegramCommandOutput}</pre>

              <div className="telegram-note-section">
                <span className="eyebrow">BOT NOTIFICATION · OUTBOUND ONLY</span>
                <p className="muted">
                  This sends a message from the bot to your Telegram chat. Slash commands typed here are not treated as messages from your personal Telegram account.
                </p>
                <form className="telegram-form" onSubmit={sendTelegram}>
                  <textarea
                    value={telegramText}
                    onChange={(event) => setTelegramText(event.target.value)}
                    placeholder="Send a notification from Hermes bot…"
                    maxLength={1000}
                  />
                  <button className="secondary-btn" disabled={busy === 'telegram' || !telegramText.trim()}>
                    <MessageCircle size={17} /> Send bot notification
                  </button>
                </form>
              </div>
            </Panel>
            <Panel title="Shared Hermes state" eyebrow="TELEGRAM ↔ WEB">
              <p className="muted">
                Your manual Telegram commands and web commands now call the same root-controlled Hermes dashboard helpers.
                The Telegram bot remains the bot; the website does not pretend to be your Telegram account.
              </p>
              <pre className="console tall">{hermesStatus || 'Loading Hermes status…'}</pre>
            </Panel>
          </div>
        )}

        {active === 'system' && (
          <>
            <section className="metrics-grid">
              <Metric icon={Cpu} label="CPU" value={(overview?.cpu?.percent ?? 0) + '%'} sub={overview?.cpu?.model || '—'} percent={overview?.cpu?.percent} />
              <Metric icon={MemoryStick} label="RAM" value={(overview?.memory?.percent ?? 0) + '%'} sub={formatBytes(overview?.memory?.total)} percent={overview?.memory?.percent} />
              <Metric icon={HardDrive} label="Root disk" value={(overview?.disk?.percent ?? 0) + '%'} sub={formatBytes(overview?.disk?.total)} percent={overview?.disk?.percent} />
              <Metric icon={Server} label="Uptime" value={formatUptime(overview?.system?.uptimeSeconds)} sub={overview?.system?.release || '—'} percent={25} />
            </section>
            <Panel title="Host information" eyebrow="LIVE FROM NODE.JS">
              <div className="info-grid">
                <div><span>Hostname</span><strong>{overview?.system?.hostname || '—'}</strong></div>
                <div><span>Platform</span><strong>{overview?.system?.platform || '—'}</strong></div>
                <div><span>Architecture</span><strong>{overview?.system?.arch || '—'}</strong></div>
                <div><span>Node.js</span><strong>{overview?.system?.node || '—'}</strong></div>
                <div><span>Load 1m</span><strong>{overview?.system?.loadAverage?.[0]?.toFixed?.(2) || '—'}</strong></div>
                <div><span>Load 5m</span><strong>{overview?.system?.loadAverage?.[1]?.toFixed?.(2) || '—'}</strong></div>
              </div>
            </Panel>
          </>
        )}

        <div className="mobile-nav">
          {navItems.map((item) => {
            const Icon = item.icon
            return (
              <button key={item.id} className={active === item.id ? 'active' : ''} onClick={() => setActive(item.id)}>
                <Icon size={18} />
                <span>{item.label}</span>
              </button>
            )
          })}
        </div>
      </main>
    </div>
  )
}
