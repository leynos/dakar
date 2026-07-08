#!/usr/bin/env node
/**
 * @file Prepare and record Dakar code-review history.
 *
 * The helper keeps ODW workflow JavaScript free of filesystem and git imports.
 * It computes the next unreviewed commit range from git plus reviews.toml, then
 * appends a compact TOML review entry after the workflow completes.
 */

import { execFileSync } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { stdin } from 'node:process'

const APP_NAME = 'dakar'

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

function slug(input) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unknown'
}

function remoteOwnerName(remoteUrl) {
  const normalised = remoteUrl.trim()
  const scpLike = normalised.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/)
  if (!scpLike) {
    return { owner: 'unknown', name: 'unknown' }
  }
  return { owner: slug(scpLike[1]), name: slug(scpLike[2]) }
}

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

function stateFilePath({ stateRoot, owner, name, branchSlug }) {
  return join(stateRoot, APP_NAME, owner, name, branchSlug, 'reviews.toml')
}

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
 * Compute every commit that could serve as an incremental review base.
 *
 * A single `git rev-list --ancestry-path mergeBase..headCommit` yields exactly
 * the commits X for which `mergeBase` is an ancestor of X and X is an ancestor
 * of `headCommit` — the same predicate the previous per-entry
 * `merge-base --is-ancestor` probe tested, but in one subprocess instead of up
 * to 2N. `mergeBase` itself qualifies but is excluded by the exclusive range,
 * so it is added explicitly.
 *
 * @param {string} repoRoot - repository to query.
 * @param {string} mergeBase - lower bound of the reviewable range.
 * @param {string} headCommit - commit being reviewed.
 * @returns {Set<string>} full commit ids usable as a review base.
 */
function reachableReviewBases(repoRoot, mergeBase, headCommit) {
  const output = git(repoRoot, ['rev-list', '--ancestry-path', `${mergeBase}..${headCommit}`])
  const bases = new Set(output ? output.split('\n').filter(Boolean) : [])
  bases.add(mergeBase)
  return bases
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
  const matchesReachable = (head) =>
    reachableBases.has(head) ||
    [...reachableBases].some((sha) => sha.startsWith(head) || head.startsWith(sha))
  const lastReachable = [...reviewed].reverse().find((entry) => matchesReachable(entry.head))
  const reviewBase = lastReachable ? lastReachable.head : mergeBase
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
    lastReviewedHead: lastReachable ? lastReachable.head : '',
    commitCount: commits.length,
    commits,
    changedFiles: changedFiles(repoRoot, reviewBase, headCommit),
    diffStat: diffStat(repoRoot, reviewBase, headCommit),
    alreadyReviewed: commits.length === 0,
    warnings: lastReachable || reviewed.length === 0 ? [] : ['review history exists but no recorded head is usable for the current merge base; using merge base'],
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

/**
 * Run `mutate` while holding an exclusive lock on the state file.
 *
 * Serialises the read-modify-write in {@link appendReview} so a workflow record
 * step and a CLI recovery cannot interleave and clobber each other's entry. The
 * lock is an `O_EXCL` sentinel file next to the state file; contending writers
 * retry with a bounded backoff before failing loudly.
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
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      handle = openSync(lockPath, 'wx', 0o600)
      break
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error
      }
      sleepSync(20)
    }
  }
  if (handle === undefined) {
    throw new Error(`could not acquire review state lock at ${lockPath}`)
  }
  try {
    return mutate()
  } finally {
    closeSync(handle)
    try {
      unlinkSync(lockPath)
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error
      }
    }
  }
}

function tomlString(value) {
  return `"${String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`
}

function tomlStringArray(values) {
  return `[${(values || []).map((value) => tomlString(value)).join(', ')}]`
}

function fieldValue(input, ...keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      return input[key]
    }
  }
  return undefined
}

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
    writeFileSync(stateFile, `${current}${current && !current.endsWith('\n') ? '\n' : ''}${entry}`, {
      encoding: 'utf8',
      mode: 0o600,
    })
  })
  return { ok: true, stateFile, headCommit }
}

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

export { appendReview, parseReviewedHeads, prepare, remoteOwnerName, slug }
