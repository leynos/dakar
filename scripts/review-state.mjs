#!/usr/bin/env node
/**
 * @file Prepare and record Dakar code-review history.
 *
 * The helper keeps ODW workflow JavaScript free of filesystem and git imports.
 * It computes the next unreviewed commit range from git plus reviews.toml, then
 * appends a compact TOML review entry after the workflow completes.
 */

import { execFileSync } from 'node:child_process'
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { stdin } from 'node:process'

const APP_NAME = 'dakar'

/**
 * Parse a mixed positional/flag argument vector into a plain args object.
 *
 * Positional tokens are collected in `args._`; `--key value` pairs are stored
 * by key name. Flags without a following value throw.
 *
 * @param {string[]} argv - argument tokens to parse.
 * @returns {{ _: string[], [key: string]: string | string[] }} parsed args map.
 */
function parseArgs(argv) {
  const args = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      args._.push(token)
      continue
    }
    const key = token.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      throw new Error(`--${key} requires a value`)
    }
    args[key] = next
    index += 1
  }
  return args
}

/**
 * Extract a string value from a raw-args map, returning a fallback when absent.
 *
 * Throws when the key maps to `true` (i.e. the flag was given without a value).
 *
 * @param {object} rawArgs - the args map produced by `parseArgs`.
 * @param {string} key - the option key to look up.
 * @param {string} [fallback] - value to return when the key is absent or empty.
 * @returns {string} the resolved string value.
 */
function optionString(rawArgs, key, fallback = '') {
  const value = rawArgs[key]
  if (value === undefined || value === null || value === '') {
    return fallback
  }
  if (value === true) {
    throw new Error(`--${key} requires a value`)
  }
  return String(value)
}

/**
 * Run a git command in `repoRoot` and return its trimmed stdout.
 *
 * `allowFailure` is reserved for genuinely optional lookups where a non-zero
 * exit is an expected "absent" state rather than an environmental fault: a repo
 * with no `origin` remote, or a detached HEAD with no current branch. Range and
 * revision queries must leave `allowFailure` false so that broken repositories,
 * bad revisions, or permission errors surface instead of masquerading as an
 * empty result.
 *
 * @param {string} repoRoot - repository the command runs against.
 * @param {string[]} args - git arguments after the implicit `-C repoRoot`.
 * @param {boolean} [allowFailure] - tolerate a non-zero exit as empty output.
 * @returns {string} trimmed stdout, or an empty string when tolerated.
 */
function git(repoRoot, args, allowFailure = false) {
  try {
    return execFileSync('git', ['-C', repoRoot, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', allowFailure ? 'pipe' : 'inherit'],
    }).trim()
  } catch (error) {
    if (allowFailure) {
      return ''
    }
    throw error
  }
}

/**
 * Convert an arbitrary string into a lowercase URL/filename-safe slug.
 *
 * @param {string} input - the string to slugify.
 * @returns {string} slug composed of lowercase alphanumerics and hyphens, or `'unknown'`.
 */
function slug(input) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unknown'
}

/**
 * Extract the owner and repository name from a git remote URL.
 *
 * Handles both HTTPS and SCP-style SSH remote URLs. Returns `'unknown'` slugs
 * when the URL does not match the expected format.
 *
 * @param {string} remoteUrl - raw git remote URL.
 * @returns {{ owner: string, name: string }} slugified owner and repository name.
 */
function remoteOwnerName(remoteUrl) {
  const normalized = remoteUrl.trim()
  const scpLike = normalized.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/)
  if (!scpLike) {
    return { owner: 'unknown', name: 'unknown' }
  }
  return { owner: slug(scpLike[1]), name: slug(scpLike[2]) }
}

/**
 * Resolve the XDG state root directory, honouring an explicit override or the environment.
 *
 * @param {string} explicitRoot - caller-supplied override; empty string means use defaults.
 * @returns {string} absolute path to the XDG state root.
 */
function xdgStateRoot(explicitRoot) {
  if (explicitRoot) {
    return resolve(explicitRoot)
  }
  const envRoot = process.env.XDG_STATE_HOME
  if (envRoot && envRoot.startsWith('/')) {
    return envRoot
  }
  return join(homedir(), '.local', 'state')
}

/**
 * Compute the canonical `reviews.toml` path for a repository and branch.
 *
 * @param {object} opts - path components.
 * @param {string} opts.stateRoot - XDG state root directory.
 * @param {string} opts.owner - repository owner slug.
 * @param {string} opts.name - repository name slug.
 * @param {string} opts.branchSlug - branch slug.
 * @returns {string} absolute path to the `reviews.toml` state file.
 */
function stateFilePath({ stateRoot, owner, name, branchSlug }) {
  return join(stateRoot, APP_NAME, owner, name, branchSlug, 'reviews.toml')
}

/**
 * Parse completed review head commits from `reviews.toml` content.
 *
 * Only entries whose `status` is `'completed'` (or absent) contribute a head.
 *
 * @param {string} tomlText - raw TOML file content.
 * @returns {{ head: string, completedAt: string }[]} list of completed review entries.
 */
function parseReviewedHeads(tomlText) {
  const entries = []
  const chunks = tomlText.split(/\n(?=\[\[reviews\]\]\n)/u)
  for (const chunk of chunks) {
    const head = chunk.match(/^head_commit = "([0-9a-f]{7,40})"$/mu)
    const status = chunk.match(/^status = "([^"]+)"$/mu)
    const completedAt = chunk.match(/^completed_at = "([^"]+)"$/mu)
    if (head && (!status || status[1] === 'completed')) {
      entries.push({ head: head[1], completedAt: completedAt ? completedAt[1] : '' })
    }
  }
  return entries
}

/**
 * Resolve a recorded review head to one canonical reachable commit.
 *
 * Full commit ids match directly. Historical abbreviated ids remain usable
 * only when they identify exactly one commit on the current ancestry path.
 *
 * @param {Map<string, number>} reachableBases - canonical SHA to ancestry rank.
 * @param {string} recordedHead - full or abbreviated recorded commit id.
 * @returns {{ head: string, rank: number } | null} unique canonical match.
 */
function resolveReachableHead(reachableBases, recordedHead) {
  if (!/^[0-9a-f]{7,40}$/u.test(recordedHead)) {
    return null
  }
  if (reachableBases.has(recordedHead)) {
    return { head: recordedHead, rank: reachableBases.get(recordedHead) }
  }
  let match = null
  for (const [head, rank] of reachableBases) {
    if (!head.startsWith(recordedHead)) {
      continue
    }
    if (match !== null) {
      return null
    }
    match = { head, rank }
  }
  return match
}

/**
 * Rank every commit that could serve as an incremental review base.
 *
 * A single `git rev-list --ancestry-path mergeBase..headCommit` yields exactly
 * the commits X for which `mergeBase` is an ancestor of X and X is an ancestor
 * of `headCommit` — the same predicate the previous per-entry
 * `merge-base --is-ancestor` probe tested, but in one subprocess instead of up
 * to 2N. `git rev-list` emits newest-first, so the returned rank orders bases by
 * ancestry position: rank 0 is the commit closest to `headCommit` (the furthest
 * a base may advance), and larger ranks are progressively closer to the merge
 * base. `mergeBase` itself qualifies but is excluded by the exclusive range, so
 * it is added explicitly as the highest-ranked (fallback) base.
 *
 * @param {string} repoRoot - repository to query.
 * @param {string} mergeBase - lower bound of the reviewable range.
 * @param {string} headCommit - commit being reviewed.
 * @returns {Map<string, number>} commit id to ancestry rank (0 = nearest HEAD).
 */
function reachableReviewBases(repoRoot, mergeBase, headCommit) {
  const output = git(repoRoot, ['rev-list', '--ancestry-path', `${mergeBase}..${headCommit}`])
  const ordered = output ? output.split('\n').filter(Boolean) : []
  const rankByCommit = new Map()
  ordered.forEach((commit, index) => rankByCommit.set(commit, index))
  if (!rankByCommit.has(mergeBase)) {
    rankByCommit.set(mergeBase, ordered.length)
  }
  return rankByCommit
}

/**
 * List commits in `baseCommit..headCommit` oldest-first.
 * @returns {string[]} commit ids in review order.
 */
function commitList(repoRoot, baseCommit, headCommit) {
  const output = git(repoRoot, ['rev-list', '--reverse', `${baseCommit}..${headCommit}`])
  return output ? output.split('\n').filter(Boolean) : []
}

/**
 * List files changed across `baseCommit..headCommit`, sorted for stable output.
 * @returns {string[]} changed file paths.
 */
function changedFiles(repoRoot, baseCommit, headCommit) {
  const output = git(repoRoot, ['diff', '--name-only', `${baseCommit}..${headCommit}`])
  return output ? output.split('\n').filter(Boolean).sort() : []
}

/**
 * Return git's shortstat summary for `baseCommit..headCommit`.
 * @returns {string} shortstat line, or empty when nothing changed.
 */
function diffStat(repoRoot, baseCommit, headCommit) {
  return git(repoRoot, ['diff', '--shortstat', `${baseCommit}..${headCommit}`])
}

/**
 * Compute the next unreviewed commit range for a repository.
 *
 * Reads prior review heads from the XDG state file, advances the review base to
 * the most recently recorded head that still lies on the current merge-base to
 * HEAD ancestry path, and returns the resulting range, changed files, and
 * bookkeeping. The raw remote URL is intentionally not returned: it can embed
 * credentials, so only the derived owner/name reach the output.
 *
 * @param {Record<string, string>} rawArgs - parsed CLI arguments.
 * @returns {object} review-range descriptor consumed by the workflow.
 */
function prepare(rawArgs) {
  const repoRoot = resolve(optionString(rawArgs, 'repo-root', process.cwd()))
  const remoteUrl = git(repoRoot, ['remote', 'get-url', 'origin'], true)
  const { owner, name } = remoteOwnerName(remoteUrl)
  const branch = git(repoRoot, ['branch', '--show-current'], true) || 'detached'
  const branchSlug = slug(optionString(rawArgs, 'branch', branch))
  const stateRoot = xdgStateRoot(optionString(rawArgs, 'state-root'))
  const stateFile = rawArgs['state-file']
    ? resolve(optionString(rawArgs, 'state-file'))
    : stateFilePath({ stateRoot, owner, name, branchSlug })
  const headRef = optionString(rawArgs, 'head', 'HEAD')
  const baseRef = optionString(rawArgs, 'base', 'origin/main')
  const headCommit = git(repoRoot, ['rev-parse', headRef])
  const mergeBase = git(repoRoot, ['merge-base', baseRef, headCommit], true)
  if (!mergeBase) {
    throw new Error(`could not determine merge base for ${baseRef} and ${headCommit}`)
  }
  const existing = readFile(stateFile)
  const reviewed = parseReviewedHeads(existing)
  const reachableBases = reachableReviewBases(repoRoot, mergeBase, headCommit)
  // Advance the review base to the recorded head that is furthest along the
  // ancestry path (smallest rank = closest to HEAD), independent of the order
  // in which reviews happened to be recorded. mergeBase remains the fallback.
  let furthestReachable = null
  for (const entry of reviewed) {
    const resolvedHead = resolveReachableHead(reachableBases, entry.head)
    if (resolvedHead && (furthestReachable === null || resolvedHead.rank < furthestReachable.rank)) {
      furthestReachable = resolvedHead
    }
  }
  const reviewBase = furthestReachable ? furthestReachable.head : mergeBase
  const commits = commitList(repoRoot, reviewBase, headCommit)

  return {
    ok: true,
    repo: { owner, name, branch, branchSlug },
    stateFile,
    baseRef,
    headRef,
    mergeBase,
    reviewBase,
    headCommit,
    lastReviewedHead: furthestReachable ? furthestReachable.head : '',
    commitCount: commits.length,
    commits,
    changedFiles: changedFiles(repoRoot, reviewBase, headCommit),
    diffStat: diffStat(repoRoot, reviewBase, headCommit),
    alreadyReviewed: commits.length === 0,
    warnings: furthestReachable || reviewed.length === 0 ? [] : ['review history exists but no recorded head is usable for the current merge base; using merge base'],
  }
}

/**
 * Read a state file, treating only a missing file as empty history.
 *
 * A missing `reviews.toml` is the normal first-run case and yields an empty
 * string. Any other error (permission denied, I/O fault, a directory in the
 * path) is a real problem that must surface rather than silently replaying the
 * whole history as unreviewed.
 *
 * @param {string} path - state file to read.
 * @returns {string} file contents, or empty string when absent.
 */
function readFile(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') {
      return ''
    }
    throw error
  }
}

/**
 * Block synchronously for `milliseconds` without reading a wall clock.
 *
 * Uses `Atomics.wait` on a throwaway buffer so lock retry timing stays
 * deterministic and free of `Date.now()`/`Math.random()`.
 *
 * @param {number} milliseconds - duration to block.
 */
function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

// A lock older than this is treated as abandoned by a terminated process. The
// critical section is a small read-modify-write measured in milliseconds, so a
// generous threshold reaps dead locks without ever reaping a live holder.
const STALE_LOCK_MS = 30_000

/**
 * Extract the owner process id from a lock sentinel.
 *
 * @param {string} marker - lock sentinel contents.
 * @returns {number | null} positive owner pid, or null for an invalid marker.
 */
function lockOwnerPid(marker) {
  const match = String(marker).match(/^(\d+)\s+/u)
  if (!match) {
    return null
  }
  const pid = Number(match[1])
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null
}

/**
 * Check whether a process id still names a live process.
 *
 * Permission failures are treated as evidence of a live process. Unknown
 * errors also fail safe so Dakar never reaps a lock it cannot prove abandoned.
 *
 * @param {number} pid - process id to probe.
 * @returns {boolean} true unless the operating system reports no such process.
 */
function processIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code !== 'ESRCH'
  }
}

/**
 * Reap a review-state lock left behind by a terminated process.
 *
 * A lock younger than {@link STALE_LOCK_MS} is considered live and left intact.
 * A stale or already-vanished lock is removed so acquisition can proceed.
 *
 * @param {string} lockPath - path to the lock sentinel file.
 * @param {object} [operations] - injectable filesystem and clock operations.
 * @param {typeof statSync} [operations.stat] - lock stat operation.
 * @param {typeof unlinkSync} [operations.unlink] - lock unlink operation.
 * @param {typeof readFileSync} [operations.read] - lock marker read operation.
 * @param {() => number} [operations.now] - current time in milliseconds.
 * @param {(pid: number) => boolean} [operations.ownerAlive] - owner liveness probe.
 * @returns {boolean} true if the caller should retry acquisition immediately.
 */
function reapStaleLock(
  lockPath,
  { stat = statSync, unlink = unlinkSync, read = readFileSync, now = Date.now, ownerAlive = processIsAlive } = {},
) {
  let stats
  try {
    stats = stat(lockPath)
  } catch (error) {
    if (error.code === 'ENOENT') {
      return true
    }
    throw error
  }
  if (now() - stats.mtimeMs < STALE_LOCK_MS) {
    return false
  }
  let marker
  try {
    marker = read(lockPath, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') {
      return true
    }
    return false
  }
  const ownerPid = lockOwnerPid(marker)
  if (ownerPid === null || ownerAlive(ownerPid)) {
    return false
  }
  let freshMarker
  try {
    freshMarker = read(lockPath, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') {
      return true
    }
    return false
  }
  let freshStats
  try {
    freshStats = stat(lockPath)
  } catch (error) {
    if (error.code === 'ENOENT') {
      return true
    }
    throw error
  }
  if (
    freshStats.dev !== stats.dev ||
    freshStats.ino !== stats.ino ||
    freshStats.mtimeMs !== stats.mtimeMs ||
    freshMarker !== marker ||
    now() - freshStats.mtimeMs < STALE_LOCK_MS
  ) {
    return false
  }
  try {
    unlink(lockPath)
  } catch (error) {
    if (error.code !== 'ENOENT') {
      return false
    }
  }
  return true
}

/**
 * Release a lock only while the path still identifies this holder's sentinel.
 *
 * @param {string} lockPath - path to the lock sentinel file.
 * @param {string} marker - unique marker written by this holder.
 * @param {{ dev: number, ino: number }} ownedStats - identity of the opened lock.
 * @param {boolean} markerWritten - whether writing the unique marker succeeded.
 */
function releaseOwnedLock(lockPath, marker, ownedStats, markerWritten) {
  try {
    const currentMarker = readFileSync(lockPath, 'utf8')
    const currentStats = statSync(lockPath)
    if (
      currentStats.dev !== ownedStats.dev ||
      currentStats.ino !== ownedStats.ino ||
      (markerWritten && currentMarker !== marker)
    ) {
      return
    }
    unlinkSync(lockPath)
  } catch {
    // A vanished or replaced lock already belongs to nobody or another holder.
  }
}

/**
 * Run `mutate` while holding an exclusive lock on the state file.
 *
 * Serializes the read-modify-write in {@link appendReview} so a workflow record
 * step and a CLI recovery cannot interleave and clobber each other's entry. The
 * lock is an `O_EXCL` sentinel file next to the state file recording the owner
 * pid, a unique acquisition token, and timestamp; contending writers reap a
 * stale lock only after its owner exits (see
 * {@link reapStaleLock}) or wait with a bounded backoff before failing loudly.
 * Lock release is best-effort and never masks the outcome of `mutate`: a
 * successful write is still returned, and a failing write still throws its own
 * error, even if closing or unlinking the lock fails.
 *
 * @template T
 * @param {string} stateFile - state file being guarded.
 * @param {() => T} mutate - critical section to run under the lock.
 * @returns {T} whatever `mutate` returns.
 */
function withStateLock(stateFile, mutate) {
  const lockPath = `${stateFile}.lock`
  const maxAttempts = 100
  let handle
  for (let attempt = 0; attempt < maxAttempts && handle === undefined; attempt += 1) {
    try {
      handle = openSync(lockPath, 'wx', 0o600)
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error
      }
      // Reap a lock abandoned by a dead process; otherwise wait and retry.
      if (!reapStaleLock(lockPath)) {
        sleepSync(20)
      }
    }
  }
  if (handle === undefined) {
    throw new Error(`could not acquire review state lock at ${lockPath}`)
  }
  const marker = `${process.pid} ${process.hrtime.bigint().toString(36)} ${new Date().toISOString()}\n`
  const ownedStats = fstatSync(handle)
  let markerWritten = false
  try {
    // Record a unique owner identity for liveness checks and safe release;
    // failure to write this diagnostic marker must not fail the mutation.
    writeSync(handle, marker)
    markerWritten = true
  } catch {
    // Diagnostics only.
  }
  let result
  let failure
  let failed = false
  try {
    result = mutate()
  } catch (error) {
    failure = error
    failed = true
  }
  // Best-effort release that never obscures the mutate outcome.
  try {
    closeSync(handle)
  } catch {
    // The write above already reached disk; a failed close cannot lose it.
  }
  releaseOwnedLock(lockPath, marker, ownedStats, markerWritten)
  if (failed) {
    throw failure
  }
  return result
}

/**
 * Encode a value as a TOML basic string literal (double-quoted, with escapes).
 *
 * @param {unknown} value - value to encode; coerced to string via `String()`.
 * @returns {string} TOML-quoted string including surrounding double quotes.
 */
function tomlString(value) {
  return `"${String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`
}

/**
 * Encode an array of values as a TOML inline array of basic strings.
 *
 * @param {unknown[]} [values] - items to encode; each is passed through `tomlString`.
 * @returns {string} TOML inline array literal, e.g. `["a", "b"]`.
 */
function tomlStringArray(values) {
  return `[${(values || []).map((value) => tomlString(value)).join(', ')}]`
}

/**
 * Return the value of the first matching own-property key found on `input`.
 *
 * Supports camelCase/snake_case aliases: the first key present wins.
 *
 * @param {object} input - object to inspect.
 * @param {...string} keys - candidate property names in priority order.
 * @returns {unknown} the first matching value, or `undefined` when none match.
 */
function fieldValue(input, ...keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      return input[key]
    }
  }
  return undefined
}

/**
 * Extract and validate the `headCommit` field from a record-input object.
 *
 * Accepts both `headCommit` (camelCase) and `head_commit` (snake_case) keys.
 * Throws when the value is absent or not a 7–40 character hexadecimal string.
 *
 * @param {object} input - record input object.
 * @returns {string} normalized lowercase commit id.
 */
function reviewHeadCommit(input) {
  const value = fieldValue(input, 'headCommit', 'head_commit')
  const text = String(value ?? '').trim()
  if (!text) {
    throw new Error('record input must include a non-empty headCommit')
  }
  if (!/^[0-9a-f]{7,40}$/iu.test(text)) {
    throw new Error('record input headCommit must be a 7-40 character hexadecimal commit id')
  }
  return text.toLowerCase()
}

/**
 * Extract and validate a non-negative integer field from a record-input object.
 *
 * Accepts both camelCase and snake_case variants of the key name.
 *
 * @param {object} input - record input object.
 * @param {string} camelKey - preferred camelCase property name.
 * @param {string} snakeKey - snake_case alias to fall back to.
 * @returns {number} the validated non-negative integer value.
 */
function integerField(input, camelKey, snakeKey) {
  const rawValue = fieldValue(input, camelKey, snakeKey)
  if (rawValue === undefined || rawValue === null || rawValue === '') {
    throw new Error(`record input must include ${camelKey} as a non-negative integer`)
  }
  const value = Number(rawValue)
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`record input ${camelKey} must be a non-negative integer`)
  }
  return value
}

/**
 * Append a completed review entry to the `reviews.toml` state file.
 *
 * Creates the parent directories if absent, then atomically appends a
 * `[[reviews]]` TOML block under an exclusive file lock. Accepts both camelCase
 * and snake_case field names for interoperability with the ODW workflow.
 *
 * @param {object} input - record input; must include `stateFile`, `headCommit`, `commitCount`, and `findingsTotal`.
 * @returns {{ ok: boolean, stateFile: string, headCommit: string }} confirmation of the recorded entry.
 */
function appendReview(input) {
  const rawStateFile = input.stateFile || input.state_file
  if (!rawStateFile) {
    throw new Error('record input must include stateFile')
  }
  const headCommit = reviewHeadCommit(input)
  const commitCount = integerField(input, 'commitCount', 'commit_count')
  const findingsTotal = integerField(input, 'findingsTotal', 'findings_total')
  const stateFile = resolve(String(rawStateFile))
  mkdirSync(dirname(stateFile), { recursive: true, mode: 0o700 })
  const now = new Date().toISOString()
  const entry = [
    '[[reviews]]',
    `review_id = ${tomlString(input.reviewId || input.review_id || now)}`,
    `status = ${tomlString(input.status || 'completed')}`,
    `started_at = ${tomlString(input.startedAt || input.started_at || '')}`,
    `completed_at = ${tomlString(input.completedAt || input.completed_at || now)}`,
    `base_commit = ${tomlString(input.baseCommit || input.base_commit || '')}`,
    `head_commit = ${tomlString(headCommit)}`,
    `commit_count = ${commitCount}`,
    `changed_files = ${tomlStringArray(input.changedFiles || input.changed_files || [])}`,
    `models = ${tomlStringArray(input.models || [])}`,
    `findings_total = ${findingsTotal}`,
    `summary = ${tomlString(input.summary || '')}`,
    `metrics_json = ${tomlString(JSON.stringify(input.metrics || {}))}`,
    '',
  ].join('\n')
  withStateLock(stateFile, () => {
    const current = readFile(stateFile)
    if (parseReviewedHeads(current).some((entry) => entry.head === headCommit)) {
      return
    }
    writeFileSync(stateFile, `${current}${current && !current.endsWith('\n') ? '\n' : ''}${entry}`, {
      encoding: 'utf8',
      mode: 0o600,
    })
  })
  return { ok: true, stateFile, headCommit }
}

/**
 * Read all of stdin and parse it as JSON.
 *
 * @returns {Promise<unknown>} the parsed JSON value.
 */
async function readStdinJson() {
  const chunks = []
  for await (const chunk of stdin) {
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) {
    throw new Error('record expects JSON on stdin')
  }
  return JSON.parse(text)
}

/**
 * CLI entry point: dispatch `prepare` or `record` sub-commands and print JSON results.
 *
 * @returns {Promise<void>}
 */
async function main() {
  const [command, ...rest] = process.argv.slice(2)
  const rawArgs = parseArgs(rest)
  if (command === 'prepare') {
    console.log(JSON.stringify(prepare(rawArgs), null, 2))
    return
  }
  if (command === 'record') {
    console.log(JSON.stringify(appendReview(await readStdinJson()), null, 2))
    return
  }
  throw new Error('usage: review-state.mjs prepare|record [--repo-root DIR] [--state-root DIR]')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}

export {
  appendReview,
  parseReviewedHeads,
  prepare,
  reapStaleLock,
  remoteOwnerName,
  resolveReachableHead,
  slug,
  withStateLock,
}
