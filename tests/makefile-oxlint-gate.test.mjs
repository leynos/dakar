/**
 * Verify the Oxlint lint target and its selected Unicorn rules.
 *
 * @module
 */

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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

test('the configured Unicorn rules reject the four additional patterns', (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'dakar-oxlint-unicorn-'))
  t.after(() => rmSync(scratch, { recursive: true, force: true }))
  const fixture = join(scratch, 'additional-unicorn-rules.js')
  writeFileSync(fixture, `const values = [1, 2]
setTimeout(() => {})
const result = String(Number(String(Number('42'))))
const copy = values.with(-1, 3)
const amount = parseFloat(result)
void copy
void amount
`)

  const oxlint = join(REPO_ROOT, 'node_modules', '.bin', 'oxlint')
  const config = join(REPO_ROOT, 'oxlint.config.mjs')
  const result = spawnSync(oxlint, ['--config', config, '--format', 'json', fixture], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })

  assert.ifError(result.error)
  assert.equal(result.signal, null, 'the Unicorn lint process must not be interrupted')
  assert.notEqual(result.status, 0, 'the additional Unicorn rules must reject the fixture')
  const diagnostics = JSON.parse(result.stdout).diagnostics
  for (const rule of ['explicit-timer-delay', 'max-nested-calls', 'no-confusing-array-with', 'prefer-number-coercion']) {
    assert.ok(diagnostics.some((diagnostic) => diagnostic.code === `unicorn(${rule})`), `${rule} must report its violation`)
  }
})

test('the configured TypeScript rules reject floating promises and accept awaited promises', (t) => {
  const oxlint = join(REPO_ROOT, 'node_modules', '.bin', 'oxlint')
  const config = join(REPO_ROOT, 'oxlint.config.mjs')
  const runFixture = (name, source) => {
    const scratch = mkdtempSync(join(tmpdir(), 'dakar-oxlint-typescript-'))
    t.after(() => rmSync(scratch, { recursive: true, force: true }))
    symlinkSync(join(REPO_ROOT, 'node_modules'), join(scratch, 'node_modules'), 'dir')
    writeFileSync(join(scratch, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' },
      include: [name],
    }))
    writeFileSync(join(scratch, name), source)
    return spawnSync(oxlint, ['--config', config, '--format', 'json', name], { cwd: scratch, encoding: 'utf8' })
  }

  const floating = runFixture('floating-promise.ts', 'declare function work(): Promise<void>;\nwork();\n')
  assert.ifError(floating.error)
  assert.equal(floating.signal, null, 'the floating-promise lint process must not be interrupted')
  assert.notEqual(floating.status, 0, 'an unhandled promise must fail lint')
  const floatingDiagnostics = JSON.parse(floating.stdout).diagnostics
  assert.ok(floatingDiagnostics.some((diagnostic) => diagnostic.code === 'typescript(no-floating-promises)'), 'the floating promise must trigger the configured TypeScript rule')

  const handled = runFixture('handled-promise.ts', 'declare function work(): Promise<void>;\nawait work();\nexport { work };\n')
  assert.ifError(handled.error)
  assert.equal(handled.signal, null, 'the handled-promise lint process must not be interrupted')
  assert.equal(handled.status, 0, 'an awaited promise must pass lint')
  assert.deepEqual(JSON.parse(handled.stdout).diagnostics, [], 'the handled control must have no diagnostics')
})
