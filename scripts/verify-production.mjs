const url = process.env.CONTROL_HEALTH_URL || 'https://control.maulanaroyyantsubaisa.my.id/api/health'
const attempts = Number(process.env.CONTROL_HEALTH_ATTEMPTS || 36)
const delayMs = Number(process.env.CONTROL_HEALTH_DELAY_MS || 10000)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function summary(data) {
  const selfTest = data?.selfTest || {}
  const deep = data?.deepAcceptance || {}
  return {
    service: data?.service,
    authConfigured: data?.authConfigured,
    status: selfTest.status,
    passed: selfTest.passed,
    failed: selfTest.failed,
    expected: selfTest.expected,
    lastRun: selfTest.lastRun,
    failedChecks: Array.isArray(selfTest.checks)
      ? selfTest.checks.filter((item) => item.status !== 'pass')
      : [],
    deepStatus: deep.status,
    deepPassed: deep.passed,
    deepFailed: deep.failed,
    deepExpected: deep.expected,
    deepVersion: deep.version,
    deepChecks: Array.isArray(deep.checks) ? deep.checks : []
  }
}

let last = null
let lastError = ''

for (let attempt = 1; attempt <= attempts; attempt += 1) {
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'royyan-home-server-control-production-smoke/1' },
      signal: AbortSignal.timeout(12000)
    })

    if (!response.ok) throw new Error('HTTP ' + response.status)

    const data = await response.json()
    last = summary(data)

    console.log(
      '[production-smoke] attempt ' + attempt + '/' + attempts +
      ': service=' + (last.service || '-') +
      ' selfTest=' + (last.status || 'missing') +
      ' passed=' + (last.passed ?? '-') +
      ' failed=' + (last.failed ?? '-') +
      ' expected=' + (last.expected ?? '-') +
      ' deep=' + (last.deepStatus || 'missing') +
      ' deepPassed=' + (last.deepPassed ?? '-') +
      ' deepFailed=' + (last.deepFailed ?? '-')
    )

    const checks = data?.selfTest?.checks
    const allChecksPresent =
      Array.isArray(checks) &&
      checks.length === 15 &&
      checks.every((item) => /^\d{2}$/.test(item.id))

    if (
      data?.service === 'royyan-home-server-control' &&
      data?.authConfigured === true &&
      data?.selfTest?.status === 'pass' &&
      data?.selfTest?.passed === 15 &&
      data?.selfTest?.failed === 0 &&
      data?.selfTest?.expected === 15 &&
      allChecksPresent &&
      checks.every((item) => item.status === 'pass') &&
      data?.deepAcceptance?.status === 'pass' &&
      data?.deepAcceptance?.passed === 5 &&
      data?.deepAcceptance?.failed === 0 &&
      data?.deepAcceptance?.expected === 5 &&
      Array.isArray(data?.deepAcceptance?.checks) &&
      data.deepAcceptance.checks.length === 5 &&
      data.deepAcceptance.checks.every((item) => item.status === 'pass')
    ) {
      console.log('[production-smoke] PASS: recurring 15/15 and one-time deep acceptance 5/5 are healthy.')
      process.exit(0)
    }
  } catch (error) {
    lastError = error.message
    console.log('[production-smoke] attempt ' + attempt + '/' + attempts + ' failed: ' + error.message)
  }

  if (attempt < attempts) await sleep(delayMs)
}

console.error('[production-smoke] FAIL: production did not reach recurring 15/15 + deep acceptance 5/5.')
if (last) console.error(JSON.stringify(last, null, 2))
if (lastError) console.error('Last request error:', lastError)
process.exit(1)
