#!/usr/bin/env node
/**
 * @file Drive live, provider-billed Dakar reviews against the pinned M7 corpus.
 *
 * The harness clones (or reuses) a corpus repository, fetches and verifies the
 * pull-request head against `scripts/live-corpus.json`, guards a scratch state
 * root, then spawns `bin/dakar-review.mjs` with the API key injected into the
 * child environment only (never on a command line or in a log line). Progress
 * and child stderr go to `process.stderr`; stdout is reserved for the final
 * summary JSON, matching the CLI's own contract. `--skip-review` stops after
 * the clone and SHA-pinning guard so an operator can warm corpus checkouts
 * without spending provider budget.
 */

import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PRICING_TABLE } from '../src/workflows/dakar-review/pricing.ts'

const moduleDir = dirname(fileURLToPath(import.meta.url))
const corpusPath = join(moduleDir, 'live-corpus.json')
const DAKAR_USAGE_MARKER = 'DAKAR-USAGE: '

/**
 * Load the pinned corpus manifest and find the entry for a repo and PR number.
 *
 * @param {string} repo - `owner/name` slug, e.g. `'leynos/comenq'`.
 * @param {number} pr - pull-request number.
 * @returns {{ tier: string, repo: string, pr: number, base: string, head: string }} the pinned entry.
 */
export function loadCorpusEntry(repo, pr) {
  const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'))
  const entry = corpus.find((candidate) => candidate.repo === repo && candidate.pr === Number(pr))
  if (!entry) {
    throw new Error(`no corpus entry for ${repo}#${pr} in ${corpusPath}`)
  }
  return entry
}

/**
 * Assert that a resolved SHA exactly matches a corpus entry's pinned head.
 *
 * Fails closed: any mismatch throws, naming both the expected and actual SHA,
 * rather than proceeding against an unpinned or moved pull-request head.
 *
 * @param {string} actualSha - the SHA resolved from the live fetch.
 * @param {{ repo: string, pr: number, head: string }} entry - the pinned corpus entry.
 * @returns {true} when the SHAs match.
 */
export function verifyPinnedHead(actualSha, entry) {
  if (actualSha !== entry.head) {
    throw new Error(
      `SHA-pinning guard failed for ${entry.repo}#${entry.pr}: expected head ${entry.head}, got ${actualSha}`,
    )
  }
  return true
}

/**
 * Assert that a candidate scratch path resolves strictly inside an output
 * directory, then create it. Fails closed on any traversal or absolute path
 * that would place state outside the caller's own scratch tree.
 *
 * @param {string} outDir - the output directory the candidate must stay within.
 * @param {string} candidate - the proposed state-root path.
 * @returns {string} the resolved, created state-root path.
 */
export function guardStateRoot(outDir, candidate) {
  const resolvedOut = resolve(outDir)
  const resolvedCandidate = resolve(candidate)
  const withinBoundary = resolvedCandidate === resolvedOut || resolvedCandidate.startsWith(resolvedOut + '/')
  if (!withinBoundary) {
    throw new Error(`state root escapes output directory: expected within ${resolvedOut}, got ${resolvedCandidate}`)
  }
  mkdirSync(resolvedCandidate, { recursive: true })
  return resolvedCandidate
}

/**
 * Build and guard the conventional per-entry state root, `<out>/state/<name>-<pr>`.
 *
 * @param {string} outDir - the harness's output directory.
 * @param {string} name - the repository's short name (final path segment).
 * @param {number} pr - pull-request number.
 * @returns {string} the resolved, created state-root path.
 */
export function stateRootFor(outDir, name, pr) {
  return guardStateRoot(outDir, join(outDir, 'state', `${name}-${pr}`))
}

/**
 * Derive a repository's short name from its `owner/name` slug.
 *
 * @param {string} repo - `owner/name` slug.
 * @returns {string} the final path segment, e.g. `'comenq'` for `'leynos/comenq'`.
 */
function repoName(repo) {
  return repo.split('/').pop()
}

/**
 * Run a git command, throwing with its stderr on failure.
 *
 * @param {string[]} args - git argument vector (excluding the `git` token).
 * @param {string} [cwd] - working directory for the command.
 * @returns {string} the command's trimmed stdout.
 */
function runGit(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || '').trim() || 'unknown error'}`)
  }
  return result.stdout
}

/**
 * Assert that a commit is present in a clone's object database.
 *
 * @param {string} cloneDir - path to the git clone.
 * @param {string} sha - the commit SHA expected to be present.
 * @returns {void}
 */
function assertCommitPresent(cloneDir, sha) {
  const result = spawnSync('git', ['cat-file', '-e', `${sha}^{commit}`], {
    cwd: cloneDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) {
    throw new Error(`SHA-pinning guard failed: base commit ${sha} is not present in the clone after fetch`)
  }
}

/**
 * Clone (or reuse) a corpus repository, fetch the pinned pull request, verify
 * the fetched head and base against the corpus entry, and check out the head
 * commit detached. The clone is full (not shallow): the review range needs
 * history back to the base commit.
 *
 * @param {{ repo: string, pr: number, base: string, head: string }} entry - the pinned corpus entry.
 * @param {string} workDir - scratch directory to clone into.
 * @returns {Promise<string>} the resolved clone directory.
 */
export async function prepareClone(entry, workDir) {
  const resolvedWorkDir = resolve(workDir)
  mkdirSync(resolvedWorkDir, { recursive: true })
  const name = repoName(entry.repo)
  const cloneDir = join(resolvedWorkDir, name)
  if (!existsSync(join(cloneDir, '.git'))) {
    process.stderr.write(`cloning ${entry.repo} into ${cloneDir}\n`)
    runGit(['clone', `https://github.com/${entry.repo}.git`, cloneDir])
  }
  process.stderr.write(`fetching pinned head ${entry.head} for ${entry.repo}\n`)
  // Fetch the pinned commit by SHA first: an open pull request's head ref
  // moves under rebases, but GitHub keeps serving the pinned commit itself.
  // Fall back to the pull ref only when the direct fetch is refused, and
  // verify whichever route ran against the pinned SHA before checkout.
  const directFetch = spawnSync('git', ['fetch', 'origin', entry.head], {
    cwd: cloneDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (directFetch.status !== 0) {
    process.stderr.write(`direct fetch refused; fetching pull/${entry.pr}/head for ${entry.repo}\n`)
    runGit(['fetch', 'origin', `pull/${entry.pr}/head`], cloneDir)
    const fetchedHead = runGit(['rev-parse', 'FETCH_HEAD'], cloneDir).trim()
    verifyPinnedHead(fetchedHead, entry)
  }
  assertCommitPresent(cloneDir, entry.head)
  assertCommitPresent(cloneDir, entry.base)
  runGit(['checkout', '--detach', entry.head], cloneDir)
  return cloneDir
}

/**
 * Parse `DAKAR-USAGE: ` marker lines out of the pi Flex adapter's stderr
 * telemetry, ignoring unrelated lines and malformed payloads.
 *
 * @param {string} stderrText - the full stderr capture from a review run.
 * @returns {Array<Record<string, number>>} the parsed usage payloads, in order.
 */
export function extractUsageLines(stderrText) {
  const usages = []
  for (const line of stderrText.split('\n')) {
    const markerIndex = line.indexOf(DAKAR_USAGE_MARKER)
    if (markerIndex === -1) continue
    const payload = line.slice(markerIndex + DAKAR_USAGE_MARKER.length).trim()
    try {
      usages.push(JSON.parse(payload))
    } catch {
      // Malformed telemetry must not fail the whole run; skip it.
    }
  }
  return usages
}

/**
 * Sum reported token usage across parsed `DAKAR-USAGE` payloads.
 *
 * @param {Array<Record<string, number>>} usages - parsed usage payloads.
 * @returns {{ input: number, output: number, cacheRead: number, cacheWrite: number }} totals.
 */
export function sumUsage(usages) {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  for (const usage of usages) {
    totals.input += usage.input ?? 0
    totals.output += usage.output ?? 0
    totals.cacheRead += usage.cacheRead ?? 0
    totals.cacheWrite += usage.cacheWrite ?? 0
  }
  return totals
}

/**
 * Spawn `bin/dakar-review.mjs` for one corpus entry, reading the API key
 * inside this process and passing it to the child only via its environment.
 * Child stderr is tee'd to a log file and to this process's stderr, and is
 * scanned for `DAKAR-USAGE:` telemetry lines; child stdout (the CLI's
 * reserved result channel) is written to a result file and parsed as JSON.
 *
 * @param {object} options - run options.
 * @param {{ repo: string, pr: number, base: string, head: string }} options.entry - the pinned corpus entry.
 * @param {string} options.cloneDir - the prepared clone directory.
 * @param {string} options.stateRoot - the guarded, per-entry state root.
 * @param {string} options.outDir - directory to write the result and stderr log into.
 * @param {string[]} [options.extraArgs] - additional arguments passed through to `dakar-review`.
 * @param {string} options.keyPath - path to the file holding the provider API key.
 * @param {string} options.packageRoot - Dakar's package root, containing `bin/dakar-review.mjs`.
 * @returns {Promise<{ resultJson: object, usages: Array<Record<string, number>>, resultPath: string, stderrPath: string, exitCode: number | null }>} the run's outputs.
 */
export async function runReview({ entry, cloneDir, stateRoot, outDir, extraArgs = [], keyPath, packageRoot }) {
  const apiKey = readFileSync(keyPath, 'utf8').trim()
  if (!apiKey) {
    throw new Error(`API key file is empty: ${keyPath}`)
  }
  const resolvedOutDir = resolve(outDir)
  mkdirSync(resolvedOutDir, { recursive: true })
  const name = repoName(entry.repo)
  const stderrPath = join(resolvedOutDir, `${name}-${entry.pr}.stderr.log`)
  const resultPath = join(resolvedOutDir, `${name}-${entry.pr}.json`)
  const dakarBin = join(packageRoot, 'bin', 'dakar-review.mjs')
  const args = [
    dakarBin,
    '--repo-root', cloneDir,
    '--base', entry.base,
    '--head', entry.head,
    '--state-root', stateRoot,
    '--timeout', '3600',
    '--telemetry',
    ...extraArgs,
  ]

  process.stderr.write(`running dakar-review for ${entry.repo}#${entry.pr}\n`)
  const child = spawn(process.execPath, args, {
    env: { ...process.env, OPENAI_API_KEY: apiKey },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const stdoutChunks = []
  const stderrChunks = []
  const stderrFile = createWriteStream(stderrPath)
  child.stdout.on('data', (chunk) => stdoutChunks.push(chunk))
  child.stderr.on('data', (chunk) => {
    stderrChunks.push(chunk)
    stderrFile.write(chunk)
    process.stderr.write(chunk)
  })

  const exitCode = await new Promise((resolvePromise, reject) => {
    child.on('error', reject)
    child.on('close', (code) => resolvePromise(code))
  })
  stderrFile.end()

  const stdoutText = Buffer.concat(stdoutChunks).toString('utf8')
  const stderrText = Buffer.concat(stderrChunks).toString('utf8')
  writeFileSync(resultPath, stdoutText)

  const usages = extractUsageLines(stderrText)

  let resultJson
  try {
    resultJson = JSON.parse(stdoutText)
  } catch (error) {
    throw new Error(
      `dakar-review stdout was not valid JSON (exit ${exitCode}): ${error.message}; see ${resultPath} and ${stderrPath}`,
    )
  }

  if (exitCode !== 0 && resultJson?.ok !== false) {
    throw new Error(`dakar-review exited with code ${exitCode}; see ${stderrPath}`)
  }

  return { resultJson, usages, resultPath, stderrPath, exitCode }
}

/**
 * Reduce a `dakar-review` result plus parsed usage telemetry to the harness's
 * final summary shape, printed as the operator-facing stdout JSON.
 *
 * @param {object} options - summarize inputs.
 * @param {{ repo: string, pr: number, tier: string }} options.entry - the pinned corpus entry.
 * @param {object} options.resultJson - the parsed `dakar-review` result.
 * @param {Array<Record<string, number>>} [options.usages] - parsed `DAKAR-USAGE` payloads.
 * @param {string} options.resultPath - path the raw result JSON was written to.
 * @param {string} options.stderrPath - path the raw stderr log was written to.
 * @returns {object} the harness summary.
 */
export function summarize({ entry, resultJson, usages = [], resultPath, stderrPath }) {
  const ok = resultJson?.ok === true
  const stage = resultJson?.stage ?? (ok ? 'complete' : 'unknown')
  const ledger = resultJson?.metrics?.ledger
  // The CLI-attached usage records (via the DAKAR_USAGE_LOG file channel) are
  // authoritative; the stderr scan is a fallback for direct pi invocations.
  const reportedRecords = Array.isArray(resultJson?.metrics?.reportedUsage)
    ? resultJson.metrics.reportedUsage
    : usages
  const usagePayloads = reportedRecords.map((record) => record.usage ?? record)
  return {
    repo: entry.repo,
    pr: entry.pr,
    tier: entry.tier,
    ok,
    stage,
    findingsCount: Array.isArray(resultJson?.findings) ? resultJson.findings.length : 0,
    discardedCount: Array.isArray(resultJson?.discarded) ? resultJson.discarded.length : 0,
    ledgerTotalEstimatedUsd: resultJson?.metrics?.ledgerTotalEstimatedUsd ?? null,
    ledgerEntryCount: Array.isArray(ledger) ? ledger.length : 0,
    reportedTokens: sumUsage(usagePayloads),
    reportedUsd: priceReportedUsage(reportedRecords),
    resultPath,
    stderrPath,
  }
}

/**
 * Price reported usage records with the committed Flex pricing table.
 *
 * Each record carries the model that produced it; unpriceable records (no
 * model, or a model missing from the table) are skipped rather than guessed,
 * so the returned figure is a floor, not an estimate. Cache reads price at
 * the cached-input band and cache writes at the cache-write band, matching
 * the provider's billing semantics.
 *
 * @param {Array<{ model?: string, usage?: Record<string, number> }>} records - reported usage records.
 * @returns {number | null} the total reported USD, or null when nothing was priceable.
 */
export function priceReportedUsage(records) {
  let total = null
  for (const record of records) {
    const usage = record.usage ?? record
    const band = DEFAULT_PRICING_TABLE.rates[`${record.model}:flex`]
    if (!band) continue
    const usd =
      ((usage.input ?? 0) * band.inputUsdPerMTok +
        (usage.cacheRead ?? 0) * band.cachedInputUsdPerMTok +
        (usage.cacheWrite ?? 0) * band.cacheWriteUsdPerMTok +
        (usage.output ?? 0) * band.outputUsdPerMTok) /
      1_000_000
    total = (total ?? 0) + usd
  }
  return total
}

const CLI_FLAGS = new Map([
  ['repo', { key: 'repo', value: true }],
  ['pr', { key: 'pr', value: true }],
  ['work', { key: 'work', value: true }],
  ['out', { key: 'out', value: true }],
  ['key-file', { key: 'keyFile', value: true }],
  ['dakar-args', { key: 'dakarArgs', value: true }],
  ['skip-review', { key: 'skipReview', value: false }],
])

/**
 * Parse the harness's own command-line argument vector.
 *
 * @param {string[]} argv - argument tokens, excluding the node/script prefix.
 * @returns {object} parsed options, with `keyFile` defaulted to `~/dakar-api-key.txt`.
 */
function parseCliArgs(argv) {
  const options = { keyFile: join(homedir(), 'dakar-api-key.txt') }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      throw new Error(`unexpected positional argument: ${token}`)
    }
    const name = token.slice(2)
    const spec = CLI_FLAGS.get(name)
    if (!spec) {
      throw new Error(`unknown option: --${name}`)
    }
    if (!spec.value) {
      options[spec.key] = true
      continue
    }
    const value = argv[++index]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`--${name} requires a value`)
    }
    options[spec.key] = value
  }
  for (const required of ['repo', 'pr', 'work', 'out']) {
    if (options[required] === undefined) {
      throw new Error(`--${required} is required`)
    }
  }
  return options
}

/**
 * Split a shell-like extra-arguments string into an argument vector.
 *
 * Supports simple double-quoted segments; it is not a full shell parser, but
 * is sufficient for passing a handful of extra `dakar-review` flags through.
 *
 * @param {string} text - the raw `--dakar-args` value.
 * @returns {string[]} the split argument vector.
 */
function splitExtraArgs(text) {
  const matches = text.match(/"[^"]*"|'[^']*'|\S+/gu) ?? []
  return matches.map((token) => token.replace(/^['"]|['"]$/gu, ''))
}

/**
 * Entry point: prepare a corpus clone, guard its state root, and either stop
 * there (`--skip-review`) or run a live `dakar-review` and print the summary.
 *
 * @returns {Promise<void>} resolves once the summary has been printed.
 */
async function main() {
  const options = parseCliArgs(process.argv.slice(2))
  const entry = loadCorpusEntry(options.repo, Number(options.pr))
  const cloneDir = await prepareClone(entry, options.work)
  const name = repoName(entry.repo)
  const resolvedOut = resolve(options.out)
  mkdirSync(resolvedOut, { recursive: true })
  const stateRoot = stateRootFor(resolvedOut, name, entry.pr)

  if (options.skipReview) {
    process.stdout.write(`${JSON.stringify({ prepared: true, cloneDir, stateRoot })}\n`)
    return
  }

  const packageRoot = resolve(moduleDir, '..')
  const extraArgs = options.dakarArgs ? splitExtraArgs(options.dakarArgs) : []
  const { resultJson, usages, resultPath, stderrPath } = await runReview({
    entry,
    cloneDir,
    stateRoot,
    outDir: resolvedOut,
    extraArgs,
    keyPath: options.keyFile,
    packageRoot,
  })
  const summary = summarize({ entry, resultJson, usages, resultPath, stderrPath })
  process.stdout.write(`${JSON.stringify(summary)}\n`)
  if (!summary.ok) {
    process.exitCode = 1
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`)
    process.exitCode = 1
  })
}
