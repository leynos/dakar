/**
 * @file Prove the review-state helper surfaces environmental faults and
 * serialises concurrent recorders.
 *
 * These tests cover the failure-handling contract that separates an expected
 * "missing history" state from a real I/O or git error, and the single-writer
 * lock that keeps concurrent `record` calls from clobbering each other's entry.
 */

import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { prepare, reapStaleLock, withStateLock } from '../scripts/review-state.mjs'

const SCRIPT = new URL('../scripts/review-state.mjs', import.meta.url).pathname
const DEAD_LOCK_MARKER = '999999 dead-owner 2026-01-01T00:00:00.000Z\n'

function stateDir() {
  return mkdtempSync(join(tmpdir(), 'dakar-state-'))
}

test('prepare rethrows non-ENOENT state-file read errors instead of replaying history', () => {
  // A directory where the state file is expected yields EISDIR on read. A silent
  // empty-string fallback here would make prepare re-review the whole history.
  const root = stateDir()
  const stateFile = join(root, 'reviews.toml')
  mkdirSync(stateFile, { recursive: true })

  assert.throws(
    () => prepare({ 'repo-root': process.cwd(), 'state-file': stateFile, base: 'HEAD', head: 'HEAD' }),
    (error) => error.code === 'EISDIR' || /EISDIR|illegal operation on a directory/u.test(error.message),
  )
})

test('prepare surfaces git failures on a non-repository root', () => {
  // rev-parse HEAD is not tolerated, so a directory that is not a git repo must
  // raise rather than yield an empty, falsely "already reviewed" range.
  const notARepo = mkdtempSync(join(tmpdir(), 'dakar-not-a-repo-'))
  const root = stateDir()

  assert.throws(() =>
    prepare({ 'repo-root': notARepo, 'state-root': root, base: 'origin/main', head: 'HEAD' }),
  )
})

function recordChild(stateFile, headCommit) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [SCRIPT, 'record'], {
      stdio: ['pipe', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (data) => {
      stderr += data
    })
    child.on('error', rejectPromise)
    child.on('close', (code) => {
      if (code === 0) {
        resolvePromise()
      } else {
        rejectPromise(new Error(`record exited ${code}: ${stderr}`))
      }
    })
    child.stdin.end(
      JSON.stringify({
        stateFile,
        reviewId: `review-${headCommit}`,
        headCommit,
        commitCount: 1,
        findingsTotal: 0,
        summary: 'concurrent write',
      }),
    )
  })
}

test('concurrent record writes all persist under the state lock', async () => {
  const stateFile = join(stateDir(), 'reviews.toml')
  const heads = Array.from({ length: 8 }, (_, index) => `${'0'.repeat(39)}${(index + 1).toString(16)}`)

  await Promise.all(heads.map((head) => recordChild(stateFile, head)))

  const content = readFileSync(stateFile, 'utf8')
  const entryCount = (content.match(/\[\[reviews\]\]/gu) || []).length
  assert.equal(entryCount, heads.length)
  for (const head of heads) {
    assert.ok(content.includes(`head_commit = "${head}"`), `missing entry for ${head}`)
  }
})

test('a pre-existing state file without a trailing newline stays well-formed after recording', async () => {
  const stateFile = join(stateDir(), 'reviews.toml')
  writeFileSync(stateFile, '[[reviews]]\nhead_commit = "abcabcabcabcabcabcabcabcabcabcabcabcabca"', 'utf8')

  await recordChild(stateFile, `${'0'.repeat(39)}f`)

  const content = readFileSync(stateFile, 'utf8')
  assert.equal((content.match(/\[\[reviews\]\]/gu) || []).length, 2)
  assert.match(content, /abca"\n\[\[reviews\]\]/u)
})

test('withStateLock returns the mutate result and releases the lock', () => {
  const stateFile = join(stateDir(), 'reviews.toml')
  mkdirSync(dirname(stateFile), { recursive: true })

  const value = withStateLock(stateFile, () => 'done')

  assert.equal(value, 'done')
  assert.equal(existsSync(`${stateFile}.lock`), false)
})

test('withStateLock rethrows the mutate error and still releases the lock', () => {
  const stateFile = join(stateDir(), 'reviews.toml')
  mkdirSync(dirname(stateFile), { recursive: true })
  const boom = new Error('mutate boom')

  assert.throws(
    () =>
      withStateLock(stateFile, () => {
        throw boom
      }),
    /mutate boom/u,
  )
  assert.equal(existsSync(`${stateFile}.lock`), false)
})

test('withStateLock does not mask a successful write when lock cleanup fails', () => {
  const stateFile = join(stateDir(), 'reviews.toml')
  const lockPath = `${stateFile}.lock`
  mkdirSync(dirname(stateFile), { recursive: true })

  // Replace the lock file with a directory during the critical section so the
  // release-time unlink fails. The successful result must still be returned.
  const value = withStateLock(stateFile, () => {
    rmSync(lockPath)
    mkdirSync(lockPath)
    return 'kept'
  })

  assert.equal(value, 'kept')
  rmSync(lockPath, { recursive: true, force: true })
})

test('withStateLock reaps a stale lock left by a terminated process', () => {
  const stateFile = join(stateDir(), 'reviews.toml')
  const lockPath = `${stateFile}.lock`
  mkdirSync(dirname(stateFile), { recursive: true })
  writeFileSync(lockPath, DEAD_LOCK_MARKER)
  // Backdate the lock well beyond the staleness threshold (seconds since epoch).
  const stale = Date.now() / 1000 - 120
  utimesSync(lockPath, stale, stale)

  const value = withStateLock(stateFile, () => 'recovered')

  assert.equal(value, 'recovered')
  assert.equal(existsSync(lockPath), false)
})

test('withStateLock preserves a fresh lock it does not own', () => {
  const stateFile = join(stateDir(), 'reviews.toml')
  const lockPath = `${stateFile}.lock`
  mkdirSync(dirname(stateFile), { recursive: true })
  writeFileSync(lockPath, `${process.pid} fresh\n`)

  // A recently touched lock must not be reaped; acquisition fails after the
  // bounded backoff and the other holder's lock is left intact.
  assert.throws(() => withStateLock(stateFile, () => 'should not run'), /could not acquire/u)
  assert.equal(existsSync(lockPath), true)
  rmSync(lockPath, { force: true })
})

test('withStateLock preserves an old live lock and its replacement', () => {
  const stateRoot = stateDir()
  const stateFile = join(stateRoot, 'dakar', 'acme', 'widget', 'feature-locking', 'reviews.toml')
  const lockPath = `${stateFile}.lock`
  const completedHead = 'd'.repeat(40)
  const replacementMarker = `${process.pid} replacement-owner 2026-01-01T00:00:00.000Z\n`
  mkdirSync(dirname(stateFile), { recursive: true })
  writeFileSync(stateFile, `[[reviews]]\nhead_commit = "${completedHead}"\nstatus = "completed"\n`)

  const value = withStateLock(stateFile, () => {
    const stale = Date.now() / 1000 - 120
    utimesSync(lockPath, stale, stale)
    let competitorEntered = false

    assert.throws(
      () =>
        withStateLock(stateFile, () => {
          competitorEntered = true
        }),
      /could not acquire/u,
    )
    assert.equal(competitorEntered, false)

    rmSync(lockPath)
    writeFileSync(lockPath, replacementMarker)
    return 'original-holder-completed'
  })

  assert.equal(value, 'original-holder-completed')
  assert.equal(readFileSync(lockPath, 'utf8'), replacementMarker)
  assert.match(readFileSync(stateFile, 'utf8'), new RegExp(`head_commit = "${completedHead}"`, 'u'))
  rmSync(lockPath, { force: true })
})

test('reapStaleLock preserves a replacement lock', () => {
  const stale = { dev: 1, ino: 2, mtimeMs: 1_000 }
  const replacement = { dev: 1, ino: 3, mtimeMs: 1_000 }
  let statCalls = 0
  let unlinked = false

  const retry = reapStaleLock('/state.lock', {
    now: () => 60_000,
    ownerAlive: () => false,
    read: () => DEAD_LOCK_MARKER,
    stat: () => [stale, replacement][statCalls++],
    unlink: () => {
      unlinked = true
    },
  })

  assert.equal(retry, false)
  assert.equal(unlinked, false)
})

test('reapStaleLock preserves a lock refreshed before unlink', () => {
  const stale = { dev: 1, ino: 2, mtimeMs: 1_000 }
  const refreshed = { ...stale, mtimeMs: 50_000 }
  let statCalls = 0
  let unlinked = false

  const retry = reapStaleLock('/state.lock', {
    now: () => 60_000,
    ownerAlive: () => false,
    read: () => DEAD_LOCK_MARKER,
    stat: () => [stale, refreshed][statCalls++],
    unlink: () => {
      unlinked = true
    },
  })

  assert.equal(retry, false)
  assert.equal(unlinked, false)
})

test('reapStaleLock retries when the stale lock vanishes before the second stat', () => {
  const stale = { dev: 1, ino: 2, mtimeMs: 1_000 }
  let statCalls = 0

  const retry = reapStaleLock('/state.lock', {
    now: () => 60_000,
    ownerAlive: () => false,
    read: () => DEAD_LOCK_MARKER,
    stat: () => {
      statCalls += 1
      if (statCalls === 1) return stale
      throw Object.assign(new Error('vanished'), { code: 'ENOENT' })
    },
  })

  assert.equal(retry, true)
})

test('reapStaleLock retries when the stale lock vanishes during unlink', () => {
  const stale = { dev: 1, ino: 2, mtimeMs: 1_000 }

  const retry = reapStaleLock('/state.lock', {
    now: () => 60_000,
    ownerAlive: () => false,
    read: () => DEAD_LOCK_MARKER,
    stat: () => stale,
    unlink: () => {
      throw Object.assign(new Error('vanished'), { code: 'ENOENT' })
    },
  })

  assert.equal(retry, true)
})
