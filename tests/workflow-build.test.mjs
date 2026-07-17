/** @file Exercise fail-closed workflow compilation and source boundaries. */

import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import ts from 'typescript'
import { buildWorkflow, WorkflowBuildError } from '../scripts/build-workflow.mjs'

async function fixture(t, { meta = 'export const meta = {}\n', main, modules = {} }) {
  const directory = await mkdtemp(path.join(tmpdir(), 'dakar-workflow-build-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(path.join(directory, 'meta.js'), meta)
  await writeFile(path.join(directory, 'main.ts'), main)
  for (const [name, source] of Object.entries(modules)) {
    await writeFile(path.join(directory, name), source)
  }
  return {
    srcDir: directory,
    entry: path.join(directory, 'main.ts'),
    banner: path.join(directory, 'meta.js'),
    outFile: path.join(directory, 'workflow.js'),
    runtimeModules: ['main.ts'],
  }
}

async function expectCode(options, code) {
  await assert.rejects(
    buildWorkflow(options),
    (error) => error instanceof WorkflowBuildError && error.code === code,
  )
}

test('builds the real workflow and verifies freshness without writing', async () => {
  const built = await buildWorkflow({ checkOnly: true })
  assert.match(
    built,
    /^\/\*\*\n \* @file Generated Dakar ODW workflow runtime artefact\.\n \*\n \* Built by `make workflow-build` from `src\/workflows\/dakar-review\/`\.\n \* Do not edit directly; edit the source tree and rebuild\.\n \*\//u,
  )
  assert.doesNotMatch(built, /^\/\/ (?:GENERATED FILE|Do not edit)/mu)
  assert.match(built, /^export const meta =/mu)
  assert.match(built, /return await workflowMain\(\)$/mu)
})

test('rejects an invalid metadata count', async (t) => {
  const options = await fixture(t, {
    meta: 'const meta = {}\n',
    main: 'async function workflowMain() {}\n',
  })
  await expectCode(options, 'BUILD_META_COUNT')
})

test('banner validation ignores commented metadata lookalikes', async (t) => {
  const options = await fixture(t, {
    meta: '/*\nexport const meta = { commented: true }\n*/\nexport const meta = {}\n',
    main: 'async function workflowMain() {}\n',
  })
  await buildWorkflow(options)
})

test('banner validation rejects dynamic imports as module syntax', async (t) => {
  const options = await fixture(t, {
    meta: 'export const meta = {}\nimport("external-package")\n',
    main: 'async function workflowMain() {}\n',
  })
  await expectCode(options, 'BUILD_MODULE_SYNTAX')

  const embedded = await fixture(t, {
    meta: 'export const meta = { value: import("external-package") }\n',
    main: 'async function workflowMain() {}\n',
  })
  await expectCode(embedded, 'BUILD_MODULE_SYNTAX')
})

test('rejects module wrappers', async (t) => {
  const options = await fixture(t, {
    main: 'function __esm() {}\nasync function workflowMain() { return __esm() }\n',
  })
  await expectCode(options, 'BUILD_MODULE_WRAPPER')
})

test('allows wrapper and module tokens inside inert strings', async (t) => {
  const options = await fixture(t, {
    main: 'const marker = "__esm( import( import.meta"\nasync function workflowMain() { return marker }\n',
  })
  await buildWorkflow(options)
})

test('rejects surviving dynamic module syntax', async (t) => {
  const options = await fixture(t, {
    main: 'const target = "external-package"\nasync function workflowMain() { return import(target) }\n',
  })
  await expectCode(options, 'BUILD_MODULE_SYNTAX')
})

test('rejects a declared runtime module absent from the graph', async (t) => {
  const options = await fixture(t, {
    main: 'async function workflowMain() {}\n',
    modules: { 'orphan.ts': 'export const orphan = true\n' },
  })
  await expectCode({ ...options, runtimeModules: ['main.ts', 'orphan.ts'] }, 'BUILD_ORPHAN_MODULE')
})

test('rejects a bundled source module absent from the manifest', async (t) => {
  const options = await fixture(t, {
    main: 'import { helper } from "./helper.ts"\nasync function workflowMain() { return helper }\n',
    modules: { 'helper.ts': 'export const helper = true\n' },
  })
  await expectCode({ ...options, runtimeModules: ['main.ts'] }, 'BUILD_ORPHAN_MODULE')
})

test('rejects a missing workflow entry', async (t) => {
  const options = await fixture(t, { main: 'async function anotherEntry() {}\n' })
  await expectCode(options, 'BUILD_ENTRY_COUNT')
})

test('rejects metadata with parser errors', async (t) => {
  const options = await fixture(t, {
    meta: 'export const meta = {\n',
    main: 'async function workflowMain() {}\n',
  })
  await expectCode(options, 'BUILD_META_COUNT')
})

test('check-only reports a stale artefact without replacing it', async (t) => {
  const options = await fixture(t, { main: 'async function workflowMain() {}\n' })
  await writeFile(options.outFile, 'stale content\n')
  await expectCode({ ...options, checkOnly: true }, 'BUILD_STALE_ARTEFACT')
  assert.equal(await readFile(options.outFile, 'utf8'), 'stale content\n')
})

test('check-only accepts an artefact whose only difference is CRLF line endings', async (t) => {
  const options = await fixture(t, { main: 'async function workflowMain() {}\n' })
  const artefact = await buildWorkflow(options)
  await writeFile(options.outFile, artefact.replace(/\n/gu, '\r\n'))

  await buildWorkflow({ ...options, checkOnly: true })
})

test('check-only maps a missing artefact to the stale diagnostic', async (t) => {
  const options = await fixture(t, { main: 'async function workflowMain() {}\n' })
  await expectCode({ ...options, checkOnly: true }, 'BUILD_STALE_ARTEFACT')
})

test('write mode atomically replaces the artefact and removes its temporary file', async (t) => {
  const options = await fixture(t, { main: 'async function workflowMain() { return "ok" }\n' })
  const artefact = await buildWorkflow(options)
  assert.equal(await readFile(options.outFile, 'utf8'), artefact)
  assert.deepEqual((await readdir(options.srcDir)).filter((name) => name.endsWith('.tmp')), [])
})

test('parallel builds use distinct temporary files', async (t) => {
  const options = await fixture(t, { main: 'async function workflowMain() { return "ok" }\n' })
  const results = await Promise.all([buildWorkflow(options), buildWorkflow(options), buildWorkflow(options)])
  assert.equal(new Set(results).size, 1)
  assert.deepEqual((await readdir(options.srcDir)).filter((name) => name.endsWith('.tmp')), [])
})

test('compiler CLI writes, checks, and reports a missing artefact', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'dakar-build-cli-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const output = path.join(directory, 'workflow.js')
  const script = fileURLToPath(new URL('../scripts/build-workflow.mjs', import.meta.url))
  const built = spawnSync(process.execPath, [script, '--out-file', output], {
    encoding: 'utf8',
    timeout: 20_000,
  })
  assert.equal(built.status, 0)
  assert.match(built.stderr, /workflow\.js: built/u)
  const checked = spawnSync(process.execPath, [script, '--check', '--out-file', output], {
    encoding: 'utf8',
    timeout: 20_000,
  })
  assert.equal(checked.status, 0)
  assert.match(checked.stderr, /workflow\.js: fresh/u)
  const missing = spawnSync(process.execPath, [script, '--check', '--out-file', `${output}.missing`], {
    encoding: 'utf8',
    timeout: 20_000,
  })
  assert.notEqual(missing.status, 0)
  assert.match(missing.stderr, /BUILD_STALE_ARTEFACT/u)
  const invalid = spawnSync(process.execPath, [script, '--out-file', '--check'], { encoding: 'utf8', timeout: 20_000 })
  assert.equal(invalid.status, 2)
  assert.match(invalid.stderr, /--out-file requires a path/u)
  for (const args of [['--unknown'], ['positional'], ['--check', '--check'], ['--out-file', output, '--out-file', output]]) {
    const rejected = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 20_000 })
    assert.equal(rejected.status, 2)
    assert.match(rejected.stderr, /unknown or duplicate argument/u)
  }
})

async function runtimeSourceFiles(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const url = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, directory)
    if (entry.isDirectory()) {
      files.push(...(await runtimeSourceFiles(url)))
    } else if (/\.(?:[cm]?[jt]s)$/u.test(entry.name) && entry.name !== 'main.ts' && !entry.name.endsWith('.d.ts')) {
      files.push(url)
    }
  }
  return files
}

test('only main.ts calls injected ODW primitives', async () => {
  const sourceDirectory = new URL('../src/workflows/dakar-review/', import.meta.url)
  const primitives = new Set(['agent', 'parallel', 'pipeline', 'phase', 'log', 'sleep', 'workflow', 'validate'])
  const files = await runtimeSourceFiles(sourceDirectory)
  for (const file of files) {
    const calls = primitiveCalls(fileURLToPath(file), primitives)
    assert.deepEqual(calls, [], `${file.pathname} must not call an injected ODW primitive`)
  }
})

function primitiveCalls(file, primitives) {
  const program = ts.createProgram([file], { allowJs: true, noResolve: true, target: ts.ScriptTarget.Latest })
  const checker = program.getTypeChecker()
  const sourceFile = program.getSourceFile(file)
  const aliases = new Set()
  const aliasEdges = []
  const calls = []
  const unwrapped = (node) => {
    let current = node
    while (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isTypeAssertionExpression(current)
    ) {
      current = current.expression
    }
    while (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      current = unwrapped(current.right)
    }
    return current
  }
  const visitAliases = (node) => {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
      const initializer = unwrapped(node.initializer)
      if (ts.isIdentifier(initializer)) {
        const alias = checker.getSymbolAtLocation(node.name)
        const source = checker.getSymbolAtLocation(initializer)
        if (alias) {
          if (primitives.has(initializer.text) && source === undefined) aliases.add(alias)
          else if (source) aliasEdges.push([alias, source])
        }
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      const initializer = unwrapped(node.right)
      if (ts.isIdentifier(initializer)) {
        const alias = checker.getSymbolAtLocation(node.left)
        const source = checker.getSymbolAtLocation(initializer)
        if (alias) {
          if (primitives.has(initializer.text) && source === undefined) aliases.add(alias)
          else if (source) aliasEdges.push([alias, source])
        }
      }
    }
    ts.forEachChild(node, visitAliases)
  }
  visitAliases(sourceFile)
  let changed = true
  while (changed) {
    changed = false
    for (const [alias, source] of aliasEdges) {
      if (aliases.has(source) && !aliases.has(alias)) {
        aliases.add(alias)
        changed = true
      }
    }
  }
  const visitCalls = (node) => {
    if (ts.isCallExpression(node)) {
      const expression = unwrapped(node.expression)
      if (ts.isIdentifier(expression)) {
        const symbol = checker.getSymbolAtLocation(expression)
        if ((primitives.has(expression.text) && symbol === undefined) || (symbol && aliases.has(symbol))) {
          calls.push(expression.text)
        }
      }
      if (ts.isPropertyAccessExpression(expression) && ['call', 'apply', 'bind'].includes(expression.name.text)) {
        const receiver = unwrapped(expression.expression)
        if (ts.isIdentifier(receiver)) {
          const symbol = checker.getSymbolAtLocation(receiver)
          if ((primitives.has(receiver.text) && symbol === undefined) || (symbol && aliases.has(symbol))) {
            calls.push(receiver.text)
          }
        }
      }
    }
    ts.forEachChild(node, visitCalls)
  }
  visitCalls(sourceFile)
  return calls
}

test('primitive analysis finds wrapped aliases but allows local bindings', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'dakar-primitive-guard-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const unsafe = path.join(directory, 'unsafe.mts')
  const safe = path.join(directory, 'safe.ts')
  await writeFile(
    unsafe,
    'const first = phase\nconst invoke = first\nlet assigned\nassigned = phase\n;(invoke as typeof phase) ("Review")\ninvoke.call(null, "Verify")\nphase.bind(null)("Bound")\n;(0, phase)("Record")\nassigned("Plan")\n',
  )
  await writeFile(safe, 'const phase = (value: string) => value\nphase("local")\n')
  const primitives = new Set(['phase'])
  assert.deepEqual(primitiveCalls(unsafe, primitives), ['invoke', 'invoke', 'phase', 'phase', 'assigned'])
  assert.deepEqual(primitiveCalls(safe, primitives), [])
})
