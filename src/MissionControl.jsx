import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  AppWindow,
  ArchiveRestore,
  Bot,
  CheckCircle2,
  Cloud,
  FileClock,
  GitBranch,
  HeartPulse,
  Laptop,
  Network,
  Play,
  RefreshCw,
  Rocket,
  Search,
  Send,
  ShieldCheck,
  ShieldAlert,
  Sparkles,
  Terminal,
  XCircle,
  Zap
} from 'lucide-react'
import './mission-control.css'

async function request(path, options) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options?.headers || {}) },
    ...options
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || 'Request failed')
  return data
}

function FeatureBadge({ number, title, state = 'ready' }) {
  return (
    <div className="mc-feature-title">
      <span className="mc-number">{number}</span>
      <strong>{title}</strong>
      <span className={'mc-state ' + state}>{state}</span>
    </div>
  )
}

function Shell({ children, className = '' }) {
  return <section className={'mc-card ' + className}>{children}</section>
}

function CodeBox({ children, className = '' }) {
  return <pre className={'mc-code ' + className}>{children || 'No data yet.'}</pre>
}

function AppHealth({ item }) {
  return (
    <div className="mc-app-health">
      <span className={'mc-health-dot ' + (item.reachable ? 'up' : 'down')} />
      <div>
        <strong>{item.app}</strong>
        <span>{item.status || 'ERR'} · {item.latencyMs}ms · Hermes {item.hermes || 'unknown'}</span>
      </div>
      <a href={item.url} target="_blank" rel="noreferrer">Open</a>
    </div>
  )
}

export default function MissionControl({ apps = [], onOpenTelegram }) {
  const [tab, setTab] = useState('live')
  const [health, setHealth] = useState(null)
  const [guard, setGuard] = useState(null)
  const [backups, setBackups] = useState(null)
  const [deployments, setDeployments] = useState(null)
  const [incidents, setIncidents] = useState(null)
  const [maintenance, setMaintenance] = useState(null)
  const [security, setSecurity] = useState(null)
  const [audit, setAudit] = useState(null)
  const [daily, setDaily] = useState(null)
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState('')
  const [logApp, setLogApp] = useState(apps[0] || '')
  const [logs, setLogs] = useState('Select an app to stream safe logs.')
  const [repo, setRepo] = useState('MaulanaRoyyanTsubaisa/')
  const [copilotQuestion, setCopilotQuestion] = useState('Apa yang perlu saya perhatikan di server sekarang?')
  const [copilot, setCopilot] = useState(null)
  const [installPrompt, setInstallPrompt] = useState(null)
  const eventSource = useRef(null)

  const loadCore = async (force = false) => {
    try {
      const [h, g, b, d, i, m, s, a, r] = await Promise.all([
        request('/api/v2/health/apps' + (force ? '?force=1' : '')),
        request('/api/v2/preflight'),
        request('/api/v2/backups'),
        request('/api/v2/deployments?limit=40'),
        request('/api/v2/incidents?limit=40'),
        request('/api/v2/maintenance'),
        request('/api/v2/security'),
        request('/api/v2/audit?limit=60'),
        request('/api/v2/daily-report')
      ])
      setHealth(h)
      setGuard(g)
      setBackups(b)
      setDeployments(d)
      setIncidents(i)
      setMaintenance(m)
      setSecurity(s)
      setAudit(a)
      setDaily(r)
      setMessage('')
    } catch (error) {
      setMessage('Mission Control API: ' + error.message)
    }
  }

  useEffect(() => {
    loadCore()
    const timer = setInterval(() => loadCore(), 20000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    const handler = (event) => {
      event.preventDefault()
      setInstallPrompt(event)
    }
    window.addEventListener('beforeinstallprompt', handler)
    return () => window.removeEventListener('beforeinstallprompt', handler)
  }, [])

  useEffect(() => {
    if (!logApp) return
    eventSource.current?.close()
    const source = new EventSource('/api/v2/logs/stream?app=' + encodeURIComponent(logApp))
    eventSource.current = source
    source.addEventListener('logs', (event) => {
      try {
        const data = JSON.parse(event.data)
        setLogs(data.output || 'No log output.')
      } catch {
        setLogs(event.data)
      }
    })
    source.addEventListener('error', () => {
      if (source.readyState === EventSource.CLOSED) {
        setLogs((current) => current + '\n\n[stream closed]')
      }
    })
    return () => source.close()
  }, [logApp])

  const run = async (key, fn) => {
    setBusy(key)
    setMessage('')
    try {
      const result = await fn()
      setMessage(result?.note || result?.stdout || 'Done ✅')
      await loadCore(true)
      return result
    } catch (error) {
      setMessage('ERROR: ' + error.message)
      return null
    } finally {
      setBusy('')
    }
  }

  const toggleMaintenance = async (appName, enabled) => {
    await run('maintenance:' + appName, () =>
      request('/api/v2/maintenance/' + encodeURIComponent(appName), {
        method: 'POST',
        body: JSON.stringify({ enabled })
      })
    )
  }

  const runCopilot = async (event) => {
    event?.preventDefault?.()
    setBusy('copilot')
    try {
      const result = await request('/api/v2/copilot', {
        method: 'POST',
        body: JSON.stringify({ question: copilotQuestion })
      })
      setCopilot(result)
    } catch (error) {
      setCopilot({ answer: 'ERROR: ' + error.message })
    } finally {
      setBusy('')
    }
  }

  const installPwa = async () => {
    if (!installPrompt) {
      setMessage('Browser belum menawarkan install PWA. Coba menu browser → Install app / Add to Home Screen.')
      return
    }
    await installPrompt.prompt()
    await installPrompt.userChoice
    setInstallPrompt(null)
  }

  const maintenanceByApp = useMemo(() => {
    return Object.fromEntries((maintenance?.apps || []).map((item) => [item.app, item]))
  }, [maintenance])

  return (
    <div className="mc-shell">
      <div className="mc-hero">
        <div>
          <span className="eyebrow">CONTROL PLANE V2</span>
          <h2>Mission Control</h2>
          <p>15 tune-ups: live health, deployments, logs, backups, incidents, guards, autopilot, maintenance, copilot, topology, Telegram, PWA, audit, security, and daily reporting.</p>
        </div>
        <div className="mc-hero-actions">
          <span className={'mc-big-status ' + (health?.online === health?.total ? 'ok' : 'warn')}>
            <HeartPulse size={16} /> {health ? `${health.online}/${health.total} public apps reachable` : 'Loading fleet…'}
          </span>
          <button className="secondary-btn" onClick={() => loadCore(true)} disabled={busy}>
            <RefreshCw size={16} /> Refresh all
          </button>
        </div>
      </div>

      {message && <div className="mc-message">{message}</div>}

      <div className="mc-tabs">
        {[
          ['live', 'Live Ops', Activity],
          ['automation', 'Automation', Zap],
          ['copilot', 'Copilot', Sparkles],
          ['security', 'Security & Audit', ShieldCheck]
        ].map(([id, label, Icon]) => (
          <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
            <Icon size={16} /> {label}
          </button>
        ))}
      </div>

      {tab === 'live' && (
        <div className="mc-grid">
          <Shell className="span-2">
            <FeatureBadge number="01" title="Live App Health" />
            <div className="mc-app-grid">
              {(health?.apps || []).map((item) => <AppHealth item={item} key={item.app} />)}
            </div>
          </Shell>

          <Shell>
            <FeatureBadge number="02" title="Deployment Center" />
            <div className="mc-feed">
              {(deployments?.events || []).slice(0, 8).map((item) => (
                <div key={item.id}><Rocket size={14} /><span><strong>{item.app || 'control'}</strong>{item.type}</span><time>{new Date(item.at).toLocaleString()}</time></div>
              ))}
            </div>
            <CodeBox>{deployments?.hermesRaw}</CodeBox>
          </Shell>

          <Shell>
            <FeatureBadge number="03" title="Live Logs Streaming" />
            <div className="mc-inline">
              <select value={logApp} onChange={(e) => setLogApp(e.target.value)}>
                {apps.map((name) => <option value={name} key={name}>{name}</option>)}
              </select>
              <span className="mc-live"><span /> LIVE</span>
            </div>
            <CodeBox className="logs">{logs}</CodeBox>
          </Shell>

          <Shell>
            <FeatureBadge number="04" title="Backup Center + Restore Drill" state={backups?.summary?.failure ? 'warn' : 'ready'} />
            <div className="mc-kpis">
              <div><span>Verified</span><strong>{backups?.summary?.verified ?? '—'}/{backups?.summary?.total ?? '—'}</strong></div>
              <div><span>Failed</span><strong>{backups?.summary?.failure ? 'YES' : 'No detected'}</strong></div>
              <div><span>Stale</span><strong>{backups?.summary?.stale ? 'YES' : 'No detected'}</strong></div>
            </div>
            <div className="mc-action-list">
              {apps.slice(0, 10).map((name) => (
                <div key={name}><span>{name}</span><div>
                  <button disabled={busy} onClick={() => run('backup:' + name, () => request('/api/v2/backups/' + name + '/run', { method: 'POST' }))}>Backup</button>
                  <button disabled={busy} onClick={() => run('drill:' + name, () => request('/api/v2/backups/' + name + '/drill', { method: 'POST' }))}><ArchiveRestore size={13} /> Drill</button>
                </div></div>
              ))}
            </div>
          </Shell>

          <Shell>
            <FeatureBadge number="05" title="Incident Center + Self-Healing" />
            <CodeBox>{incidents?.hermesRaw}</CodeBox>
            <div className="mc-feed small">
              {(incidents?.events || []).slice(0, 6).map((item) => (
                <div key={item.id}><AlertTriangle size={14} /><span><strong>{item.app || 'server'}</strong>{item.type}</span><time>{new Date(item.at).toLocaleString()}</time></div>
              ))}
            </div>
          </Shell>

          <Shell>
            <FeatureBadge number="06" title="Resource Guard 2.0" state={guard?.allowed ? 'ready' : 'blocked'} />
            <div className="mc-kpis">
              <div><span>RAM</span><strong>{guard?.resources?.memoryPercent ?? '—'}%</strong></div>
              <div><span>Disk</span><strong>{guard?.resources?.diskPercent ?? '—'}%</strong></div>
              <div><span>Load</span><strong>{guard?.resources?.load1?.toFixed?.(2) ?? '—'}</strong></div>
            </div>
            <div className={'mc-guard ' + (guard?.allowed ? 'ok' : 'blocked')}>
              {guard?.allowed ? <CheckCircle2 size={18} /> : <XCircle size={18} />}
              <span>{guard?.allowed ? 'Deployments allowed' : (guard?.blockers || []).join('; ')}</span>
            </div>
            <CodeBox>{guard?.guardRaw}</CodeBox>
          </Shell>
        </div>
      )}

      {tab === 'automation' && (
        <div className="mc-grid">
          <Shell>
            <FeatureBadge number="07" title="One-Click New App Autopilot" />
            <p className="mc-muted">Repo tetap melewati owner allowlist, <code>.home-server.json</code>, supported-stack validation, free-port selection, build, router, backup and Hermes automation.</p>
            <div className="mc-form-row">
              <GitBranch size={16} />
              <input value={repo} onChange={(e) => setRepo(e.target.value)} />
              <button className="primary-btn compact" disabled={busy || !repo.trim()} onClick={() => run('autopilot', () => request('/api/v2/autopilot/new-app', { method: 'POST', body: JSON.stringify({ repo }) }))}>
                <Rocket size={14} /> Prepare
              </button>
            </div>
          </Shell>

          <Shell>
            <FeatureBadge number="08" title="Per-App Maintenance Mode" state={maintenance?.helperInstalled ? 'ready' : 'needs-install'} />
            <p className="mc-muted">Traffic maintenance uses a dedicated root-controlled helper, Nginx backup + syntax test + rollback. Production database is untouched.</p>
            <div className="mc-action-list">
              {apps.map((name) => {
                const state = maintenanceByApp[name]
                return <div key={name}><span>{name}</span><button disabled={busy || !maintenance?.helperInstalled} onClick={() => toggleMaintenance(name, !state?.active)}>{state?.active ? 'Go online' : 'Maintenance'}</button></div>
              })}
            </div>
          </Shell>

          <Shell className="span-2">
            <FeatureBadge number="10" title="Network / Infrastructure Map" />
            <div className="mc-topology">
              <div className="mc-node edge"><Cloud size={22} /><strong>Cloudflare</strong><span>wildcard tunnel</span></div>
              <div className="mc-arrow">→</div>
              <div className="mc-node router"><Network size={22} /><strong>hermes-router</strong><span>:8090</span></div>
              <div className="mc-arrow">→</div>
              <div className="mc-app-cloud">
                {(health?.apps || []).map((item) => <span className={item.reachable ? 'up' : 'down'} key={item.app}>{item.app}<small>{item.status || 'ERR'} · {item.latencyMs}ms</small></span>)}
              </div>
            </div>
          </Shell>

          <Shell>
            <FeatureBadge number="11" title="Telegram Mini Control" />
            <div className="mc-icon-callout"><Bot size={28} /><div><strong>Shared Hermes command layer</strong><span>Web and Telegram quick commands execute the same safe dashboard helpers. Existing bot remains the bot; no user-account impersonation.</span></div></div>
            <button className="secondary-btn" onClick={onOpenTelegram}><Bot size={15} /> Open Telegram command bridge</button>
          </Shell>

          <Shell>
            <FeatureBadge number="12" title="PWA + Mobile Control" />
            <div className="mc-icon-callout"><Laptop size={28} /><div><strong>Installable control panel</strong><span>Standalone mode, app manifest, service-worker shell cache, and full horizontally scrollable mobile navigation.</span></div></div>
            <button className="primary-btn" onClick={installPwa}><AppWindow size={15} /> Install / Add to Home Screen</button>
          </Shell>

          <Shell className="span-2">
            <FeatureBadge number="15" title="Daily Smart Morning Report" />
            <div className="mc-kpis">
              <div><span>Schedule</span><strong>08:00 WIB</strong></div>
              <div><span>Apps</span><strong>{daily?.preview?.apps || '—'}</strong></div>
              <div><span>RAM</span><strong>{daily?.preview?.memory || '—'}</strong></div>
              <div><span>Disk</span><strong>{daily?.preview?.disk || '—'}</strong></div>
            </div>
            <p className="mc-muted">Uses the existing Hermes daily-report timer. “Send now” creates an enhanced safe-ops snapshot and sends it through the existing Telegram sender.</p>
            <button className="secondary-btn" disabled={busy} onClick={() => run('report', () => request('/api/v2/daily-report/send-now', { method: 'POST' }))}><Send size={15} /> Send report now</button>
            <CodeBox>{daily?.timers}</CodeBox>
          </Shell>
        </div>
      )}

      {tab === 'copilot' && (
        <div className="mc-grid">
          <Shell className="span-2">
            <FeatureBadge number="09" title="Hermes Ops Copilot" />
            <p className="mc-muted">Diagnosis is grounded in current safe telemetry: public health, Resource Guard, backup state, incidents, and deployment history. It recommends actions but does not perform destructive recovery.</p>
            <form className="mc-copilot-form" onSubmit={runCopilot}>
              <Search size={17} />
              <input value={copilotQuestion} onChange={(e) => setCopilotQuestion(e.target.value)} placeholder="Kenapa Rumahin lambat?" />
              <button className="primary-btn compact" disabled={busy === 'copilot'}><Sparkles size={14} /> Analyze</button>
            </form>
            <CodeBox className="copilot">{copilot?.answer || 'Ask the copilot about an outage, slow app, backup state, or whether it is safe to deploy.'}</CodeBox>
          </Shell>
        </div>
      )}

      {tab === 'security' && (
        <div className="mc-grid">
          <Shell>
            <FeatureBadge number="13" title="Permanent Audit Log" />
            <div className="mc-feed audit">
              {(audit?.events || []).slice(0, 24).map((item) => (
                <div key={item.id}><FileClock size={14} /><span><strong>{item.source}</strong>{item.type}{item.app ? ' · ' + item.app : ''}</span><time>{new Date(item.at).toLocaleString()}</time></div>
              ))}
            </div>
          </Shell>

          <Shell>
            <FeatureBadge number="14" title="Security Center" state={(security?.score || 0) >= 90 ? 'ready' : 'warn'} />
            <div className="mc-security-score"><ShieldCheck size={34} /><div><strong>{security?.score ?? '—'}/100</strong><span>control-plane safety posture</span></div></div>
            <div className="mc-security-list">
              {Object.entries(security?.wrappers || {}).map(([name, ready]) => <div key={name}>{ready ? <CheckCircle2 size={14} /> : <ShieldAlert size={14} />}<span>{name}</span><strong>{ready ? 'ready' : 'missing'}</strong></div>)}
            </div>
            <CodeBox>{security ? `Auth configured: ${security.authConfigured}\nRaw shell in browser: ${security.headers.rawShell}\nDocker socket in browser: ${security.headers.dockerSocketExposedToBrowser}\nObserved TCP listeners: ${security.listeners.length}` : ''}</CodeBox>
          </Shell>
        </div>
      )}
    </div>
  )
}
