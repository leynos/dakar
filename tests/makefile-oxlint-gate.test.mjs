/**
 * Verify the Oxlint lint target and its selected Unicorn rules.
 *
 * @module
 */

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

test('lint reaches the Oxlint script in a Make dry run', () => {
  const { MAKEFLAGS, MFLAGS, ...env } = process.env
  const output = execFileSync('make', ['--dry-run', 'lint'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env,
  })

  assert.match(output, /^npm run lint:oxlint$/m)
})

test('the Oxlint script uses the config and covers each authored application path', () => {
  const { scripts } = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))

  assert.equal(
    scripts['lint:oxlint'],
    'oxlint --config oxlint.config.mjs adapters bin/dakar-review.mjs scripts src',
  )
})

test('the configured Unicorn rules reject forEach and hexadecimal escapes', (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'dakar-oxlint-'))
  t.after(() => rmSync(scratch, { recursive: true, force: true }))

  const fixture = join(scratch, 'unicorn-rules.js')
  writeFileSync(
    fixture,
    String.raw`const values = ['item']
values.forEach((value) => {
  void value
})
const escaped = '\x41'
void escaped
`,
  )

  const oxlint = join(REPO_ROOT, 'node_modules', '.bin', 'oxlint')
  const config = join(REPO_ROOT, 'oxlint.config.mjs')
  const result = spawnSync(oxlint, ['--config', config, '--format', 'json', fixture], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })

  assert.ifError(result.error)
  assert.notEqual(result.status, 0, 'the configured rules must reject the fixture')

  const diagnostics = `${result.stdout}${result.stderr}`
  assert.ok(diagnostics.includes('unicorn/no-array-for-each'), diagnostics)
  assert.ok(diagnostics.includes('unicorn/no-hex-escape'), diagnostics)
})
