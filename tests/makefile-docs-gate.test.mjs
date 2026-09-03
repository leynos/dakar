/**
 * @file Pin the wiring that puts the documentation gate inside `make check`.
 *
 * The gate's value depends on it actually running: `docs-check` must invoke the
 * documentation script, and `lint` — and therefore `check` — must reach it. A
 * rename or a dropped prerequisite would leave the gate present but unreachable,
 * which no other test would notice.
 *
 * Scope is deliberately narrow. These cases assert target wiring and the
 * arguments the recipe assembles, not TypeDoc's own behaviour. `make -n` prints
 * each recipe without running it, so the suite resolves the real dependency
 * graph without invoking TypeDoc.
 *
 * @module
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Print the recipes `make` would run for a target, without running them.
 *
 * `MAKEFLAGS` and `MFLAGS` are stripped because this suite itself runs under
 * `make test`; inheriting the outer invocation's flags would otherwise leak
 * into the dry run and make the result depend on how the tests were started.
 *
 * @param {string} target - Make target to resolve.
 * @returns {string} the recipe lines Make would execute.
 */
function dryRun(target) {
  const { MAKEFLAGS, MFLAGS, ...env } = process.env
  return execFileSync('make', ['--dry-run', target], { cwd: REPO_ROOT, encoding: 'utf8', env })
}

/** The package script the `docs-check` target delegates to. */
const DOCS_SCRIPT = 'npm run docs:check'

test('docs-check runs the documentation gate script', () => {
  assert.match(dryRun('docs-check'), new RegExp(`^${DOCS_SCRIPT}$`, 'm'))
})

test('lint reaches the documentation gate', () => {
  assert.match(dryRun('lint'), new RegExp(`^${DOCS_SCRIPT}$`, 'm'))
})

test('check reaches the documentation gate', () => {
  assert.match(dryRun('check'), new RegExp(`^${DOCS_SCRIPT}$`, 'm'))
})

test('the docs:check script assembles the TypeDoc options file', () => {
  const { scripts } = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))

  assert.equal(scripts['docs:check'], 'typedoc --options typedoc.json')
  assert.ok(existsSync(join(REPO_ROOT, 'typedoc.json')), 'the referenced options file must exist')
})

test('the retired docstring audit is no longer wired in', () => {
  const { scripts } = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
  const makefile = readFileSync(join(REPO_ROOT, 'Makefile'), 'utf8')

  assert.equal(scripts.docstrings, undefined)
  assert.doesNotMatch(makefile, /docstrings|check-docstrings/)
})
