/**
 * @file Verify the M7 live-review harness and its local Flex telemetry boundary.
 *
 * These tests never touch the network or spend live provider budget: they
 * exercise `loadCorpusEntry`, the state-root escape guard, the SHA-pinning
 * comparison, the `DAKAR-USAGE:` stderr parser, and `summarize`'s output
 * shape against fixtures. Hermetic child processes also load the production
 * Flex extension against a fake pi host and exercise harness forwarding with
 * fake Git and ODW binaries; neither path starts pi, a provider, nor a network
 * clone. Real corpus clones and provider-billed `dakar-review` runs remain
 * live-operator-only activities.
 */

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'

import fc from 'fast-check'

import {
  createUsageScanner,
  extractUsageLines,
  guardStateRoot,
  loadCorpusEntry,
  parseCliArgs,
  priceReportedUsage,
  stateRootFor,
  summarize,
  sumUsage,
  verifyPinnedHead,
} from '../scripts/live-review-harness.mjs'

const flexExtensionUrl = new URL('../adapters/pi/extensions/flex-tier.ts', import.meta.url)

/**
 * Load the production Flex extension in a child process with a fake pi host.
 *
 * The fixture records hook callbacks in memory and never launches pi or a
 * provider. Removing the inherited API key makes accidental provider access
 * fail closed, while the child boundary isolates environment and console state.
 *
 * @param {string} usageLog Path supplied as `DAKAR_USAGE_LOG`.
 * @returns {{result: object, usageRecords: object[]}} Hook results and telemetry.
 */
function runFlexExtensionFixture(usageLog) {
  const fixtureSource = `
    import flexTier from ${JSON.stringify(flexExtensionUrl.href)}
    const hooks = new Map()
    flexTier({ on: (eventName, callback) => hooks.set(eventName, callback) })
    const providerPayload = { model: 'gpt-5.6-luna', stream: true, unrelated: { keep: 'me' } }
    const injected = hooks.get('before_provider_request')({ payload: providerPayload })
    const record = {
      model: 'gpt-5.6-luna',
      usage: { input: 13, output: 5, cacheRead: 3, cacheWrite: 2 },
    }
    hooks.get('message_end')({ message: { role: 'assistant', ...record } })
    hooks.get('message_end')({ message: { role: 'user', content: 'not telemetry' } })
    process.stdout.write(JSON.stringify({ injected, continued: true }))
  `
  const env = { ...process.env, DAKAR_USAGE_LOG: usageLog }
  delete env.OPENAI_API_KEY
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', fixtureSource], {
    encoding: 'utf8',
    env,
  })
  assert.equal(child.status, 0, child.stderr)
  const usageRecords = child.stderr
    .split('\n')
    .filter((line) => line.startsWith('DAKAR-USAGE: '))
    .map((line) => JSON.parse(line.slice('DAKAR-USAGE: '.length)))
  return { result: JSON.parse(child.stdout), usageRecords }
}

test('Flex extension injects the tier and emits assistant usage to stderr and JSONL', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'dakar-live-flex-'))
  const usageLog = join(tempRoot, 'usage.jsonl')
  try {
    const { result, usageRecords } = runFlexExtensionFixture(usageLog)

    assert.deepEqual(result.injected, {
      model: 'gpt-5.6-luna',
      stream: true,
      unrelated: { keep: 'me' },
      service_tier: 'flex',
    })
    assert.equal(result.continued, true)
    assert.deepEqual(usageRecords, [{
      model: 'gpt-5.6-luna',
      usage: { input: 13, output: 5, cacheRead: 3, cacheWrite: 2 },
    }])
    assert.deepEqual(
      readFileSync(usageLog, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line)),
      usageRecords,
    )
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('Flex extension preserves review execution when JSONL append fails', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'dakar-live-flex-failure-'))
  try {
    const { result, usageRecords } = runFlexExtensionFixture(tempRoot)

    assert.equal(result.continued, true)
    assert.equal(usageRecords.length, 1)
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('loadCorpusEntry returns the pinned entry for a known repo and PR', () => {
  const entry = loadCorpusEntry('leynos/comenq', 140)

  assert.equal(entry.tier, 'tiny')
  assert.equal(entry.repo, 'leynos/comenq')
  assert.equal(entry.pr, 140)
  assert.equal(entry.base, 'e39920ff83c23d75dd1ce4c2d4e35e7e05fd461f')
  assert.equal(entry.head, '448f1a4581856894f79d18637ff784b928214ab2')
})

test('parseCliArgs accepts a --dakar-args value that begins with dashes', () => {
  const options = parseCliArgs([
    '--repo', 'leynos/comenq',
    '--pr', '140',
    '--work', '/tmp/work',
    '--out', '/tmp/out',
    '--dakar-args', '--budget-gbp 0.15 --max-luna-calls 8',
  ])

  assert.equal(
    options.dakarArgs,
    '--budget-gbp 0.15 --max-luna-calls 8',
    'preserves flag-like child arguments passed through --dakar-args',
  )
})

test('parseCliArgs still rejects an option-like value for ordinary flags', () => {
  assert.throws(
    () => parseCliArgs(['--repo', '--pr', '140', '--work', '/tmp/w', '--out', '/tmp/o']),
    /--repo requires a value/u,
    'rejects option-like values as missing ordinary-option values',
  )
})

test('parseCliArgs preserves arbitrary option-like dakar arguments', () => {
  fc.assert(
    fc.property(fc.string(), (suffix) => {
      const dakarArgs = `--${suffix}`
      const options = parseCliArgs([
        '--repo', 'leynos/comenq',
        '--pr', '140',
        '--work', '/tmp/work',
        '--out', '/tmp/out',
        '--dakar-args', dakarArgs,
      ])

      assert.equal(options.dakarArgs, dakarArgs, 'preserves arbitrary option-like --dakar-args values')
    }),
  )
})

test('parseCliArgs rejects arbitrary option-like values for ordinary flags', () => {
  fc.assert(
    fc.property(
      fc.constantFrom('repo', 'pr', 'work', 'out', 'key-file'),
      fc.string(),
      (name, suffix) => {
        assert.throws(
          () => parseCliArgs([
            '--repo', 'leynos/comenq',
            '--pr', '140',
            '--work', '/tmp/work',
            '--out', '/tmp/out',
            `--${name}`, `--${suffix}`,
          ]),
          new RegExp(`--${name} requires a value`, 'u'),
          'rejects option-like values for ordinary flags',
        )
      },
    ),
  )
})

test('harness entry point forwards flag-like child arguments', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'dakar-harness-forwarding-'))
  try {
    const toolsDir = join(tempRoot, 'tools')
    const fakeGit = join(toolsDir, 'git')
    const spacedRoot = join(tempRoot, 'paths with spaces')
    const fakeOdw = join(spacedRoot, 'capture-odw.mjs')
    const runsRoot = join(spacedRoot, 'runs')
    const capturePath = join(tempRoot, 'workflow-args.json')
    const keyPath = join(tempRoot, 'api-key.txt')
    mkdirSync(toolsDir)
    mkdirSync(spacedRoot)
    writeFileSync(fakeGit, '#!/bin/sh\nif [ "$1" = clone ]; then mkdir -p "$3/.git"; fi\nexit 0\n')
    writeFileSync(
      fakeOdw,
      `#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
const values = process.argv.slice(2)
if (values[0] === 'run') {
  const input = JSON.parse(values[values.indexOf('--args') + 1])
  writeFileSync(process.env.DAKAR_CAPTURE_ARGS, JSON.stringify(input))
  process.stdout.write('20260816-000000-deadbeef\\n')
} else if (values[0] === 'result') {
  process.stdout.write(JSON.stringify({ ok: true, dryRun: true, metrics: {} }))
}
`,
    )
    writeFileSync(keyPath, 'test-key\n')
    chmodSync(fakeGit, 0o755)
    chmodSync(fakeOdw, 0o755)

    const child = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('../scripts/live-review-harness.mjs', import.meta.url)),
        '--repo', 'leynos/comenq',
        '--pr', '140',
        '--work', join(tempRoot, 'work'),
        '--out', join(tempRoot, 'out'),
        '--key-file', keyPath,
        '--dakar-args', `--dry-run --odw-bin "${fakeOdw}" --runs-root "${runsRoot}" --budget-gbp 0.05`,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          DAKAR_CAPTURE_ARGS: capturePath,
          PATH: `${toolsDir}:${process.env.PATH}`,
        },
      },
    )

    assert.equal(child.status, 0, child.stderr)
    const workflowArgs = JSON.parse(readFileSync(capturePath, 'utf8'))
    assert.equal(workflowArgs.budgetGbp, 0.05, 'forwards the child --budget-gbp value through the harness')
    assert.equal(workflowArgs.dryRun, true, 'forwards the child --dry-run flag through the harness')
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
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
  // The traversal target exists on disk, so a naive realpath step would not save
  // a lexical check that failed to reject it.
  mkdirSync(resolve(escaping), { recursive: true })

  assert.throws(() => guardStateRoot(outDir, escaping), /escapes output directory/u)
})

test('guardStateRoot rejects a candidate redirected outside via a symlinked ancestor', () => {
  const tmpA = mkdtempSync(join(tmpdir(), 'dakar-harness-a-'))
  const tmpB = mkdtempSync(join(tmpdir(), 'dakar-harness-b-'))
  const outDir = join(tmpA, 'out')
  const elsewhere = join(tmpB, 'elsewhere')
  mkdirSync(outDir, { recursive: true })
  mkdirSync(elsewhere, { recursive: true })
  // <out>/state is a symlink that redirects into a sibling tree; a candidate
  // under it is lexically inside <out> but physically escapes it.
  symlinkSync(elsewhere, join(outDir, 'state'))

  assert.throws(() => guardStateRoot(outDir, join(outDir, 'state', 'comenq-140')), /escapes output directory/u)
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
    'DAKAR-USAGE: not json, should be diagnosed',
  ].join('\n')

  const { usages, malformed } = extractUsageLines(stderrText)

  assert.equal(usages.length, 2)
  assert.deepEqual(usages[0], { input: 3, output: 5, cacheRead: 0, cacheWrite: 12819 })
  assert.deepEqual(usages[1], { input: 100, output: 40, cacheRead: 200, cacheWrite: 0 })
  assert.deepEqual(malformed, [{ line: 5, category: 'invalid-json' }])
})

test('extractUsageLines rejects non-object and malformed payloads', () => {
  const stderrText = [
    'DAKAR-USAGE: null',
    'DAKAR-USAGE: [1,2]',
    'DAKAR-USAGE: 42',
    'DAKAR-USAGE: "str"',
    // A well-formed object whose consumed fields are strings, not numbers.
    'DAKAR-USAGE: {"input":"3","output":"5","cacheRead":0,"cacheWrite":0}',
  ].join('\n')

  const { usages, malformed } = extractUsageLines(stderrText)

  assert.deepEqual(usages, [])
  assert.deepEqual(malformed, [
    { line: 1, category: 'non-object' },
    { line: 2, category: 'non-object' },
    { line: 3, category: 'non-object' },
    { line: 4, category: 'non-object' },
    { line: 5, category: 'invalid-fields' },
  ])
})

test('extractUsageLines accepts a plain object and applies the same rule to a nested usage', () => {
  const stderrText = [
    'DAKAR-USAGE: {"input":3,"output":5,"cacheRead":0,"cacheWrite":0}',
    'DAKAR-USAGE: {"model":"gpt-5.6-luna","usage":{"input":10,"output":2,"cacheRead":1,"cacheWrite":4}}',
    // Nested usage with a non-finite field is rejected wholesale.
    'DAKAR-USAGE: {"model":"gpt-5.6-luna","usage":{"input":"x"}}',
  ].join('\n')

  const { usages, malformed } = extractUsageLines(stderrText)

  assert.equal(usages.length, 2)
  assert.deepEqual(usages[0], { input: 3, output: 5, cacheRead: 0, cacheWrite: 0 })
  assert.deepEqual(usages[1], { model: 'gpt-5.6-luna', usage: { input: 10, output: 2, cacheRead: 1, cacheWrite: 4 } })
  assert.deepEqual(malformed, [{ line: 3, category: 'invalid-fields' }])
})

test('createUsageScanner parses chunked telemetry and bounds oversized lines', async () => {
  const scanner = createUsageScanner({ maxLineChars: 80 })
  scanner.stream.write('progress\nDAKAR-USA')
  scanner.stream.write('GE: {"input":3,"output":5,"cacheRead":0,"cacheWrite":1}\n')
  scanner.stream.write(`DAKAR-USAGE: ${'x'.repeat(100)}\n`)
  scanner.stream.end('DAKAR-USAGE: null')
  await once(scanner.stream, 'finish')

  assert.deepEqual(scanner.result(), {
    usages: [{ input: 3, output: 5, cacheRead: 0, cacheWrite: 1 }],
    malformed: [
      { line: 3, category: 'invalid-json' },
      { line: 4, category: 'non-object' },
    ],
  })
})

test('sumUsage ignores non-finite fields rather than propagating NaN', () => {
  const totals = sumUsage([
    { input: 3, output: Number.NaN, cacheRead: 0, cacheWrite: 5 },
    { input: Infinity, output: 40, cacheRead: 200, cacheWrite: 0 },
  ])

  assert.deepEqual(totals, { input: 3, output: 40, cacheRead: 200, cacheWrite: 5 })
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
    // Bare stderr-scanned usages carry no model, so nothing is priceable.
    reportedUsd: null,
    malformedTelemetryCount: 0,
    resultPath: '/scratch/results/frankie-102.json',
    stderrPath: '/scratch/results/frankie-102.stderr.log',
  })
})

test('CLI-attached reportedUsage records take precedence and price per lane', () => {
  const entry = { repo: 'leynos/frankie', pr: 102, tier: 'medium' }
  const resultJson = {
    ok: true,
    findings: [],
    discarded: [],
    metrics: {
      ledger: [],
      ledgerTotalEstimatedUsd: 0.01,
      reportedUsage: [
        { model: 'gpt-5.6-luna', usage: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 12000 } },
        { model: 'gpt-5.6-terra', usage: { input: 40000, output: 2000, cacheRead: 8000, cacheWrite: 0 } },
      ],
    },
  }

  const summary = summarize({ entry, resultJson, usages: [], resultPath: '/r', stderrPath: '/s' })

  assert.deepEqual(summary.reportedTokens, { input: 41000, output: 2500, cacheRead: 8000, cacheWrite: 12000 })
  // Luna flex: 1000x0.50 + 500x3.00 + 12000x0.625 per 1M = 0.0005+0.0015+0.0075
  // Terra flex: 40000x1.25 + 2000x7.50 + 8000x0.125 per 1M = 0.05+0.015+0.001
  assert.ok(Math.abs(summary.reportedUsd - (0.0095 + 0.066)) < 1e-9, `priced ${summary.reportedUsd}`)
})

test('priceReportedUsage skips unpriceable records rather than guessing', () => {
  const priced = priceReportedUsage([
    { model: 'unknown-model', usage: { input: 1000, output: 1000 } },
    { model: 'gpt-5.6-luna', usage: { input: 0, output: 1000, cacheRead: 0, cacheWrite: 0 } },
  ])
  assert.ok(Math.abs(priced - 0.003) < 1e-12, `priced ${priced}`)
})

test('summarize skips a malformed null record in metrics.reportedUsage', () => {
  const entry = { repo: 'leynos/frankie', pr: 102, tier: 'medium' }
  const resultJson = {
    ok: true,
    findings: [],
    discarded: [],
    metrics: {
      ledger: [],
      ledgerTotalEstimatedUsd: 0.01,
      reportedUsage: [
        null,
        { model: 'gpt-5.6-luna', usage: { input: 0, output: 1000, cacheRead: 0, cacheWrite: 0 } },
      ],
    },
  }

  const summary = summarize({ entry, resultJson, usages: [], resultPath: '/r', stderrPath: '/s' })

  assert.deepEqual(summary.reportedTokens, { input: 0, output: 1000, cacheRead: 0, cacheWrite: 0 })
  assert.ok(Math.abs(summary.reportedUsd - 0.003) < 1e-12, `priced ${summary.reportedUsd}`)
  // The null entry is now diagnosed, not silently vanished.
  assert.equal(summary.malformedTelemetryCount, 1)
  assert.deepEqual(summary.malformedTelemetryCategories, { 'non-object': 1 })
})

test('extractUsageLines flags a malformed JSON line as invalid-json with its position', () => {
  const { usages, malformed } = extractUsageLines('DAKAR-USAGE: {not valid json')

  assert.deepEqual(usages, [])
  assert.deepEqual(malformed, [{ line: 1, category: 'invalid-json' }])
})

test('extractUsageLines categorises null, array, and scalar payloads as non-object', () => {
  const stderrText = [
    'DAKAR-USAGE: null',
    'DAKAR-USAGE: [1,2]',
    'DAKAR-USAGE: 42',
    'DAKAR-USAGE: "str"',
  ].join('\n')

  const { usages, malformed } = extractUsageLines(stderrText)

  assert.deepEqual(usages, [])
  assert.equal(malformed.length, 4)
  assert.ok(malformed.every((diagnostic) => diagnostic.category === 'non-object'))
  assert.deepEqual(malformed.map((diagnostic) => diagnostic.line), [1, 2, 3, 4])
})

test('extractUsageLines categorises invalid numeric fields as invalid-fields', () => {
  const { usages, malformed } = extractUsageLines(
    'DAKAR-USAGE: {"input":"3","output":"5","cacheRead":0,"cacheWrite":0}',
  )

  assert.deepEqual(usages, [])
  assert.deepEqual(malformed, [{ line: 1, category: 'invalid-fields' }])
})

test('extractUsageLines ignores unmarked stderr lines and never counts them as malformed', () => {
  const stderrText = [
    'some progress line',
    'DAKAR-USAGE: {"input":3,"output":5,"cacheRead":0,"cacheWrite":0}',
    'another progress line without the marker',
  ].join('\n')

  const { usages, malformed } = extractUsageLines(stderrText)

  assert.equal(usages.length, 1)
  assert.deepEqual(malformed, [])
})

test('extractUsageLines separates mixed valid and malformed lines with exact positions and no payload leak', () => {
  const stderrText = [
    'DAKAR-USAGE: {"input":3,"output":5,"cacheRead":0,"cacheWrite":12819}',
    'DAKAR-USAGE: {broken json',
    'DAKAR-USAGE: {"input":100,"output":40,"cacheRead":200,"cacheWrite":0}',
    'DAKAR-USAGE: [1,2]',
    'DAKAR-USAGE: {"input":"NOPAYLOADLEAK","output":5}',
  ].join('\n')

  const { usages, malformed } = extractUsageLines(stderrText)

  assert.equal(usages.length, 2)
  // Valid totals stay byte-identical to processing the valid lines alone.
  assert.deepEqual(sumUsage(usages), { input: 103, output: 45, cacheRead: 200, cacheWrite: 12819 })
  assert.deepEqual(malformed, [
    { line: 2, category: 'invalid-json' },
    { line: 4, category: 'non-object' },
    { line: 5, category: 'invalid-fields' },
  ])
  // The distinctive marker planted in a malformed payload must not surface.
  assert.ok(!JSON.stringify(malformed).includes('NOPAYLOADLEAK'))
})

test('summarize surfaces malformed telemetry counts and a category tally from the stderr scan', () => {
  const entry = { repo: 'leynos/frankie', pr: 102, tier: 'medium' }
  const resultJson = { ok: true, findings: [], discarded: [], metrics: { ledger: [], ledgerTotalEstimatedUsd: 0.01 } }
  const usages = [{ input: 100, output: 40, cacheRead: 200, cacheWrite: 0 }]
  const malformedTelemetry = [
    { line: 2, category: 'invalid-json' },
    { line: 5, category: 'non-object' },
    { line: 7, category: 'invalid-json' },
  ]

  const summary = summarize({ entry, resultJson, usages, malformedTelemetry, resultPath: '/r', stderrPath: '/s' })

  // Valid accounting is untouched by the malformed diagnostics.
  assert.deepEqual(summary.reportedTokens, { input: 100, output: 40, cacheRead: 200, cacheWrite: 0 })
  assert.equal(summary.malformedTelemetryCount, 3)
  assert.deepEqual(summary.malformedTelemetryCategories, { 'invalid-json': 2, 'non-object': 1 })
})

test('summarize diagnoses malformed metrics.reportedUsage entries while keeping valid accounting exact', () => {
  const entry = { repo: 'leynos/frankie', pr: 102, tier: 'medium' }
  const resultJson = {
    ok: true,
    findings: [],
    discarded: [],
    metrics: {
      ledger: [],
      ledgerTotalEstimatedUsd: 0.01,
      reportedUsage: [
        null,
        'DAKAR-USAGE-PAYLOAD-LEAK',
        { model: 'gpt-5.6-luna', usage: { input: 0, output: 1000, cacheRead: 0, cacheWrite: 0 } },
        { model: 'gpt-5.6-luna', usage: { input: 'x' } },
      ],
    },
  }

  const summary = summarize({ entry, resultJson, usages: [], malformedTelemetry: [], resultPath: '/r', stderrPath: '/s' })

  assert.deepEqual(summary.reportedTokens, { input: 0, output: 1000, cacheRead: 0, cacheWrite: 0 })
  assert.ok(Math.abs(summary.reportedUsd - 0.003) < 1e-12, `priced ${summary.reportedUsd}`)
  assert.equal(summary.malformedTelemetryCount, 3)
  assert.deepEqual(summary.malformedTelemetryCategories, { 'non-object': 2, 'invalid-fields': 1 })
  // The serialized summary must not leak any malformed payload contents.
  assert.ok(!JSON.stringify(summary).includes('DAKAR-USAGE-PAYLOAD-LEAK'))
})

test('summarize reports a zero malformed count and omits the category tally when telemetry is clean', () => {
  const entry = { repo: 'leynos/frankie', pr: 102, tier: 'medium' }
  const resultJson = { ok: true, findings: [], discarded: [], metrics: { ledger: [], ledgerTotalEstimatedUsd: 0.01 } }

  const summary = summarize({ entry, resultJson, usages: [], resultPath: '/r', stderrPath: '/s' })

  assert.equal(summary.malformedTelemetryCount, 0)
  assert.ok(!('malformedTelemetryCategories' in summary))
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
