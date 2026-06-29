import { execFileSync } from 'node:child_process'
import test from 'node:test'
import assert from 'node:assert/strict'

function runDryRun(args = {}) {
  const output = execFileSync(
    'odw',
    [
      'run',
      'workflows/coderabbit-code-review.js',
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
  assert.equal(result.synthesisModel, 'gpt-5.5/high')
  assert.equal(result.synthesisAdapter, 'codex-high')
  assert.deepEqual(result.taskKinds, ['docs', 'config', 'tests', 'source', 'review-summary'])
  assert.equal(result.limits.maxTasks, 6)
  assert.equal(result.limits.maxCandidates, 12)
  assert.equal(result.limits.maxFindings, 4)
  assert.ok(Array.isArray(result.defaultTaskGraph))
  assert.ok(result.defaultTaskGraph.length >= 3)
  assert.ok(result.defaultTaskGraph.every((task) => task.taskId && task.assignedModel && task.adapter))
  assert.equal(result.candidateSchema.properties.candidates.type, 'array')
  assert.equal(result.verdictSchema.properties.status.enum.includes('accepted'), true)
  assert.equal(result.synthesisSchema.properties.reportMarkdown.type, 'string')
})
