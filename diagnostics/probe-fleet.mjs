import { mkdir, writeFile } from 'node:fs/promises'

const apps = [
  'portfolio','opspilot','bantuai','niagabot','sajiin',
  'kontenin','lamarin','learnwithroyyan','rumahin','tagihin','janjiin'
]

const results = []
for (const app of apps) {
  const url = 'https://' + app + '.maulanaroyyantsubaisa.my.id/'
  const started = Date.now()
  try {
    const response = await fetch(url, {
      redirect: 'manual',
      headers: { 'User-Agent': 'royyan-fleet-diagnostic/1' },
      signal: AbortSignal.timeout(12000)
    })
    results.push({
      app,
      url,
      status: response.status,
      reachable:
        (response.status >= 200 && response.status < 400) ||
        response.status === 401 ||
        response.status === 403,
      latencyMs: Date.now() - started
    })
  } catch (error) {
    results.push({
      app,
      url,
      status: 0,
      reachable: false,
      latencyMs: Date.now() - started,
      error: String(error.message || error)
    })
  }
}

await mkdir('telemetry', { recursive: true })
await writeFile('telemetry/fleet-probe.json', JSON.stringify({
  at: new Date().toISOString(),
  online: results.filter((x) => x.reachable).length,
  total: results.length,
  results
}, null, 2) + '\n')
