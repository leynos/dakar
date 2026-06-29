#!/usr/bin/env node
/**
 * Prepare and record Dakar code-review history.
 *
 * The helper keeps ODW workflow JavaScript free of filesystem and git imports.
 * It computes the next unreviewed commit range from git plus reviews.toml, then
 * appends a compact TOML review entry after the workflow completes.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
      args[key] = true
      continue
    }
    args[key] = next
    index += 1
  }
  return args
}

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

function isAncestor(repoRoot, ancestor, descendant) {
  if (!ancestor || !descendant) {
    return false
  }
  try {
    execFileSync('git', ['-C', repoRoot, 'merge-base', '--is-ancestor', ancestor, descendant], {
      stdio: 'ignore',
    })
    return true
  } catch {
    return false
  }
}

function commitList(repoRoot, baseCommit, headCommit) {
  const output = git(repoRoot, ['rev-list', '--reverse', `${baseCommit}..${headCommit}`], true)
  return output ? output.split('\n').filter(Boolean) : []
}

function changedFiles(repoRoot, baseCommit, headCommit) {
  const output = git(repoRoot, ['diff', '--name-only', `${baseCommit}..${headCommit}`], true)
  return output ? output.split('\n').filter(Boolean).sort() : []
}

function diffStat(repoRoot, baseCommit, headCommit) {
  return git(repoRoot, ['diff', '--shortstat', `${baseCommit}..${headCommit}`], true)
}

function prepare(rawArgs) {
  const repoRoot = resolve(String(rawArgs['repo-root'] || process.cwd()))
  const remoteUrl = git(repoRoot, ['remote', 'get-url', 'origin'], true)
  const { owner, name } = remoteOwnerName(remoteUrl)
  const branch = git(repoRoot, ['branch', '--show-current'], true) || 'detached'
  const branchSlug = slug(String(rawArgs.branch || branch))
  const stateRoot = xdgStateRoot(rawArgs['state-root'])
  const stateFile = rawArgs['state-file']
    ? resolve(String(rawArgs['state-file']))
    : stateFilePath({ stateRoot, owner, name, branchSlug })
  const headRef = String(rawArgs.head || 'HEAD')
  const baseRef = String(rawArgs.base || 'origin/main')
  const headCommit = git(repoRoot, ['rev-parse', headRef])
  const mergeBase = git(repoRoot, ['merge-base', baseRef, headCommit], true) || git(repoRoot, ['rev-parse', `${headCommit}^`], true)
  const existing = readFile(stateFile)
  const reviewed = parseReviewedHeads(existing)
  const lastReachable = [...reviewed].reverse().find((entry) => isAncestor(repoRoot, entry.head, headCommit))
  const reviewBase = lastReachable ? lastReachable.head : mergeBase
  const commits = commitList(repoRoot, reviewBase, headCommit)

  return {
    ok: true,
    repo: { owner, name, remoteUrl, branch, branchSlug },
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
    warnings: lastReachable || reviewed.length === 0 ? [] : ['review history exists but no recorded head is an ancestor of HEAD; using merge base'],
  }
}

function readFile(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

function tomlString(value) {
  return `"${String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`
}

function tomlStringArray(values) {
  return `[${(values || []).map((value) => tomlString(value)).join(', ')}]`
}

function appendReview(input) {
  const rawStateFile = input.stateFile || input.state_file
  if (!rawStateFile) {
    throw new Error('record input must include stateFile')
  }
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
    `head_commit = ${tomlString(input.headCommit || input.head_commit || '')}`,
    `commit_count = ${Number(input.commitCount || input.commit_count || 0)}`,
    `changed_files = ${tomlStringArray(input.changedFiles || input.changed_files || [])}`,
    `models = ${tomlStringArray(input.models || [])}`,
    `findings_total = ${Number(input.findingsTotal || input.findings_total || 0)}`,
    `summary = ${tomlString(input.summary || '')}`,
    `metrics_json = ${tomlString(JSON.stringify(input.metrics || {}))}`,
    '',
  ].join('\n')
  const current = readFile(stateFile)
  writeFileSync(stateFile, `${current}${current && !current.endsWith('\n') ? '\n' : ''}${entry}`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  return { ok: true, stateFile, headCommit: input.headCommit || input.head_commit || '' }
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
