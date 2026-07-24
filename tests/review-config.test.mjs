/**
 * @file Verify Dakar review-configuration resolution.
 *
 * The tests exercise explicit paths and fallback precedence for the helper
 * shared by the CLI and the ODW workflow.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { parseReviewPolicy, resolveReviewConfig } from '../scripts/review-config.mjs'

test('explicit config paths must exist', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'dakar-config-repo-'))
  const result = resolveReviewConfig({ repoRoot, config: 'missing.yaml' })

  assert.equal(result.ok, false)
  assert.equal(result.source, 'explicit')
  assert.match(result.error, /explicit config does not exist/u)
  assert.equal(result.checked.length, 1)
})

test('explicit and repository filename precedence remains stable', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'dakar-config-repo-'))
  const explicit = join(repoRoot, 'explicit.yaml')
  for (const [path, profile] of [
    ['.coderabbit.yaml', 'dot-yaml'],
    ['.coderabbit.yml', 'dot-yml'],
    ['coderabbit.yaml', 'plain-yaml'],
    ['coderabbit.yml', 'plain-yml'],
    ['explicit.yaml', 'explicit'],
  ]) {
    writeFileSync(join(repoRoot, path), `reviews:\n  profile: ${profile}\n`)
  }

  const repository = resolveReviewConfig({ repoRoot })
  const selectedExplicit = resolveReviewConfig({ repoRoot, config: explicit })

  assert.equal(repository.config, join(repoRoot, '.coderabbit.yaml'))
  assert.equal(repository.policy.profile, 'dot-yaml')
  assert.equal(selectedExplicit.config, explicit)
  assert.equal(selectedExplicit.source, 'explicit')
  assert.equal(selectedExplicit.policy.profile, 'explicit')
})

test('repository config wins over user config', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'dakar-config-repo-'))
  const xdgConfig = mkdtempSync(join(tmpdir(), 'dakar-config-xdg-'))
  const repoConfig = join(repoRoot, '.coderabbit.yaml')
  const userConfig = join(xdgConfig, 'dakar', 'config.yaml')
  mkdirSync(join(xdgConfig, 'dakar'), { recursive: true })
  writeFileSync(repoConfig, 'reviews:\n  profile: repo\n')
  writeFileSync(userConfig, 'reviews:\n  profile: user\n')

  const result = resolveReviewConfig({
    repoRoot,
    env: { XDG_CONFIG_HOME: xdgConfig },
  })

  assert.equal(result.ok, true)
  assert.equal(result.source, 'repository')
  assert.equal(result.config, repoConfig)
  assert.equal(result.policy.profile, 'repo')
})

test('bundled example is used only when it exists', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'dakar-config-repo-'))
  const xdgConfig = mkdtempSync(join(tmpdir(), 'dakar-config-xdg-'))
  const packageRoot = mkdtempSync(join(tmpdir(), 'dakar-package-'))
  const bundledExample = join(packageRoot, 'examples', 'df12-code-review.yaml')
  mkdirSync(join(packageRoot, 'examples'), { recursive: true })
  writeFileSync(bundledExample, 'reviews:\n  profile: bundled\n')

  const result = resolveReviewConfig({
    repoRoot,
    packageRoot,
    env: { XDG_CONFIG_HOME: xdgConfig },
  })

  assert.equal(result.ok, true)
  assert.equal(result.source, 'example')
  assert.equal(result.config, bundledExample)
  assert.equal(result.checked.at(-1), bundledExample)
})

test('missing bundled example returns a no-config failure', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'dakar-config-repo-'))
  const xdgConfig = mkdtempSync(join(tmpdir(), 'dakar-config-xdg-'))
  const packageRoot = mkdtempSync(join(tmpdir(), 'dakar-package-'))
  const bundledExample = join(packageRoot, 'examples', 'df12-code-review.yaml')

  const result = resolveReviewConfig({
    repoRoot,
    packageRoot,
    env: { XDG_CONFIG_HOME: xdgConfig },
  })

  assert.equal(result.ok, false)
  assert.equal(result.source, 'example')
  assert.equal(result.config, bundledExample)
  assert.equal(result.checked.at(-1), bundledExample)
  assert.match(result.error, /bundled example config does not exist/u)
})

test('supported policy fields normalize without retaining unsupported values', () => {
  const policy = parseReviewPolicy(`
language: en-GB
tone_instructions: Be direct.
early_access: true
reviews:
  profile: assertive
  request_changes_workflow: true
  path_instructions:
    - path: "**/*.{js,ts}"
      instructions: Keep modules cohesive.
pre_merge_checks:
  custom_checks:
    - name: Tests
      command: make test
    - name: Advisory semantics
      mode: warning
      instructions: Check the public contract.
`, { configPath: '/repo/.coderabbit.yaml' })

  assert.deepEqual(policy, {
    version: 1,
    language: 'en-GB',
    toneInstructions: 'Be direct.',
    profile: 'assertive',
    pathInstructions: [{
      policyRef: 'reviews.path_instructions[0]',
      path: '**/*.{js,ts}',
      instructions: 'Keep modules cohesive.',
    }],
    customChecks: [
      { gateId: 'gate-001-tests', name: 'Tests', blocking: true, command: 'make test' },
      {
        gateId: 'gate-002-advisory-semantics',
        name: 'Advisory semantics',
        blocking: false,
        instructions: 'Check the public contract.',
      },
    ],
    ignoredKeys: ['early_access', 'reviews.request_changes_workflow'],
  })
  assert.equal(policy.early_access, undefined)
})

test('malformed YAML and custom tags fail with the resolved path', () => {
  for (const source of ['reviews: [', 'value: !unsafe constructor']) {
    assert.throws(
      () => parseReviewPolicy(source, { configPath: '/repo/policy.yaml' }),
      /\/repo\/policy\.yaml: invalid YAML/u,
    )
  }
})

test('malformed YAML diagnostics never echo the source line', () => {
  const secret = 'sk-example-secret-that-must-not-reach-logs'
  assert.throws(() => {
    parseReviewPolicy(`reviews: [${secret}`, { configPath: '/repo/policy.yaml' })
  }, (error) =>
    error instanceof Error &&
    error.message.includes('/repo/policy.yaml: invalid YAML: could not parse at line') &&
    !error.message.includes(secret))
})

test('invalid supported field shapes fail with an actionable field path', () => {
  for (const [source, field] of [
    ['reviews:\\n  path_instructions: wrong', 'reviews.path_instructions'],
    ['reviews:\\n  path_instructions:\\n    - path: 42\\n      instructions: text', 'reviews.path_instructions[0].path'],
    ['pre_merge_checks:\\n  custom_checks:\\n    - name: Check\\n      mode: fatal\\n      command: make test', 'pre_merge_checks.custom_checks[0].mode'],
  ]) {
    assert.throws(() => {
      parseReviewPolicy(source.replaceAll('\\n', '\n'), { configPath: '/repo/policy.yaml' })
    }, (error) => error instanceof Error && error.message.includes(`/repo/policy.yaml: invalid ${field}`))
  }
})
