/**
 * @file Exercise the documentation gate end to end against fixture modules.
 *
 * `makefile-docs-gate.test.mjs` proves the gate is wired into `make check`;
 * this suite proves the gate actually decides. It runs TypeDoc over throwaway
 * fixtures using the repository's own `typedoc.json` — only the entry points
 * and tsconfig are redirected — so a weakened setting here (say `notDocumented`
 * turned off, or warnings no longer fatal) breaks these tests rather than
 * silently disarming the gate.
 *
 * This replaces the end-to-end coverage lost when the docstring audit and its
 * CLI-boundary test were retired. `emit` is `none`, so no documentation
 * artefacts are written.
 *
 * That linkage was proved by mutation on 2026-09-07 against typedoc 0.28.20.
 * Clearing each setting in `typedoc.json` in turn fails the configuration case
 * plus exactly the behavioural cases that depend on it:
 *
 * - `validation.notDocumented: false` fails two, the undocumented export and
 *   the missing module header, one per diagnostic site.
 * - `validation.invalidLink: false` fails the unresolvable-link case.
 * - `validation.invalidPath: false` fails the relative-path case. That
 *   validation covers relative links in comments, not `@document` targets.
 * - removing `treatWarningsAsErrors` fails the unknown-block-tag case. TypeDoc
 *   exits 0 for an unknown block tag while still printing the warning, so this
 *   flag is what stops the gate passing over a comment it cannot understand.
 * - removing `treatValidationWarningsAsErrors` fails no behavioural case,
 *   because `treatWarningsAsErrors` already promotes validation warnings along
 *   with the rest. It stays as the narrower guarantee, so dropping the broader
 *   flag later still leaves validation findings fatal; the configuration case
 *   is what holds it in place.
 *
 * @module
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TYPEDOC_BIN = join(REPO_ROOT, 'node_modules', 'typedoc', 'bin', 'typedoc')
const GATE_OPTIONS = JSON.parse(readFileSync(join(REPO_ROOT, 'typedoc.json'), 'utf8'))

/** A fixture tsconfig narrow enough to compile one module in isolation. */
const FIXTURE_TSCONFIG = {
  compilerOptions: {
    module: 'ESNext',
    moduleResolution: 'Bundler',
    target: 'ES2024',
    noEmit: true,
    strict: true,
    skipLibCheck: true,
  },
  include: ['*.ts'],
}

/** A companion module, always documented, so the fixture has two modules.
 *
 * TypeDoc only raises a `Module` reflection per entry point when more than one
 * exists; with a single file the module header rule cannot be exercised.
 */
const COMPANION_MODULE = `/**\n * Companion fixture module.\n *\n * @module\n */\n\n/** A documented exported value. */\nexport const companion = 1\n`

/**
 * Run the documentation gate over one fixture module.
 *
 * The gate configuration is the repository's own `typedoc.json` with the entry
 * points and tsconfig redirected at the fixture, so the real validation rules
 * decide the outcome. `name` is set because TypeDoc warns when it cannot find
 * a package.json, and that warning would otherwise be fatal here.
 *
 * @param {string} source - contents of the fixture module.
 * @returns {{ status: number, output: string }} exit status and combined output.
 */
function runGate(source) {
  const directory = mkdtempSync(join(tmpdir(), 'dakar-docs-gate-'))
  try {
    const { $schema, ...options } = GATE_OPTIONS

    writeFileSync(join(directory, 'typedoc.json'), JSON.stringify({
      ...options,
      name: 'fixture',
      entryPoints: ['sample.ts', 'companion.ts'],
      entryPointStrategy: 'expand',
      tsconfig: './tsconfig.json',
    }))
    writeFileSync(join(directory, 'tsconfig.json'), JSON.stringify(FIXTURE_TSCONFIG))
    writeFileSync(join(directory, 'companion.ts'), COMPANION_MODULE)
    writeFileSync(join(directory, 'sample.ts'), source)

    const result = spawnSync(process.execPath, [TYPEDOC_BIN, '--options', 'typedoc.json'], {
      cwd: directory,
      encoding: 'utf8',
    })
    return { status: result.status, output: `${result.stdout}${result.stderr}` }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

/** A module header in the form the gate requires. */
const MODULE_HEADER = `/**\n * Sample fixture module.\n *\n * @module\n */\n`

test('the committed configuration keeps every gate setting armed', () => {
  assert.deepEqual(GATE_OPTIONS.validation, {
    notDocumented: true,
    notExported: false,
    invalidLink: true,
    invalidPath: true,
    rewrittenLink: false,
    unusedMergeModuleWith: false,
  })
  assert.equal(GATE_OPTIONS.treatWarningsAsErrors, true)
  assert.equal(GATE_OPTIONS.treatValidationWarningsAsErrors, true)
})

test('the gate passes a fully documented module', () => {
  const { status, output } = runGate(`${MODULE_HEADER}\n/** A documented exported value. */\nexport const documented = 1\n`)

  assert.equal(status, 0, `expected a clean run, got:\n${output}`)
  assert.doesNotMatch(output, /does not have any documentation/)
})

test('the gate fails an undocumented export and names the declaration', () => {
  const { status, output } = runGate(`${MODULE_HEADER}\nexport const undocumentedValue = 1\n`)

  assert.notEqual(status, 0, 'an undocumented export must fail the gate')
  assert.match(output, /undocumentedValue \(Variable\).*does not have any documentation/s)
})

test('the gate fails a module with no module header', () => {
  const { status, output } = runGate('/** A documented exported value. */\nexport const documented = 1\n')

  assert.notEqual(status, 0, 'a module without a header must fail the gate')
  assert.match(output, /sample \(Module\).*does not have any documentation/s)
})

test('the gate fails a link to a symbol that is not documented', () => {
  const { status, output } = runGate(
    `${MODULE_HEADER}\n/** A documented exported value. See {@link nonExistentSymbol}. */\nexport const documented = 1\n`,
  )

  assert.notEqual(status, 0, 'an unresolvable link must fail the gate')
  assert.match(output, /Failed to resolve link to "nonExistentSymbol"/)
})

test('the gate fails a relative link that names no file', () => {
  const { status, output } = runGate(
    `${MODULE_HEADER}\n/** A documented exported value. See [the note](./missing-note.md). */\nexport const documented = 1\n`,
  )

  assert.notEqual(status, 0, 'an unresolvable relative path must fail the gate')
  assert.match(output, /The relative path \.\/missing-note\.md is not a file/)
})

test('the gate fails an unknown block tag rather than warning silently', () => {
  const header = MODULE_HEADER.replace(' * @module\n', ' * @file scripts/sample.mjs\n * @module\n')
  const { status, output } = runGate(`${header}\n/** A documented exported value. */\nexport const documented = 1\n`)

  assert.notEqual(status, 0, 'an unknown block tag must fail the gate')
  assert.match(output, /Encountered an unknown block tag @file/)
})
