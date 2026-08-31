import { writeFile, mkdir } from 'node:fs/promises'

const url = 'https://control.maulanaroyyantsubaisa.my.id/api/health'
const rows = []

for (let i = 0; i < 36; i += 1) {
  const at = new Date().toISOString()
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'royyan-production-flap-probe/1' },
      signal: AbortSignal.timeout(10000)
    })
    const data = await response.json()
    rows.push({
      at,
      http: response.status,
      self: data?.selfTest?.status || null,
      deep: data?.deepAcceptance?.status || null,
      hasV3: Boolean(data?.infrastructureV3),
      v3Ready: data?.infrastructureV3?.ready ?? null,
      v3Recurring: data?.v3Validation?.recurring?.status || null,
      v3Acceptance: data?.v3Validation?.acceptance?.status || null,
      reconciler: data?.controlReconciler?.status || null,
      bridge: data?.gitOpsBridge?.status || null,
      serviceAt: data?.at || null
    })
  } catch (error) {
    rows.push({ at, error: String(error.message || error) })
  }
  if (i < 35) await new Promise((resolve) => setTimeout(resolve, 5000))
}

await mkdir('telemetry', { recursive: true })
await writeFile('telemetry/flap-probe.json', JSON.stringify(rows, null, 2) + '\n')
