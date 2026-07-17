/** @file Exercise the docstring coverage command at its CLI boundary. */

import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'

const script = fileURLToPath(new URL('../scripts/check-docstrings.mjs', import.meta.url))

/** Create an isolated Git repository for one command-level audit fixture. */
async function repository(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'dakar-docstrings-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const initialized = spawnSync('git', ['init', '--quiet'], { cwd: directory, encoding: 'utf8' })
  assert.equal(initialized.status, 0, initialized.stderr)
  return directory
}

/** Run the docstring command against the fixture's tracked sample file. */
function audit(directory) {
  return spawnSync(process.execPath, [script, 'sample.mjs'], {
    cwd: directory,
    encoding: 'utf8',
  })
}

test('docstring audit rejects an empty symbol scope', async (t) => {
  const directory = await repository(t)
  const result = audit(directory)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /no symbols discovered/u)
  assert.match(result.stdout, /0\/0 \(0\.00%; required 80\.00%\)/u)
})

test('docstring audit accepts a fully documented scope', async (t) => {
  const directory = await repository(t)
  await writeFile(path.join(directory, 'sample.mjs'), '/** @file Documented fixture. */\n')
  assert.equal(spawnSync('git', ['add', 'sample.mjs'], { cwd: directory }).status, 0)
  const result = audit(directory)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /1\/1 \(100\.00%; required 80\.00%\)/u)
})

test('docstring audit rejects a below-threshold scope', async (t) => {
  const directory = await repository(t)
  await writeFile(path.join(directory, 'sample.mjs'), 'function undocumented() {}\n')
  assert.equal(spawnSync('git', ['add', 'sample.mjs'], { cwd: directory }).status, 0)
  const result = audit(directory)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /undocumented <module>/u)
  assert.match(result.stderr, /undocumented undocumented/u)
  assert.match(result.stdout, /0\/2 \(0\.00%; required 80\.00%\)/u)
})
