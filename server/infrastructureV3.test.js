import test from 'node:test'
import assert from 'node:assert/strict'
import { parseBackupState, parseNaturalCommand } from './infrastructureV3.js'

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


test('V3 backup parser treats Failed: 0 as healthy', () => {
  const state = parseBackupState('Backup verification: 10/10 OK\nFailed: 0\nStale: 0')
  assert.equal(state.failure, false)
  assert.equal(state.stale, false)
  assert.equal(state.verified, 10)
  assert.equal(state.total, 10)
})

test('V3 backup parser never hides corruption behind Failed: 0', () => {
  const state = parseBackupState('Failed: 0\nCORRUPT backup detected')
  assert.equal(state.failure, true)
  assert.equal(state.corrupt, true)
})

test('V3 backup parser detects nonzero stale count', () => {
  const state = parseBackupState('Failed: 0\nStale: 2')
  assert.equal(state.failure, false)
  assert.equal(state.stale, true)
  assert.equal(state.staleCount, 2)
})

test('restart natural command requires explicit approval', () => {
  const plan = parseNaturalCommand('restart rumahin', apps)
  assert.equal(plan.command, 'restart')
  assert.equal(plan.app, 'rumahin')
  assert.equal(plan.mutating, true)
})
