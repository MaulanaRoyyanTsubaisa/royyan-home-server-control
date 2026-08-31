import { mkdir, writeFile } from 'node:fs/promises'

const apps = [
  'portfolio','opspilot','bantuai','niagabot','sajiin','kontenin',
  'lamarin','learnwithroyyan','rumahin','tagihin','janjiin'
]
const base = 'maulanaroyyantsubaisa.my.id'
const rows = []

for (const app of apps) {
  const url = 'https://' + app + '.' + base + '/'
  const started = Date.now()
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'User-Agent': 'royyan-fleet-diagnostic/1' },
      signal: AbortSignal.timeout(12000)
    })
    rows.push({
      app,
      url,
      http: response.status,
      reachable:
        (response.status >= 200 && response.status < 400) ||
        response.status === 401 ||
        response.status === 403 ||
        response.status === 503,
      maintenance: response.status === 503,
      latencyMs: Date.now() - started,
      location: response.headers.get('location') || null,
      server: response.headers.get('server') || null
    })
  } catch (error) {
    rows.push({
      app,
      url,
      http: 0,
      reachable: false,
      maintenance: false,
      latencyMs: Date.now() - started,
      error: String(error.message || error).slice(0, 300)
    })
  }
}

await mkdir('telemetry', { recursive: true })
await writeFile(
  'telemetry/fleet-probe.json',
  JSON.stringify({ at: new Date().toISOString(), apps: rows }, null, 2) + '\n'
)
