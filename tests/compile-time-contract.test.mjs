/** @file Verify the contributor TypeScript contract rejects runtime syntax. */

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('..', import.meta.url)
const TSC = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))
const TSCONFIG = fileURLToPath(new URL('../tsconfig.json', import.meta.url))

test('tsconfig pins the erasable strict module contract', () => {
  const config = JSON.parse(readFileSync(new URL('../tsconfig.json', import.meta.url), 'utf8'))
  assert.deepEqual(
    {
      allowImportingTsExtensions: config.compilerOptions.allowImportingTsExtensions,
      erasableSyntaxOnly: config.compilerOptions.erasableSyntaxOnly,
      isolatedModules: config.compilerOptions.isolatedModules,
      module: config.compilerOptions.module,
      moduleResolution: config.compilerOptions.moduleResolution,
      noEmit: config.compilerOptions.noEmit,
      noUncheckedIndexedAccess: config.compilerOptions.noUncheckedIndexedAccess,
      strict: config.compilerOptions.strict,
      target: config.compilerOptions.target,
      verbatimModuleSyntax: config.compilerOptions.verbatimModuleSyntax,
      include: config.include,
    },
    {
      allowImportingTsExtensions: true,
      erasableSyntaxOnly: true,
      isolatedModules: true,
      module: 'ESNext',
      moduleResolution: 'Bundler',
      noEmit: true,
      noUncheckedIndexedAccess: true,
      strict: true,
      target: 'ES2024',
      verbatimModuleSyntax: true,
      include: ['src/workflows/dakar-review/**/*.ts'],
    },
  )
})

test('erasable syntax passes while an enum is rejected', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dakar-ts-contract-'))
  try {
    const good = join(directory, 'good.ts')
    const bad = join(directory, 'bad.ts')
    writeFileSync(good, 'export type Identifier = string\nexport const value: Identifier = "ok"\n')
    writeFileSync(bad, 'export enum RuntimeValue { One }\n')

    const compilerArgs = [TSC, '--ignoreConfig', '--noEmit', '--strict', '--erasableSyntaxOnly']
    execFileSync(process.execPath, [...compilerArgs, good], { cwd: ROOT, stdio: 'pipe' })
    const result = spawnSync(
      process.execPath,
      [...compilerArgs, bad],
      { cwd: ROOT, encoding: 'utf8' },
    )
    assert.notEqual(result.status, 0)
    assert.match(`${result.stdout}${result.stderr}`, /TS1294/u)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('the configured TypeScript project passes', () => {
  execFileSync(process.execPath, [TSC, '-p', TSCONFIG, '--noEmit'], {
    cwd: ROOT,
    stdio: 'pipe',
  })
})
