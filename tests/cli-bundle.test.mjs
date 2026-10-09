/**
 * Verifies the shipped CLI entry point and isolated CLI build/freshness behaviour.
 *
 * @module
 */

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { repoRoot, setUpRecordRepo, writePreparedEchoOdw } from './cli-test-support.mjs'

process.env.DAKAR_SKIP_CONTEXT_WARMUP = '1'

test('the shipped CLI bundle forwards prepared workflow arguments and records the result', (t) => {
  const { tempRoot, targetRepo, base, head } = setUpRecordRepo()
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }))
  execFileSync('git', ['-C', targetRepo, 'remote', 'add', 'origin', 'https://github.com/owner/repository.git'])
  const fakeOdw = join(tempRoot, 'odw.mjs')
  writePreparedEchoOdw(fakeOdw, { captureArgs: true })
  const stateRoot = join(tempRoot, 'state')
  const result = spawnSync(process.execPath, [
    join(repoRoot, 'bin', 'dakar-review.bundle.mjs'), '--repo-root', targetRepo,
    '--base', base, '--state-root', stateRoot, '--odw-bin', fakeOdw,
    '--runs-root', join(tempRoot, 'runs'), '--luna-reasoning', 'medium',
    '--transaction-max-output-tokens', '2100', '--terra-max-output-tokens', '5100',
  ], { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, DAKAR_SKIP_CONTEXT_WARMUP: '1' } })
  assert.equal(result.status, 0, result.stderr)
  const output = JSON.parse(result.stdout)
  assert.equal(output.ok, true, 'the shipped bundle must execute a non-meta review path')
  assert.equal(output.headCommit, head, 'the bundle must forward the prepared reviewed head')
  assert.equal(output.reviewBase, base, 'the bundle must forward the trusted review base')
  assert.deepEqual(output.changedFiles, ['b.txt'], 'the bundle must forward the prepared changed-file list')
  assert.match(output.receivedArgs.contextGuidance, /CodeGraph/u, 'the bundle must forward CodeGraph finder guidance')
  assert.match(output.receivedArgs.contextGuidance, /DeepWiki/u, 'the bundle must forward repository-scoped DeepWiki guidance')
  assert.equal(output.receivedArgs.lunaReasoning, 'medium', 'the bundle must forward the selected Luna reasoning')
  assert.equal(output.receivedArgs.transactionMaxOutputTokens, 2100, 'the bundle must forward the finder output-token estimate')
  assert.equal(output.receivedArgs.terraMaxOutputTokens, 5100, 'the bundle must forward the audit output-token estimate')
  assert.equal(output.recorded.ok, true, 'the shipped bundle must preserve successful recording behaviour')
})

/** Runs the real CLI build script against isolated authored source and output. */
function runFixtureBuild(script, args = []) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: process.env })
}

test('CLI build writes an executable bundle and freshness rejects stale or missing output', (t) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'dakar-cli-build-'))
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }))
  mkdirSync(join(fixtureRoot, 'scripts'))
  mkdirSync(join(fixtureRoot, 'bin'))
  symlinkSync(join(repoRoot, 'node_modules'), join(fixtureRoot, 'node_modules'), 'dir')
  const script = join(fixtureRoot, 'scripts', 'build-cli.mjs')
  copyFileSync(join(repoRoot, 'scripts', 'build-cli.mjs'), script)
  writeFileSync(join(fixtureRoot, 'bin', 'dakar-review.mjs'), '/** Fixture entry point. @module */\nprocess.stdout.write("fixture")\n')
  const output = join(fixtureRoot, 'bin', 'dakar-review.bundle.mjs')

  const missing = runFixtureBuild(script, ['--check'])
  assert.equal(missing.status, 1, 'missing output must fail freshness')
  assert.match(missing.stderr, /is stale; run `npm run cli:build`/u, 'missing output must retain the stale diagnostic')
  const built = runFixtureBuild(script)
  assert.equal(built.status, 0, built.stderr)
  assert.match(built.stdout, /dakar-review\.bundle\.mjs: built \(\d+ bytes\)/u, 'build must report its generated output')
  assert.equal(statSync(output).mode & 0o777, 0o755, 'build must mark its output executable')
  assert.match(readFileSync(output, 'utf8'), /process\.stdout\.write\("fixture"\)/u, 'the bundle must contain the authored entry point')
  const fresh = runFixtureBuild(script, ['--check'])
  assert.equal(fresh.status, 0, fresh.stderr)
  writeFileSync(output, '// stale\n')
  const stale = runFixtureBuild(script, ['--check'])
  assert.equal(stale.status, 1, 'changed output must fail freshness')
  assert.match(stale.stderr, /is stale; run `npm run cli:build`/u, 'changed output must retain the stale diagnostic')
  assert.equal(readFileSync(output, 'utf8'), '// stale\n', 'check-only mode must not rewrite stale output')
})
