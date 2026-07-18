/** @file Unit-test workflow argument resolution from TypeScript source. */

import assert from 'node:assert/strict'
import test from 'node:test'
import fc from 'fast-check'

import { resolveWorkflowConfig } from '../src/workflows/dakar-review/config.ts'
import { DEFAULT_REVIEW_MODELS } from '../src/workflows/dakar-review/model-routing.ts'

test('resolveWorkflowConfig supplies the documented workflow defaults', () => {
  const config = resolveWorkflowConfig(undefined)

  assert.equal(config.baseRef, 'origin/main')
  assert.equal(config.headRef, 'HEAD')
  assert.equal(config.repoRoot, '.')
  assert.equal(config.dryRun, false)
  assert.equal(config.maxCandidates, 30)
  assert.equal(config.maxFindings, 20)
  assert.equal(config.maxTasks, 8)
  assert.equal(config.reviewModels, DEFAULT_REVIEW_MODELS)
  assert.equal(config.synthesisModelName, 'gpt-5.5/high')
  assert.equal(config.synthesisAdapter, 'codex-high')
  assert.equal(Object.isFrozen(config), true)
  assert.equal(Object.isFrozen(config.reviewModels), true)
  assert.equal(config.reviewModels.every(Object.isFrozen), true)
  assert.throws(() => config.reviewModels.push({ model: 'leak', reasoning: 'low' }), TypeError)
})

test('resolveWorkflowConfig passes the prepared review through unvalidated', () => {
  const prepared = {
    ok: true, stateFile: '/tmp/reviews.toml', reviewBase: 'a'.repeat(40), headCommit: 'b'.repeat(40),
    commitCount: 3, changedFiles: ['src/a.ts'],
  }
  const config = resolveWorkflowConfig({ prepared })

  assert.deepEqual(config.prepared, prepared)
  assert.equal(resolveWorkflowConfig({}).prepared, undefined)
  assert.equal(resolveWorkflowConfig(undefined).prepared, undefined)
})

test('positive limits floor values, cap extremes, and reject invalid input', () => {
  const config = resolveWorkflowConfig({
    maxCandidates: 2.9,
    maxFindings: 999,
    maxTasks: 0,
  })

  assert.equal(config.maxCandidates, 2)
  assert.equal(config.maxFindings, 200)
  assert.equal(config.maxTasks, 8)
})

test('valid custom models replace defaults while malformed entries are discarded', () => {
  const custom = { label: 'custom', model: 'custom-model', reasoning: 'low', role: 'high' }
  const config = resolveWorkflowConfig({
    models: [custom, { model: '', reasoning: 'high' }, { model: 'missing-reasoning' }],
  })

  assert.deepEqual(config.reviewModels, [custom])
  assert.notEqual(config.reviewModels[0], custom)
  assert.equal(Object.isFrozen(config.reviewModels), true)
  assert.equal(Object.isFrozen(config.reviewModels[0]), true)
  custom.model = 'mutated-after-resolution'
  assert.equal(config.reviewModels[0].model, 'custom-model')
})

test('custom model suffixes must agree with their explicit reasoning', () => {
  const valid = { model: 'matched/low', reasoning: 'low', role: 'high' }
  const config = resolveWorkflowConfig({
    models: [valid, { model: 'mismatched/low', reasoning: 'high', role: 'medium' }],
  })

  assert.deepEqual(config.reviewModels, [valid])
})

test('synthesis model reasoning selects the adapter and rejects unknown levels', () => {
  const explicit = resolveWorkflowConfig({ synthesisModel: 'gpt-5.5/low' })
  assert.equal(explicit.synthesisModelBase, 'gpt-5.5')
  assert.equal(explicit.synthesisReasoning, 'low')
  assert.equal(explicit.synthesisAdapter, 'codex-low')

  const modelSuffixWins = resolveWorkflowConfig({
    synthesisModel: 'gpt-5.5/low',
    synthesisReasoning: 'high',
  })
  assert.equal(modelSuffixWins.synthesisReasoning, 'low')
  assert.equal(modelSuffixWins.synthesisModelName, 'gpt-5.5/low')

  const invalid = resolveWorkflowConfig({ synthesisModel: 'gpt-5.5/experimental' })
  assert.equal(invalid.synthesisReasoning, 'high')
  assert.equal(invalid.synthesisModelName, 'gpt-5.5/high')
  assert.equal(invalid.synthesisAdapter, 'codex-high')
})

test('malformed external values fall back without escaping configuration resolution', () => {
  for (const value of [true, 1, 'arguments', Symbol('arguments')]) {
    assert.equal(resolveWorkflowConfig(value).synthesisModelName, 'gpt-5.5/high')
  }
  for (const synthesisModel of [true, 42, '', '   ', 'model name', '/high', 'model/unknown', 'model/high/extra']) {
    assert.equal(resolveWorkflowConfig({ synthesisModel }).synthesisModelName, 'gpt-5.5/high')
  }
  const nestedSymbols = resolveWorkflowConfig({
    agentInstructions: 'untrusted',
    base: 42,
    maxTasks: Symbol('maxTasks'),
    repoRoot: false,
  })
  assert.equal(nestedSymbols.agentInstructions, null)
  assert.equal(nestedSymbols.baseRef, 'origin/main')
  assert.equal(nestedSymbols.maxTasks, 8)
  assert.equal(nestedSymbols.repoRoot, '.')
})

test('configuration resolution is total for JSON-compatible external input', () => {
  fc.assert(fc.property(fc.jsonValue(), (value) => {
    const config = resolveWorkflowConfig(value)
    assert.match(config.synthesisModelName, /\/(?:low|medium|high)$/u)
    assert.ok(config.maxTasks >= 1 && config.maxTasks <= 64)
    assert.ok(config.maxCandidates >= 1 && config.maxCandidates <= 1_000)
    assert.ok(config.maxFindings >= 1 && config.maxFindings <= 200)
  }))
})
