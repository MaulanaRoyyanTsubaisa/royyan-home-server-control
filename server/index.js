import 'dotenv/config'
import http from 'node:http'

const PORT = Number(process.env.PORT || 8787)
const HOST = process.env.HOST || '127.0.0.1'
const authConfigured = Boolean(
  process.env.CONTROL_ADMIN_PASSWORD &&
  process.env.CONTROL_SESSION_SECRET
)

let phase = 'booting'
let bootError = null

function healthPayload() {
  return {
    ok: phase !== 'failed',
    service: 'royyan-home-server-control',
    phase,
    authConfigured,
    bootError: bootError ? String(bootError).slice(0, 240) : null,
    at: new Date().toISOString()
  }
}

const bootstrap = http.createServer((req, res) => {
  if (req.url === '/api/health' || req.url?.startsWith('/api/health?')) {
    const status = phase === 'failed' ? 503 : 200
    const body = JSON.stringify(healthPayload())
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store'
    })
    res.end(body)
    return
  }

  res.writeHead(503, {
    'Content-Type': 'application/json',
    'Retry-After': '1',
    'Cache-Control': 'no-store'
  })
  res.end(JSON.stringify({
    ok: false,
    service: 'royyan-home-server-control',
    phase,
    error: 'Control plane is starting'
  }))
})

bootstrap.on('error', (error) => {
  console.error('Bootstrap listener failed:', error)
  process.exitCode = 1
})

bootstrap.listen(PORT, HOST, async () => {
  console.log('Royyan control bootstrap listening on http://' + HOST + ':' + PORT)
  try {
    phase = 'loading-runtime'
    const runtime = await import('./runtime.js')
    phase = 'handoff'

    bootstrap.close(async (closeError) => {
      if (closeError) {
        bootError = closeError.message
        phase = 'failed'
        console.error('Bootstrap handoff close failed:', closeError)
        process.exitCode = 1
        return
      }

      try {
        await runtime.startRuntime()
        phase = 'ready'
      } catch (error) {
        bootError = error.message
        phase = 'failed'
        console.error('Runtime start failed:', error)
        process.exitCode = 1
        setTimeout(() => process.exit(1), 100).unref?.()
      }
    })
  } catch (error) {
    bootError = error.message
    phase = 'failed'
    console.error('Runtime import failed:', error)
    setTimeout(() => process.exit(1), 250).unref?.()
  }
})
