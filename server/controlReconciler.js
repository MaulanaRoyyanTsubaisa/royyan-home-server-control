import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const APP_DIR = process.env.CONTROL_APP_DIR || '/srv/hermes-workspace/repos/royyan-home-server-control'
const QUEUE_SAFE = process.env.CONTROL_QUEUE_SAFE || '/usr/local/bin/hermes-control-queue-safe'
const REMOTE = process.env.CONTROL_GIT_REMOTE || 'origin'
const BRANCH = process.env.GITHUB_BRANCH || 'main'

let state = {
  enabled: true,
  status: 'starting',
  localHead: null,
  remoteHead: null,
  mismatch: false,
  lastCheck: null,
  lastQueue: null,
  lastError: null
}
let busy = false
let lastQueuedRemote = null

function short(sha) {
  return typeof sha === 'string' ? sha.trim().slice(0, 12) : null
}

async function git(args, timeout = 15000) {
  const { stdout } = await execFileAsync('git', args, {
    cwd: APP_DIR,
    timeout,
    maxBuffer: 512 * 1024,
    env: {
      ...process.env,
      PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
    }
  })
  return String(stdout || '').trim()
}

export function getControlReconcilerState() {
  return state
}

export function scheduleControlReconciler() {
  const check = async () => {
    if (busy) return
    busy = true
    try {
      const localHead = await git(['rev-parse', 'HEAD'])
      const remoteLine = await git(['ls-remote', REMOTE, 'refs/heads/' + BRANCH], 30000)
      const remoteHead = remoteLine.split(/\s+/)[0] || ''
      const mismatch = Boolean(localHead && remoteHead && localHead !== remoteHead)

      state = {
        ...state,
        status: mismatch ? 'behind-main' : 'in-sync',
        localHead: short(localHead),
        remoteHead: short(remoteHead),
        mismatch,
        lastCheck: new Date().toISOString(),
        lastError: null
      }

      if (mismatch && remoteHead !== lastQueuedRemote) {
        await execFileAsync(QUEUE_SAFE, [], {
          timeout: 15000,
          maxBuffer: 256 * 1024,
          env: {
            ...process.env,
            PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
          }
        })
        lastQueuedRemote = remoteHead
        state = {
          ...state,
          status: 'reconcile-queued',
          lastQueue: new Date().toISOString()
        }
      }
    } catch (error) {
      state = {
        ...state,
        status: 'error',
        lastCheck: new Date().toISOString(),
        lastError: String(error.message || error).slice(0, 300)
      }
    } finally {
      busy = false
    }
  }

  const first = setTimeout(() => check().catch(() => {}), 45000)
  first.unref?.()
  const interval = setInterval(() => check().catch(() => {}), 2 * 60 * 1000)
  interval.unref?.()
}
