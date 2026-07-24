/** @file Test dependency-free deterministic gate configuration and execution. */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { loadAndRunDeterministicGates, parseDeterministicGates } from '../scripts/deterministic-gates.mjs'

test('parseDeterministicGates extracts only explicit executable custom checks', () => {
  const gates = parseDeterministicGates(`
reviews:
  profile: assertive
  pre_merge_checks:
    custom_checks:
      - mode: error
        name: Unit tests
        command: "node --test"
      - mode: warning
        name: Advisory lint
        command: npm run lint
      - mode: error
        name: Model-only policy
        instructions: inspect this semantically
`)

  assert.deepEqual(gates, [
    { gateId: 'gate-001-unit-tests', name: 'Unit tests', command: 'node --test', blocking: true },
    { gateId: 'gate-002-advisory-lint', name: 'Advisory lint', command: 'npm run lint', blocking: false },
  ])
})

test('loadAndRunDeterministicGates records pass, blocking failure, and non-blocking failure', () => {
  const root = mkdtempSync(join(tmpdir(), 'dakar-gates-'))
  const config = join(root, '.coderabbit.yaml')
  try {
    writeFileSync(config, `
pre_merge_checks:
  custom_checks:
    - mode: error
      name: Passing
      command: node -e "process.stdout.write('ok')"
    - mode: error
      name: Blocking
      command: node -e "process.stderr.write('broken'); process.exit(3)"
    - mode: warning
      name: Advisory
      command: node -e "process.exit(4)"
`)
    const results = loadAndRunDeterministicGates(config, root)

    assert.deepEqual(results.map(({ status, blocking, exitCode }) => ({ status, blocking, exitCode })), [
      { status: 'passed', blocking: true, exitCode: 0 },
      { status: 'failed', blocking: true, exitCode: 3 },
      { status: 'failed', blocking: false, exitCode: 4 },
    ])
    assert.equal(results[0].stdout, 'ok')
    assert.equal(results[1].stderr, 'broken')
    assert.match(results[0].stdoutSha256, /^[0-9a-f]{64}$/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('gate evidence redacts secret environment values', () => {
  const root = mkdtempSync(join(tmpdir(), 'dakar-gates-secret-'))
  const config = join(root, '.coderabbit.yaml')
  const previous = process.env.DAKAR_TEST_SECRET_TOKEN
  try {
    process.env.DAKAR_TEST_SECRET_TOKEN = 'not-for-sarif'
    writeFileSync(config, `
pre_merge_checks:
  custom_checks:
    - mode: error
      name: Redaction
      command: node -e "process.stdout.write(process.env.DAKAR_TEST_SECRET_TOKEN)"
`)
    const [result] = loadAndRunDeterministicGates(config, root)

    assert.equal(result.stdout, '[REDACTED]')
    assert.doesNotMatch(JSON.stringify(result), /not-for-sarif/u)
  } finally {
    if (previous === undefined) delete process.env.DAKAR_TEST_SECRET_TOKEN
    else process.env.DAKAR_TEST_SECRET_TOKEN = previous
    rmSync(root, { recursive: true, force: true })
  }
})
