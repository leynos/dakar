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

import { resolveReviewConfig } from '../scripts/review-config.mjs'

test('explicit config paths must exist', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'dakar-config-repo-'))
  const result = resolveReviewConfig({ repoRoot, config: 'missing.yaml' })

  assert.equal(result.ok, false)
  assert.equal(result.source, 'explicit')
  assert.match(result.error, /explicit config does not exist/u)
  assert.equal(result.checked.length, 1)
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
