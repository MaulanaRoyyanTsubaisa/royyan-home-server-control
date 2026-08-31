import test from 'node:test'
import assert from 'node:assert/strict'
import { backupSummary, healthHint } from './controlPlaneV2.js'

test('backupSummary does not treat Failed: 0 as a failure', () => {
  const parsed = backupSummary('Backup verification: 10/10 OK\n✅ Verified: 10\n❌ Failed: 0\nStale: 0')
  assert.equal(parsed.verified, 10)
  assert.equal(parsed.total, 10)
  assert.equal(parsed.failedCount, 0)
  assert.equal(parsed.failure, false)
  assert.equal(parsed.stale, false)
})

test('backupSummary detects nonzero failure and stale counts', () => {
  const parsed = backupSummary('Verified: 8\nFailed: 2\nStale: 1')
  assert.equal(parsed.verified, 8)
  assert.equal(parsed.failedCount, 2)
  assert.equal(parsed.failure, true)
  assert.equal(parsed.staleCount, 1)
  assert.equal(parsed.stale, true)
})

test('backupSummary detects textual corruption without a numeric counter', () => {
  const parsed = backupSummary('backup CORRUPT or INVALID')
  assert.equal(parsed.failure, true)
})

test('healthHint maps a Hermes app line conservatively', () => {
  assert.equal(healthHint('✅ rumahin healthy\n✅ tagihin healthy', 'rumahin'), 'healthy')
  assert.equal(healthHint('❌ rumahin unhealthy', 'rumahin'), 'unhealthy')
  assert.equal(healthHint('rumahin state pending', 'rumahin'), 'unknown')
  assert.equal(healthHint('✅ tagihin healthy', 'rumahin'), null)
})
