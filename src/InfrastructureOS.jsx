import { useEffect, useMemo, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  Bot,
  BrainCircuit,
  Boxes,
  Clock3,
  Cloud,
  Cpu,
  DatabaseBackup,
  Gauge,
  GitCommitHorizontal,
  HardDrive,
  History,
  Network,
  Play,
  Power,
  Radar,
  RefreshCw,
  Route,
  Server,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  TimerReset,
  TriangleAlert,
  WandSparkles,
  Zap
} from 'lucide-react'
import './infrastructure-os.css'

async function api(path, options) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options?.headers || {}) },
    ...options
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error || 'Request failed')
  return payload
}

function Feature({ n, title, state = 'active', icon: Icon, children, wide = false }) {
  return (
    <section className={'ios-card ' + (wide ? 'wide' : '')}>
      <div className="ios-card-head">
        <div className="ios-feature-id">{String(n).padStart(2, '0')}</div>
        <Icon size={17} />
        <strong>{title}</strong>
        <span className={'ios-badge ' + state}>{state}</span>
      </div>
      {children}
    </section>
  )
}

function Mono({ children, tall = false }) {
  return <pre className={'ios-mono ' + (tall ? 'tall' : '')}>{children || 'No data yet.'}</pre>
}

function Kpis({ items }) {
  return (
    <div className="ios-kpis">
      {items.map(([label, value]) => (
        <div key={label}><span>{label}</span><strong>{value}</strong></div>
      ))}
    </div>
  )
}

function statusClass(ok) {
  return ok ? 'ok' : 'warn'
}

export default function InfrastructureOS({ apps = [] }) {
  const [tab, setTab] = useState('command')
  const [overview, setOverview] = useState(null)
  const [timeMachine, setTimeMachine] = useState(null)
  const [capacity, setCapacity] = useState(null)
  const [predictive, setPredictive] = useState(null)
  const [commander, setCommander] = useState(null)
  const [warRoom, setWarRoom] = useState(null)
  const [skills, setSkills] = useState([])
  const [canary, setCanary] = useState(null)
  const [dr, setDr] = useState(null)
  const [power, setPower] = useState(null)
  const [failover, setFailover] = useState(null)
  const [vault, setVault] = useState(null)
  const [postmortems, setPostmortems] = useState([])
  const [commitRisk, setCommitRisk] = useState(null)
  const [rootCause, setRootCause] = useState(null)
  const [deploymentReplay, setDeploymentReplay] = useState(null)
  const [command, setCommand] = useState('cek kondisi server')
  const [commandPlan, setCommandPlan] = useState(null)
  const [commandOutput, setCommandOutput] = useState('')
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState('')
  const [chaosApp, setChaosApp] = useState(apps[0] || 'rumahin')
  const [chaosResult, setChaosResult] = useState(null)

  const refresh = async () => {
    try {
      const [
        o, tm, cap, pred, cmd, war, skillData, can, drData, powerData,
        fail, vaultData, posts, risk, rca, replay
      ] = await Promise.all([
        api('/api/v3/overview'),
        api('/api/v3/time-machine?limit=120'),
        api('/api/v3/capacity'),
        api('/api/v3/predictive-risk'),
        api('/api/v3/incident-commander'),
        api('/api/v3/war-room'),
        api('/api/v3/skills'),
        api('/api/v3/canary/readiness'),
        api('/api/v3/dr/readiness'),
        api('/api/v3/power'),
        api('/api/v3/failover'),
        api('/api/v3/vault'),
        api('/api/v3/postmortems?limit=10'),
        api('/api/v3/commit-risk?repo=royyan-home-server-control').catch(() => null),
        api('/api/v3/root-cause'),
        api('/api/v3/deployment-replay')
      ])
      setOverview(o)
      setTimeMachine(tm)
      setCapacity(cap)
      setPredictive(pred)
      setCommander(cmd)
      setWarRoom(war)
      setSkills(skillData.skills || [])
      setCanary(can)
      setDr(drData)
      setPower(powerData)
      setFailover(fail)
      setVault(vaultData)
      setPostmortems(posts.reports || [])
      setCommitRisk(risk)
      setRootCause(rca)
      setDeploymentReplay(replay)
      setMessage('')
    } catch (error) {
      setMessage(error.message)
    }
  }

  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, 30000)
    return () => clearInterval(timer)
  }, [])

  const snap = overview?.snapshot
  const reliability = overview?.reliability

  const twinApps = useMemo(() => snap?.apps || [], [snap])

  const runPlan = async (execute = false) => {
    setBusy(execute ? 'execute' : 'plan')
    try {
      if (!execute) {
        const result = await api('/api/v3/command/plan', {
          method: 'POST',
          body: JSON.stringify({ text: command })
        })
        setCommandPlan(result)
        setCommandOutput('')
      } else {
        const result = await api('/api/v3/command/execute', {
          method: 'POST',
          body: JSON.stringify({
            text: command,
            confirm: commandPlan?.plan?.mutating ? 'EXECUTE_SAFE_PLAN' : undefined
          })
        })
        setCommandOutput(
          result.output ||
          JSON.stringify(result.results || result, null, 2)
        )
        await refresh()
      }
    } catch (error) {
      setCommandOutput('ERROR: ' + error.message)
    } finally {
      setBusy('')
    }
  }

  const runChaos = async () => {
    setBusy('chaos')
    try {
      const result = await api('/api/v3/chaos', {
        method: 'POST',
        body: JSON.stringify({ app: chaosApp, mode: 'simulation' })
      })
      setChaosResult(result)
    } catch (error) {
      setChaosResult({ error: error.message })
    } finally {
      setBusy('')
    }
  }

  const makePostmortem = async () => {
    setBusy('postmortem')
    try {
      const result = await api('/api/v3/postmortem/generate', {
        method: 'POST',
        body: JSON.stringify({ title: 'Infrastructure OS generated postmortem' })
      })
      setMessage('Postmortem generated: ' + result.report.id)
      await refresh()
    } catch (error) {
      setMessage(error.message)
    } finally {
      setBusy('')
    }
  }

  const runSkill = async (id) => {
    setBusy('skill:' + id)
    try {
      const result = await api('/api/v3/skills/' + id + '/run', { method: 'POST' })
      setCommandOutput(JSON.stringify(result.output, null, 2))
      setTab('command')
    } catch (error) {
      setCommandOutput('ERROR: ' + error.message)
      setTab('command')
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="ios-shell">
      <header className={'ios-hero ' + (warRoom?.active ? 'war' : '')}>
        <div>
          <span className="eyebrow">ROYYAN INFRASTRUCTURE OS · HERMES V3</span>
          <h2>{warRoom?.active ? 'WAR ROOM ACTIVE' : 'Infrastructure Intelligence'}</h2>
          <p>
            Digital twin, time machine, black box, predictive risk, autonomous incident planning,
            reliability scoring, safe natural-language ops and guarded resilience controls.
          </p>
        </div>
        <div className="ios-score">
          <span>Reliability</span>
          <strong>{reliability?.total ?? '—'}</strong>
          <small>/ 100</small>
        </div>
      </header>

      {message && <div className="ios-message">{message}</div>}

      <nav className="ios-tabs">
        {[
          ['command', 'Command Center'],
          ['intelligence', 'Intelligence'],
          ['resilience', 'Resilience'],
          ['platform', 'Platform']
        ].map(([id, label]) => (
          <button className={tab === id ? 'active' : ''} onClick={() => setTab(id)} key={id}>{label}</button>
        ))}
        <button className="ios-refresh" onClick={refresh}><RefreshCw size={14} /> Refresh</button>
      </nav>

      {tab === 'command' && (
        <div className="ios-grid">
          <Feature n={1} title="Digital Twin Server" icon={Network} wide>
            <div className="ios-twin">
              <div className="ios-node edge"><Cloud size={21} /><strong>Cloudflare</strong><span>wildcard</span></div>
              <div className="ios-link">→</div>
              <div className="ios-node router"><Route size={21} /><strong>Hermes Router</strong><span>:8090</span></div>
              <div className="ios-link">→</div>
              <div className="ios-twin-apps">
                {twinApps.map((item) => (
                  <span key={item.app} className={item.reachable && item.status !== 503 ? 'up' : item.status === 503 ? 'maintenance' : 'down'}>
                    {item.app}<small>HTTP {item.status || 'ERR'} · {item.latencyMs}ms</small>
                  </span>
                ))}
              </div>
            </div>
          </Feature>

          <Feature n={10} title="Natural-Language Command Center" icon={TerminalSquare} wide>
            <div className="ios-command">
              <Sparkles size={18} />
              <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="deploy rumahin, backup semua app, cek kondisi server..." />
              <button onClick={() => runPlan(false)} disabled={busy}><WandSparkles size={14} /> Plan</button>
            </div>
            {commandPlan && (
              <div className="ios-plan">
                <div><span>Intent</span><strong>{commandPlan.plan.intent}</strong></div>
                <div><span>App</span><strong>{commandPlan.plan.app || 'fleet'}</strong></div>
                <div><span>Risk</span><strong>{commandPlan.plan.mutating ? 'approval required' : 'read-only'}</strong></div>
                <button onClick={() => runPlan(true)} disabled={!commandPlan.executable || busy}>
                  <Play size={13} /> Execute safe plan
                </button>
              </div>
            )}
            <Mono>{commandOutput}</Mono>
          </Feature>

          <Feature n={4} title="Autonomous Incident Commander" icon={Radar} state={commander?.active ? 'alert' : 'standby'}>
            <Kpis items={[
              ['Severity', commander?.severity || '—'],
              ['Affected', commander?.affectedApps?.length ?? '—'],
              ['War Room', warRoom?.active ? 'ACTIVE' : 'standby']
            ]} />
            <Mono>{(commander?.plan || []).map((x, i) => (i + 1) + '. ' + x).join('\n') || 'No active incident.'}</Mono>
          </Feature>

          <Feature n={15} title="Cinematic War Room" icon={TriangleAlert} state={warRoom?.active ? 'alert' : 'standby'}>
            <div className="ios-war-title">{warRoom?.title || 'Loading...'}</div>
            <div className="ios-mini-list">
              {(warRoom?.affectedApps || []).map((x) => <span key={x}>{x}</span>)}
              {!warRoom?.affectedApps?.length && <span>No affected apps</span>}
            </div>
          </Feature>

          <Feature n={20} title="Hermes Skill System" icon={Boxes} wide>
            <div className="ios-skills">
              {skills.map((skill) => (
                <button key={skill.id} onClick={() => runSkill(skill.id)} disabled={busy}>
                  <strong>{skill.name}</strong>
                  <span>{skill.description}</span>
                  <small>{skill.mode}</small>
                </button>
              ))}
            </div>
          </Feature>
        </div>
      )}

      {tab === 'intelligence' && (
        <div className="ios-grid">
          <Feature n={2} title="Infrastructure Time Machine" icon={History} wide>
            <Kpis items={[
              ['Samples', timeMachine?.count ?? '—'],
              ['Latest', snap?.at ? new Date(snap.at).toLocaleTimeString() : '—'],
              ['Interval', '5 min']
            ]} />
            <div className="ios-timeline">
              {(timeMachine?.samples || []).slice(-20).map((row) => (
                <div key={row.id} title={row.at}>
                  <span style={{ height: Math.max(8, row.resources?.memoryPercent || 0) + '%' }} />
                  <small>{row.online}/{row.total}</small>
                </div>
              ))}
            </div>
          </Feature>

          <Feature n={5} title="AI Root Cause Correlation" icon={BrainCircuit} state={rootCause?.affectedApps?.length ? 'warn' : 'active'}>
            <Mono>{
              rootCause?.findings?.length
                ? rootCause.findings.map((item) =>
                    item.app + ' · ' + item.hypothesis +
                    ' · confidence ' + Math.round((item.confidence || 0) * 100) + '%' +
                    ' · HTTP ' + item.latestHttp +
                    ' · ' + item.latestLatencyMs + 'ms'
                  ).join('\n')
                : (rootCause?.evidence || []).join('\n') || 'RCA engine is monitoring live telemetry.'
            }</Mono>
          </Feature>

          <Feature n={6} title="Automatic Postmortem" icon={Clock3}>
            <button className="ios-action" onClick={makePostmortem} disabled={busy}><Sparkles size={14} /> Generate from current evidence</button>
            <div className="ios-mini-list">
              {postmortems.slice(0, 5).map((p) => <span key={p.id}>{p.title} · {new Date(p.at).toLocaleString()}</span>)}
              {!postmortems.length && <span>No generated postmortems yet.</span>}
            </div>
          </Feature>

          <Feature n={9} title="Server Reliability Score" icon={Gauge}>
            <div className="ios-score-big">{reliability?.total ?? '—'}<small>/100</small></div>
            <Kpis items={[
              ['Availability', reliability?.availability ?? '—'],
              ['Backup', reliability?.backup ?? '—'],
              ['Security', reliability?.security ?? '—'],
              ['Deploy', reliability?.deployment ?? '—']
            ]} />
          </Feature>

          <Feature n={11} title="Auto Capacity Planner" icon={HardDrive}>
            <Kpis items={[
              ['Samples', capacity?.samples ?? '—'],
              ['Disk', capacity?.latest?.diskPercent != null ? capacity.latest.diskPercent + '%' : '—'],
              ['RAM', capacity?.latest?.memoryPercent != null ? capacity.latest.memoryPercent + '%' : '—'],
              ['Disk full', capacity?.forecast?.diskFullDays != null ? capacity.forecast.diskFullDays + 'd' : 'learning']
            ]} />
          </Feature>

          <Feature n={16} title="Server Black Box Recorder" icon={Activity}>
            <p className="ios-muted">Five-minute ring recorder persists fleet health, response time, resource pressure and app states for after-the-fact diagnosis.</p>
            <Kpis items={[
              ['Recorder', 'ARMED'],
              ['Retention', 'ring buffer'],
              ['Source', 'live telemetry']
            ]} />
          </Feature>

          <Feature n={17} title="Predictive Incident Detection" icon={AlertTriangle} state={predictive?.risks?.length ? 'warn' : 'active'}>
            <div className="ios-mini-list">
              {(predictive?.risks || []).map((r) => <span key={r.app}>{r.app} · {r.risk} · {r.reason} · {r.latestAvgMs}ms</span>)}
              {!predictive?.risks?.length && <span>Observed risk is currently low.</span>}
            </div>
          </Feature>

          <Feature n={18} title="Git Commit Risk Scoring" icon={GitCommitHorizontal} state={commitRisk?.level === 'HIGH' ? 'alert' : 'active'}>
            <div className="ios-risk">{commitRisk?.risk ?? '—'}<small>/100 · {commitRisk?.level || 'unknown'}</small></div>
            <Mono>{(commitRisk?.reasons || []).join('\n') || commitRisk?.message || 'Commit data unavailable.'}</Mono>
          </Feature>

          <Feature n={19} title="Visual Deployment Replay" icon={TimerReset} wide state={deploymentReplay?.timeline?.length ? 'active' : 'ready'}>
            <div className="ios-replay">
              {(deploymentReplay?.timeline || []).slice(-12).map((item, i) => (
                <div key={(item.at || '') + ':' + i}>
                  <span>{i + 1}</span>
                  <strong>{item.event}</strong>
                  <small>{item.at ? new Date(item.at).toLocaleTimeString() : '—'}</small>
                </div>
              ))}
              {!deploymentReplay?.timeline?.length && (
                <div><span>—</span><strong>No persisted deployment events yet</strong></div>
              )}
            </div>
            <p className="ios-muted">
              Source: {deploymentReplay?.source || 'persistent deployment history'} · App: {deploymentReplay?.app || '—'}
            </p>
          </Feature>
        </div>
      )}

      {tab === 'resilience' && (
        <div className="ios-grid">
          <Feature n={3} title="Chaos Engineering Lab" icon={Zap}>
            <select value={chaosApp} onChange={(e) => setChaosApp(e.target.value)}>
              {apps.map((x) => <option key={x}>{x}</option>)}
            </select>
            <button className="ios-action" onClick={runChaos} disabled={busy}><Zap size={14} /> Run safe simulation</button>
            <Mono>{chaosResult ? JSON.stringify(chaosResult.timeline || chaosResult, null, 2) : 'No chaos simulation yet.'}</Mono>
          </Feature>

          <Feature n={7} title="Blue / Green + Canary" icon={Route} state={canary?.supported ? 'active' : 'ready'}>
            <p className="ios-muted">{canary?.safety}</p>
            <Kpis items={[
              ['Configured apps', canary?.configuredApps?.length ?? '—'],
              ['Mode', canary?.supported ? 'ready for configured apps' : 'framework ready'],
              ['Auto rollback', 'required']
            ]} />
          </Feature>

          <Feature n={8} title="Disaster-Recovery Rehearsal" icon={DatabaseBackup} state={(dr?.score || 0) >= 90 ? 'active' : 'warn'}>
            <div className="ios-score-big">{dr?.score ?? '—'}<small>/100</small></div>
            <Kpis items={[
              ['Restore evidence', dr?.verifiedRestoreEvidence ? 'VERIFIED' : 'pending'],
              ['Backups', dr?.backupsHealthy ? 'healthy' : 'attention'],
              ['Fleet', dr?.fleetHealthy ? 'healthy' : 'degraded']
            ]} />
          </Feature>

          <Feature n={13} title="Secondary Server / Automatic Failover" icon={Server} state={failover?.configured ? 'active' : 'hardware'}>
            <Kpis items={[
              ['Secondary node', failover?.configured ? 'configured' : 'not connected'],
              ['Reachable', failover?.secondaryReachable ? 'yes' : 'no'],
              ['Mode', failover?.mode || '—']
            ]} />
            <p className="ios-muted">Software readiness exists; true failover needs a second physical/virtual node and replication policy.</p>
          </Feature>
        </div>
      )}

      {tab === 'platform' && (
        <div className="ios-grid">
          <Feature n={12} title="Power & Electricity Intelligence" icon={Power} state={power?.configured ? 'active' : 'hardware'}>
            <Kpis items={[
              ['Realtime source', power?.source || '—'],
              ['Watts', power?.watts ?? 'not connected'],
              ['kWh/day', power?.kwhDay != null ? power.kwhDay.toFixed(2) : '—'],
              ['Monthly', power?.estimatedMonthlyIdr ? 'Rp' + power.estimatedMonthlyIdr.toLocaleString('id-ID') : '—']
            ]} />
          </Feature>

          <Feature n={14} title="Secret & Credential Vault" icon={ShieldCheck} state={vault?.encryptedVaultConfigured ? 'active' : 'ready'}>
            <Kpis items={[
              ['Browser secrets', vault?.browserSecretsExposed ? 'EXPOSED' : 'hidden'],
              ['Current backend', vault?.backend || '—'],
              ['Encrypted vault', vault?.encryptedVaultConfigured ? 'configured' : 'optional migration']
            ]} />
            <p className="ios-muted">{vault?.recommendedNext}</p>
          </Feature>

          <Feature n={1} title="Fleet Core Snapshot" icon={Cpu}>
            <Kpis items={[
              ['Apps', snap ? snap.online + '/' + snap.total : '—'],
              ['RAM', snap?.resources ? snap.resources.memoryPercent + '%' : '—'],
              ['Disk', snap?.resources ? snap.resources.diskPercent + '%' : '—'],
              ['Load', snap?.resources?.load1?.toFixed?.(2) ?? '—']
            ]} />
          </Feature>

          <Feature n={4} title="Autonomous Recovery Policy" icon={Bot}>
            <p className="ios-muted">Safe restart and application-image rollback remain bounded. Production database restore is never performed automatically.</p>
            <Kpis items={[
              ['Safe restart', 'ARMED'],
              ['Image rollback', 'ARMED'],
              ['Auto DB restore', 'DISABLED']
            ]} />
          </Feature>
        </div>
      )}
    </div>
  )
}
