/** @file Build the canonical ODW artefact from the typed Dakar source tree. */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import ts from 'typescript'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const DEFAULT_SOURCE = path.join(ROOT, 'src', 'workflows', 'dakar-review')
const DEFAULT_OUTPUT = path.join(ROOT, 'workflows', 'dakar-review.js')
// Explicitly list every module expected in esbuild's runtime graph. At the
// compiler-spine milestone `main.ts` is the only runtime module: `meta.js` is
// framed verbatim and declarations are erased. Extraction milestones extend
// this list in the same change that adds each runtime module.
const RUNTIME_MODULES = ['main.ts']

export class WorkflowBuildError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'WorkflowBuildError'
    this.code = code
  }
}

function reject(code, message) {
  throw new WorkflowBuildError(code, message)
}

function countMatches(text, pattern) {
  return [...text.matchAll(pattern)].length
}

function assertLoaderContract(banner, bundle, artefact) {
  const metaCount = countMatches(banner, /^export const meta\s*=/gmu)
  if (metaCount !== 1) {
    reject('BUILD_META_COUNT', `expected one literal metadata export, found ${metaCount}`)
  }
  const sourceFile = ts.createSourceFile('workflow-bundle.js', bundle, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const wrappers = new Set(['__esm', '__commonJS', '__toESM', '__require'])
  let wrapperCall
  let moduleSyntax = false
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && wrappers.has(node.expression.text)) {
      wrapperCall = node.expression.text
    }
    if (
      ts.isImportDeclaration(node) ||
      ts.isExportDeclaration(node) ||
      ts.isExportAssignment(node) ||
      (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) ||
      (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword)
    ) {
      moduleSyntax = true
    }
    if (ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
      moduleSyntax = true
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  if (wrapperCall) {
    reject('BUILD_MODULE_WRAPPER', `bundle contains module wrapper call ${wrapperCall}()`)
  }
  if (moduleSyntax) {
    reject('BUILD_MODULE_SYNTAX', 'bundle contains module syntax rejected by ODW')
  }
  const entryCount = sourceFile.statements.filter(
    (statement) =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === 'workflowMain' &&
      ts.canHaveModifiers(statement) &&
      ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword),
  ).length
  if (entryCount !== 1) {
    reject('BUILD_ENTRY_COUNT', `expected one workflowMain declaration, found ${entryCount}`)
  }
  const wrapped = artefact.replace(/^export const meta\s*=/mu, 'const meta =')
  try {
    new Function(`return (async function __workflow_wrapped__() {\n${wrapped}\n})`)
  } catch (error) {
    reject('BUILD_LOADER_PARSE', `artefact does not parse under the ODW loader: ${error.message}`)
  }
}

export async function buildWorkflow({
  srcDir = DEFAULT_SOURCE,
  entry = path.join(srcDir, 'main.ts'),
  banner = path.join(srcDir, 'meta.js'),
  outFile = DEFAULT_OUTPUT,
  checkOnly = false,
  runtimeModules = RUNTIME_MODULES,
} = {}) {
  const bannerText = await readFile(banner, 'utf8')
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    legalComments: 'inline',
    logLevel: 'silent',
    metafile: true,
    // Neutral output is correct while runtime modules depend only on injected
    // ODW globals. Reassess platform/externals before admitting Node imports to
    // the manifest, or esbuild may emit loader-incompatible shims.
    platform: 'neutral',
    // `workflowMain` is deliberately not exported because an ESM export would
    // violate the ODW loader contract. Keep tree shaking disabled so esbuild
    // retains that footer-invoked declaration for the entry-count assertion.
    treeShaking: false,
    write: false,
  })
  const inputs = new Set(Object.keys(result.metafile.inputs).map((input) => path.resolve(input)))
  const expectedInputs = new Set([path.resolve(entry), ...runtimeModules.map((name) => path.resolve(srcDir, name))])
  for (const modulePath of expectedInputs) {
    if (!inputs.has(modulePath)) {
      reject('BUILD_ORPHAN_MODULE', `${path.relative(srcDir, modulePath)} is absent from the runtime bundle`)
    }
  }
  for (const input of inputs) {
    if (!expectedInputs.has(input)) {
      reject('BUILD_ORPHAN_MODULE', `${path.relative(srcDir, input)} is bundled but absent from the runtime manifest`)
    }
  }
  const bundle = result.outputFiles[0].text
  const artefact = [
    '// GENERATED FILE — built by `make workflow-build` from src/workflows/dakar-review/.',
    '// Do not edit directly; edit the source tree and rebuild.',
    bannerText.trimEnd(),
    '',
    bundle.trimEnd(),
    '',
    '// --- Entry (generated footer) --------------------------------------------',
    'return await workflowMain()',
    '',
  ].join('\n')
  assertLoaderContract(bannerText, bundle, artefact)

  if (checkOnly) {
    let current
    try {
      current = await readFile(outFile, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') {
        reject('BUILD_STALE_ARTEFACT', `${path.relative(ROOT, outFile)} is stale`)
      }
      throw error
    }
    if (current !== artefact) {
      reject('BUILD_STALE_ARTEFACT', `${path.relative(ROOT, outFile)} is stale`)
    }
    return artefact
  }

  await mkdir(path.dirname(outFile), { recursive: true })
  const temporary = `${outFile}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, artefact)
    await rename(temporary, outFile)
  } finally {
    await rm(temporary, { force: true })
  }
  return artefact
}

async function main() {
  let checkOnly = false
  let outFile = DEFAULT_OUTPUT
  let outFileSeen = false
  for (let index = 2; index < process.argv.length; index += 1) {
    const argument = process.argv[index]
    if (argument === '--check' && !checkOnly) {
      checkOnly = true
    } else if (argument === '--out-file' && !outFileSeen) {
      const value = process.argv[index + 1]
      if (!value || value.startsWith('--')) {
        console.error('build-workflow: usage: --out-file requires a path')
        process.exitCode = 2
        return
      }
      outFile = path.resolve(value)
      outFileSeen = true
      index += 1
    } else {
      console.error(`build-workflow: usage: unknown or duplicate argument ${argument}`)
      process.exitCode = 2
      return
    }
  }
  try {
    const artefact = await buildWorkflow({ checkOnly, outFile })
    const action = checkOnly ? 'fresh' : 'built'
    console.error(`${path.relative(ROOT, outFile)}: ${action} (${artefact.length} bytes)`)
  } catch (error) {
    const code = error instanceof WorkflowBuildError ? `${error.code}: ` : ''
    console.error(`build-workflow: ${code}${error.message}`)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
