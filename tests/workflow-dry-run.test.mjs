/**
 * @file Validate the ODW dry-run contract exposed by the review workflow.
 *
 * The tests launch the workflow in dry-run mode so schema and routing metadata
 * stay executable without dispatching live review agents.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

function runDryRun(args = {}) {
  const runsRoot = mkdtempSync(join(tmpdir(), 'dakar-odw-dry-run-'))
  const output = execFileSync(
    'odw',
    [
      'run',
      'workflows/dakar-review.js',
      '--runs-root',
      runsRoot,
      '--source',
      '.',
      '--wait',
      '--timeout',
      '20',
      '--args',
      JSON.stringify({ dryRun: true, ...args }),
    ],
    {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  const jsonStart = output.indexOf('{')
  assert.notEqual(jsonStart, -1, `dry-run output did not include JSON:\n${output}`)
  return JSON.parse(output.slice(jsonStart))
}

test('dry-run exposes routed workflow contract', () => {
  const result = runDryRun({
    maxTasks: 6,
    maxCandidates: 12,
    maxFindings: 4,
    repoRoot: '/tmp/dakar-checkout',
  })

  assert.equal(result.ok, true)
  assert.equal(result.dryRun, true)
  assert.equal(result.workflowVersion, 'divide-and-conquer-v1')
  assert.equal(result.repoRoot, '/tmp/dakar-checkout')
  assert.equal(result.config, 'auto')
  assert.equal(result.synthesisModel, 'gpt-5.5/high')
  assert.equal(result.synthesisAdapter, 'codex-high')
  assert.deepEqual(result.taskKinds, ['docs', 'config', 'tests', 'source', 'review-summary'])
  assert.equal(result.limits.maxTasks, 6)
  assert.equal(result.limits.maxCandidates, 12)
  assert.equal(result.limits.maxFindings, 4)
  assert.equal(result.limits.maxAuditCandidates, 30)
  assert.equal(result.routingPolicy, 'deterministic-flex-v1')
  assert.ok(Array.isArray(result.defaultTaskGraph))
  assert.ok(result.defaultTaskGraph.length >= 3)
  assert.ok(result.defaultTaskGraph.every((task) => task.taskId && task.assignedModel && task.adapter))
  assert.equal(result.candidateSchema.properties.candidates.type, 'array')
  assert.equal(result.verdictSchema.properties.status.enum.includes('accepted'), true)
  assert.equal(result.auditSchema.required.includes('verdicts'), true)
  assert.equal(result.auditSchema.properties.verdicts.items.properties.clusterId.type, 'string')
  assert.equal(result.synthesisSchema, undefined)
})

test('dry-run reports the Flex lanes, budget, and reserved audit estimate', () => {
  const result = runDryRun()

  assert.deepEqual(result.lanes.luna, {
    role: 'luna', model: 'gpt-5.6-luna', adapter: 'pi-luna-flex', serviceTier: 'flex', reasoning: 'low',
  })
  assert.deepEqual(result.lanes['luna-medium'], {
    role: 'luna-medium', model: 'gpt-5.6-luna', adapter: 'pi-luna-flex-medium', serviceTier: 'flex', reasoning: 'medium',
  })
  assert.deepEqual(result.lanes.terra, {
    role: 'terra', model: 'gpt-5.6-terra', adapter: 'pi-terra-flex', serviceTier: 'flex', reasoning: 'medium',
  })
  assert.equal(result.budgetGbp, 0.1)
  assert.equal(result.pricingTableVersion, '2026-07-18')
  // Reserved Terra audit worst case: 48000 x 1.5625/1e6 + 2500 x 7.5/1e6 = 0.09375.
  assert.ok(Math.abs(result.reservedAuditUsd - 0.09375) < 1e-9, `reservedAuditUsd was ${result.reservedAuditUsd}`)
  assert.equal(result.flexLimits.maxLunaFlexCalls, 4)
  assert.equal(result.flexLimits.transactionMaxFiles, 5)
  assert.equal(result.flexLimits.transactionMaxInputTokens, 12000)
  assert.equal(result.flexLimits.transactionMaxOutputTokens, 750)
  assert.equal(result.flexLimits.terraMaxInputTokens, 48000)
  assert.equal(result.flexLimits.terraMaxOutputTokens, 2500)
  assert.equal(result.flexLimits.adapterOverheadTokens, 13000)
})

test('dry-run honours a custom audit cap and routing policy', () => {
  const result = runDryRun({ maxAuditCandidates: 7, routingPolicy: 'legacy' })

  assert.equal(result.limits.maxAuditCandidates, 7)
  assert.equal(result.routingPolicy, 'legacy')
})

test('dry-run ignores a supplied prepared review and does not echo it', () => {
  const result = runDryRun({
    prepared: { ok: true, stateFile: '/tmp/reviews.toml', reviewBase: 'a'.repeat(40), headCommit: 'b'.repeat(40), commitCount: 2, changedFiles: ['src/a.ts'] },
  })

  assert.equal(result.ok, true)
  assert.equal(result.dryRun, true)
  assert.equal(result.prepared, undefined)
})

test('dry-run routes requested reasoning through ODW adapters', () => {
  const result = runDryRun({
    models: [
      { label: 'review-high', model: 'gpt-5.5', reasoning: 'high', role: 'high' },
      { label: 'review-medium', model: 'gpt-5.5', reasoning: 'medium', role: 'medium' },
      { label: 'review-mini', model: 'gpt-5.4-mini', reasoning: 'low', role: 'mini' },
      { label: 'review-spark', model: 'gpt-5.3-codex-spark', reasoning: 'low', role: 'spark' },
    ],
    synthesisModel: 'gpt-5.5',
    synthesisReasoning: 'medium',
  })

  const tasksByKind = new Map(result.defaultTaskGraph.map((task) => [task.kind, task]))
  assert.equal(tasksByKind.get('source').adapter, 'codex-high')
  assert.equal(tasksByKind.get('source').model, 'gpt-5.5')
  assert.equal(tasksByKind.get('tests').adapter, 'codex-medium')
  assert.equal(tasksByKind.get('tests').model, 'gpt-5.5')
  assert.equal(tasksByKind.get('docs').adapter, 'codex-low')
  assert.equal(tasksByKind.get('docs').model, 'gpt-5.4-mini')
  assert.equal(tasksByKind.get('config').adapter, 'codex-low')
  assert.equal(tasksByKind.get('review-summary').adapter, 'codex-low')
  assert.equal(result.synthesisAdapter, 'codex-medium')
  assert.equal(result.synthesisModel, 'gpt-5.5/medium')
})

test('dry-run rejects malformed model and limit inputs in favour of safe defaults', () => {
  const result = runDryRun({
    maxTasks: 'not-a-number',
    maxCandidates: 0,
    maxFindings: -4,
    models: [],
  })

  assert.deepEqual(result.limits, { maxTasks: 8, maxCandidates: 30, maxFindings: 20, maxAuditCandidates: 30 })
  assert.deepEqual(result.models, [
    'gpt-5.5/medium',
    'gpt-5.5/high',
    'gpt-5.4-mini/medium',
    'gpt-5.3-codex-spark/medium',
  ])
})

test('dry-run always retains the mandatory review summary within a small task budget', () => {
  const result = runDryRun({ maxTasks: 1 })
  assert.equal(result.defaultTaskGraph.length, 1)
  assert.equal(result.defaultTaskGraph[0].kind, 'review-summary')
})

test('dry-run clamps oversized limits to explicit ceilings', () => {
  const result = runDryRun({ maxTasks: 999, maxCandidates: 9999, maxFindings: 999 })
  assert.deepEqual(result.limits, { maxTasks: 64, maxCandidates: 1000, maxFindings: 200, maxAuditCandidates: 30 })
})

test('dry-run treats positive sub-unit limits as invalid defaults', () => {
  const result = runDryRun({ maxTasks: 0.5, maxCandidates: 0.9, maxFindings: 0.1 })
  assert.deepEqual(result.limits, { maxTasks: 8, maxCandidates: 30, maxFindings: 20, maxAuditCandidates: 30 })
})
