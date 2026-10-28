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
