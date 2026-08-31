import test from 'node:test'
import assert from 'node:assert/strict'
import { parseNaturalCommand } from './infrastructureV3.js'

const apps = ['rumahin','tagihin','sajiin']

test('natural command maps safe read-only server status', () => {
  const plan = parseNaturalCommand('cek kondisi server', apps)
  assert.equal(plan.intent, 'status')
  assert.equal(plan.command, 'status')
  assert.equal(plan.mutating, false)
})

test('natural command maps app deployment with approval', () => {
  const plan = parseNaturalCommand('deploy rumahin', apps)
  assert.equal(plan.intent, 'deploy-app')
  assert.equal(plan.command, 'deploy')
  assert.equal(plan.app, 'rumahin')
  assert.equal(plan.mutating, true)
})

test('natural command maps backup all', () => {
  const plan = parseNaturalCommand('backup semua aplikasi', apps)
  assert.equal(plan.intent, 'backup-all')
  assert.equal(plan.command, 'backup')
  assert.equal(plan.mutating, true)
})

test('unknown natural command is not executable', () => {
  const plan = parseNaturalCommand('hapus semuanya sekarang', apps)
  assert.equal(plan.intent, 'unknown')
  assert.equal(plan.command, null)
  assert.equal(plan.mutating, false)
})
