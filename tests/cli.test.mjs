import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

const repoRoot = resolve(new URL('..', import.meta.url).pathname)
const cliPath = join(repoRoot, 'bin', 'dakar-review.mjs')

function runCli(args) {
  return execFileSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

test('CLI help documents review invocation', () => {
  const output = runCli(['--help'])

  assert.match(output, /Usage: dakar-review/u)
  assert.match(output, /--repo-root <path>/u)
  assert.match(output, /--format <json\|markdown>/u)
})

test('CLI dry-run prints one machine-readable JSON result', () => {
  const runsRoot = mkdtempSync(join(tmpdir(), 'dakar-cli-runs-'))
  const output = runCli([
    '--dry-run',
    '--repo-root',
    repoRoot,
    '--runs-root',
    runsRoot,
    '--timeout',
    '20',
    '--max-tasks',
    '2',
  ])
  const result = JSON.parse(output)

  assert.equal(result.ok, true)
  assert.equal(result.dryRun, true)
  assert.equal(result.workflowVersion, 'divide-and-conquer-v1')
  assert.equal(result.repoRoot, repoRoot)
  assert.equal(result.synthesisAdapter, 'codex-high')
  assert.equal(result.limits.maxTasks, 2)
  assert.match(result.config, /examples\/df12-code-review\.yaml$/u)
})
