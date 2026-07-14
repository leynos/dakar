/** @file Unit-test prompt construction from TypeScript source. */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  agentInstructionsBlock,
  preparePrompt,
  recordPrompt,
  resolveConfigPrompt,
  synthesisPrompt,
  taskPrompt,
  verificationPrompt,
} from '../src/workflows/dakar-review/prompts.ts'

const CONTEXT = {
  agentInstructions: null,
  policyPath: '.coderabbit.yaml',
  repoRoot: '/tmp/repo with spaces',
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

test('helper prompts shell-quote repository, refs, and optional paths', () => {
  const configPrompt = resolveConfigPrompt(CONTEXT, "reviewer's config.yaml")
  assert.match(configPrompt, /--repo-root '\/tmp\/repo with spaces'/u)
  assert.match(configPrompt, /--config 'reviewer'"'"'s config\.yaml'/u)

  const statePrompt = preparePrompt(CONTEXT, 'origin/main', 'feature branch', '/tmp/state root')
  assert.match(statePrompt, /--base 'origin\/main' --head 'feature branch'/u)
  assert.match(statePrompt, /--state-root '\/tmp\/state root'/u)
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

test('dynamic verifier, synthesis, and record data follow stable instructions and use resolved policy', () => {
  const prepared = { reviewBase: 'base-sha', headCommit: 'head-sha', changedFiles: ['src/a.ts'] }
  const candidate = {
    candidateId: 'source-1:key', taskId: 'source-1', taskKind: 'source', sourceModel: 'gpt-5.5/high',
    verificationPolicy: 'verify-all', title: 'Bug', path: 'src/a.ts', line: 1, policyRefs: [],
  }
  const verify = verificationPrompt(candidate, prepared, CONTEXT)
  assert.ok(verify.indexOf('Verification rules:') < verify.indexOf('Candidate JSON:'))
  assert.match(verify, /CodeRabbit YAML: \.coderabbit\.yaml/u)

  const synthesis = synthesisPrompt([candidate], { duplicate: 1 }, prepared, CONTEXT)
  assert.ok(synthesis.indexOf('Report rules:') < synthesis.indexOf('Accepted candidates:'))
  assert.match(synthesis, /Resolved CodeRabbit YAML: \.coderabbit\.yaml/u)

  const record = recordPrompt({ headCommit: 'head-sha' }, CONTEXT)
  assert.ok(record.indexOf('Record the completed review') < record.indexOf('"headCommit"'))
  assert.match(record, /Resolved CodeRabbit YAML: \.coderabbit\.yaml/u)
})
