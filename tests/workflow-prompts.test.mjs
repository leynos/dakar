/** @file Unit-test prompt construction from TypeScript source. */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  agentInstructionsBlock,
  auditPrompt,
  taskPrompt,
  verificationPrompt,
} from '../src/workflows/dakar-review/prompts.ts'

const CONTEXT = {
  agentInstructions: null,
  policyPath: '.coderabbit.yaml',
  repoRoot: '/tmp/repo with spaces',
}

function auditCandidate(overrides = {}) {
  return {
    candidateId: 'source-1:src/a.ts:2:bug', taskId: 'source-1', taskKind: 'source', sourceModel: 'gpt-5.5/high',
    verificationPolicy: 'verify-all', title: 'Bug', severity: 'high', path: 'src/a.ts', line: 2,
    detail: 'Broken branch', evidence: 'diff line', confidence: 'high', policyRefs: [], ...overrides,
  }
}

test('agentInstructionsBlock reports absence and preserves sourced instructions', () => {
  assert.equal(
    agentInstructionsBlock(CONTEXT),
    'Repository AGENTS.md: none found at the repository root.',
  )

  const block = agentInstructionsBlock({
    ...CONTEXT,
    agentInstructions: { source: 'nested/AGENTS.md', content: 'Keep stdout clean.', truncated: true },
  })
  assert.match(block, /Repository AGENTS\.md source: nested\/AGENTS\.md/u)
  assert.match(block, /was truncated/u)
  assert.match(block, /Keep stdout clean\./u)
})

test('taskPrompt limits review commands to the assigned files', () => {
  const task = {
    taskId: 'source-1',
    kind: 'source',
    files: ['src/a.ts', 'src/file with spaces.ts'],
    assignedModel: 'gpt-5.5/high',
    modelLabel: 'codex-high',
    maxFindings: 6,
  }
  const prepared = { reviewBase: 'base-sha', headCommit: 'head-sha' }
  const prompt = taskPrompt(task, prepared, CONTEXT)

  assert.match(prompt, /Changed files for this task: src\/a\.ts, src\/file with spaces\.ts/u)
  assert.match(prompt, /diff 'base-sha\.\.head-sha' -- 'src\/a\.ts' 'src\/file with spaces\.ts'/u)
  assert.match(prompt, /Inspect only the changed range and files assigned to this task\./u)
  assert.ok(prompt.indexOf('Instructions:') < prompt.indexOf('Task id: source-1'))
})

test('taskPrompt omits the unscoped diff command for an empty task', () => {
  const prompt = taskPrompt({
    taskId: 'review-summary-1', kind: 'review-summary', files: [], assignedModel: 'gpt-5.5/high',
    modelLabel: 'codex-high', maxFindings: 3,
  }, { reviewBase: 'base-sha', headCommit: 'head-sha' }, CONTEXT)

  assert.match(prompt, /diff --stat/u)
  assert.doesNotMatch(prompt, /diff 'base-sha\.\.head-sha' --/u)
})

test('auditPrompt embeds compacted candidate JSON, policy path, AGENTS block, and budget note', () => {
  const prepared = { reviewBase: 'base-sha', headCommit: 'head-sha', changedFiles: ['src/a.ts', 'src/b.ts'] }
  const context = {
    ...CONTEXT,
    agentInstructions: { source: 'AGENTS.md', content: 'Prioritize security regressions.' },
  }
  const budgetNote = 'Remaining budget: this issue-set audit is the only remaining model call.'
  const prompt = auditPrompt([auditCandidate(), auditCandidate({ candidateId: 'source-1:src/b.ts:9:leak', path: 'src/b.ts' })], prepared, context, budgetNote)

  // The compacted candidates are embedded verbatim in the extractable block.
  const embedded = prompt.split('Candidate findings JSON:\n')[1].split('\n\nChanged files:')[0]
  const parsed = JSON.parse(embedded)
  assert.equal(parsed.length, 2)
  assert.equal(parsed[0].candidateId, 'source-1:src/a.ts:2:bug')

  assert.match(prompt, /Changed files: src\/a\.ts, src\/b\.ts/u)
  assert.match(prompt, /CodeRabbit YAML: \.coderabbit\.yaml/u)
  assert.match(prompt, /Prioritize security regressions\./u)
  assert.match(prompt, /Remaining budget: this issue-set audit is the only remaining model call\./u)
  // Adversarial duties from ADR 002's Terra boundary appear in the instructions.
  assert.match(prompt, /deduplicate/iu)
  assert.match(prompt, /clusterId/u)
  assert.match(prompt, /one verdict per candidate/iu)
  // Instructions precede the untrusted candidate data.
  assert.ok(prompt.indexOf('Audit duties:') < prompt.indexOf('Candidate findings JSON:'))
})

test('dynamic verifier data follows stable instructions and uses resolved policy', () => {
  const prepared = { reviewBase: 'base-sha', headCommit: 'head-sha', changedFiles: ['src/a.ts'] }
  const candidate = {
    candidateId: 'source-1:key', taskId: 'source-1', taskKind: 'source', sourceModel: 'gpt-5.5/high',
    verificationPolicy: 'verify-all', title: 'Bug', path: 'src/a.ts', line: 1, policyRefs: [],
  }
  const verify = verificationPrompt(candidate, prepared, CONTEXT)
  assert.ok(verify.indexOf('Verification rules:') < verify.indexOf('Candidate JSON:'))
  assert.match(verify, /CodeRabbit YAML: \.coderabbit\.yaml/u)
})
