/**
 * @file Verify the M7 live-review harness's pure and file-scoped helpers.
 *
 * These tests never touch the network or spend live provider budget: they
 * exercise `loadCorpusEntry`, the state-root escape guard, the SHA-pinning
 * comparison, the `DAKAR-USAGE:` stderr parser, and `summarize`'s output
 * shape against fixtures. Cloning and spawning `dakar-review` are exercised
 * only by the operator running the harness for real against the pinned
 * corpus.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  extractUsageLines,
  guardStateRoot,
  loadCorpusEntry,
  stateRootFor,
  summarize,
  sumUsage,
  verifyPinnedHead,
} from '../scripts/live-review-harness.mjs'

test('loadCorpusEntry returns the pinned entry for a known repo and PR', () => {
  const entry = loadCorpusEntry('leynos/comenq', 140)

  assert.equal(entry.tier, 'tiny')
  assert.equal(entry.repo, 'leynos/comenq')
  assert.equal(entry.pr, 140)
  assert.equal(entry.base, 'e39920ff83c23d75dd1ce4c2d4e35e7e05fd461f')
  assert.equal(entry.head, '448f1a4581856894f79d18637ff784b928214ab2')
})

test('loadCorpusEntry throws for an unknown repo or PR', () => {
  assert.throws(() => loadCorpusEntry('leynos/comenq', 9999), /no corpus entry/u)
  assert.throws(() => loadCorpusEntry('leynos/nonesuch', 1), /no corpus entry/u)
})

test('guardStateRoot accepts a candidate strictly inside the output directory', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'dakar-harness-out-'))
  const candidate = join(outDir, 'state', 'comenq-140')

  const guarded = guardStateRoot(outDir, candidate)

  assert.equal(guarded, resolve(candidate))
})

test('guardStateRoot rejects a relative traversal that escapes the output directory', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'dakar-harness-out-'))
  const escaping = join(outDir, '..', 'escape')

  assert.throws(() => guardStateRoot(outDir, escaping), /escapes output directory/u)
})

test('guardStateRoot rejects an absolute path elsewhere on the filesystem', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'dakar-harness-out-'))

  assert.throws(() => guardStateRoot(outDir, '/etc/definitely-not-the-output-dir'), /escapes output directory/u)
})

test('stateRootFor builds and guards the conventional per-entry scratch path', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'dakar-harness-out-'))

  const stateRoot = stateRootFor(outDir, 'comenq', 140)

  assert.equal(stateRoot, resolve(outDir, 'state', 'comenq-140'))
})

test('verifyPinnedHead accepts a matching head SHA', () => {
  const entry = { repo: 'leynos/comenq', pr: 140, head: 'a'.repeat(40) }

  assert.doesNotThrow(() => verifyPinnedHead('a'.repeat(40), entry))
})

test('verifyPinnedHead fails closed on a mismatched head SHA, naming both', () => {
  const entry = { repo: 'leynos/comenq', pr: 140, head: 'a'.repeat(40) }
  const actual = 'b'.repeat(40)

  assert.throws(() => verifyPinnedHead(actual, entry), (error) => {
    assert.match(error.message, /leynos\/comenq#140/u)
    assert.match(error.message, new RegExp(entry.head, 'u'))
    assert.match(error.message, new RegExp(actual, 'u'))
    return true
  })
})

test('extractUsageLines parses DAKAR-USAGE payloads and ignores other stderr noise', () => {
  const stderrText = [
    'some progress line',
    'DAKAR-USAGE: {"input":3,"output":5,"cacheRead":0,"cacheWrite":12819}',
    'another progress line',
    'DAKAR-USAGE: {"input":100,"output":40,"cacheRead":200,"cacheWrite":0}',
    'DAKAR-USAGE: not json, should be skipped',
  ].join('\n')

  const usages = extractUsageLines(stderrText)

  assert.equal(usages.length, 2)
  assert.deepEqual(usages[0], { input: 3, output: 5, cacheRead: 0, cacheWrite: 12819 })
  assert.deepEqual(usages[1], { input: 100, output: 40, cacheRead: 200, cacheWrite: 0 })
})

test('sumUsage totals input, output, cacheRead, and cacheWrite across entries', () => {
  const totals = sumUsage([
    { input: 3, output: 5, cacheRead: 0, cacheWrite: 12819 },
    { input: 100, output: 40, cacheRead: 200, cacheWrite: 0 },
  ])

  assert.deepEqual(totals, { input: 103, output: 45, cacheRead: 200, cacheWrite: 12819 })
})

test('sumUsage returns zeroed totals for an empty usage list', () => {
  assert.deepEqual(sumUsage([]), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
})

test('summarize shapes an ok result fixture', () => {
  const entry = { repo: 'leynos/frankie', pr: 102, tier: 'medium' }
  const resultJson = {
    ok: true,
    findings: [{ title: 'a' }, { title: 'b' }],
    discarded: [{ title: 'c' }],
    metrics: {
      ledger: [{ callId: 'luna-1' }, { callId: 'audit' }],
      ledgerTotalEstimatedUsd: 0.13275,
    },
  }
  const usages = [{ input: 100, output: 40, cacheRead: 200, cacheWrite: 0 }]

  const summary = summarize({
    entry,
    resultJson,
    usages,
    resultPath: '/scratch/results/frankie-102.json',
    stderrPath: '/scratch/results/frankie-102.stderr.log',
  })

  assert.deepEqual(summary, {
    repo: 'leynos/frankie',
    pr: 102,
    tier: 'medium',
    ok: true,
    stage: 'complete',
    findingsCount: 2,
    discardedCount: 1,
    ledgerTotalEstimatedUsd: 0.13275,
    ledgerEntryCount: 2,
    reportedTokens: { input: 100, output: 40, cacheRead: 200, cacheWrite: 0 },
    resultPath: '/scratch/results/frankie-102.json',
    stderrPath: '/scratch/results/frankie-102.stderr.log',
  })
})

test('summarize shapes a deferred result fixture', () => {
  const entry = { repo: 'leynos/wireframe', pr: 609, tier: 'oversize-probe' }
  const resultJson = {
    ok: false,
    stage: 'deferred',
    reason: 'flex capacity exhausted for the required audit',
    metrics: {
      ledger: [{ callId: 'luna-1' }],
      ledgerTotalEstimatedUsd: 0.05,
    },
  }

  const summary = summarize({
    entry,
    resultJson,
    usages: [],
    resultPath: '/scratch/results/wireframe-609.json',
    stderrPath: '/scratch/results/wireframe-609.stderr.log',
  })

  assert.equal(summary.ok, false)
  assert.equal(summary.stage, 'deferred')
  assert.equal(summary.findingsCount, 0)
  assert.equal(summary.discardedCount, 0)
  assert.equal(summary.ledgerTotalEstimatedUsd, 0.05)
  assert.equal(summary.ledgerEntryCount, 1)
  assert.deepEqual(summary.reportedTokens, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
})
