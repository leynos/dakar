/**
 * Build the canonical ODW artefact from the typed Dakar source tree.
 *
 * @module
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import ts from 'typescript'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const DEFAULT_SOURCE = path.join(ROOT, 'src', 'workflows', 'dakar-review')
const DEFAULT_OUTPUT = path.join(ROOT, 'workflows', 'dakar-review.js')
// Explicitly list every module expected in esbuild's runtime graph. `meta.js`
// is framed verbatim, while declaration-only and type-only modules are erased.
// The metafile comparison below enforces this manifest in both directions.
const RUNTIME_MODULES = [
  'admission.ts',
  'candidates.ts',
  'config.ts',
  'main.ts',
  'model-routing.ts',
  'pricing.ts',
  'policy.ts',
  'prompts.ts',
  'retry.ts',
  'sarif.ts',
  'schemas.ts',
  'shell.ts',
  'task-graph.ts',
]
// Zod is the one approved third-party runtime package in the generated
// workflow. Its pinned package modules are bundled into the single-file
// artefact; every other runtime input must remain in the source manifest.
const RUNTIME_PACKAGES = ['zod']

/**
 * Signals a violated ODW build invariant (e.g. an orphan module, a malformed
 * `meta` banner, or a stale artefact) with a machine-readable `code` so
 * callers such as the CLI entry point can report the failure kind precisely.
 */
export class WorkflowBuildError extends Error {
  constructor(code, message) {
    super(message)
    /** Always `'WorkflowBuildError'`, distinguishing this from other thrown errors. */
    this.name = 'WorkflowBuildError'
    /** Machine-readable code identifying which build invariant was violated. */
    this.code = code
  }
}

/**
 * Fail the build by throwing a coded {@link WorkflowBuildError}.
 *
 * @param {string} code - the machine-readable failure code (e.g. `BUILD_META_COUNT`).
 * @param {string} message - the human-readable failure description.
 * @returns {never} always throws; never returns normally.
 */
function reject(code, message) {
  throw new WorkflowBuildError(code, message)
}

/**
 * Normalise CRLF and lone-CR line endings to LF so the generated artefact and
 * its freshness comparison are byte-stable across platforms.
 *
 * @param {string} text - the source text to normalise.
 * @returns {string} the text with every line ending collapsed to `\n`.
 */
function normalizeLineEndings(text) {
  return text.replaceAll(/\r\n?/gu, '\n')
}

/**
 * Whether a TypeScript AST node is a compile-time constant: a string, numeric,
 * boolean, or null literal, or an array or object literal composed recursively
 * of such literals with non-computed keys. Used to prove the metadata banner's
 * `meta` object is a static literal and carries no executable expression.
 *
 * @param {import('typescript').Node} node - the AST node to inspect.
 * @returns {boolean} true only when the node is a fully literal value.
 */
function isLiteralValue(node) {
  if (
    ts.isStringLiteral(node) ||
    ts.isNumericLiteral(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword
  ) return true
  if (ts.isArrayLiteralExpression(node)) return node.elements.every(isLiteralValue)
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.every(
      (property) => ts.isPropertyAssignment(property) && !ts.isComputedPropertyName(property.name) && isLiteralValue(property.initializer),
    )
  }
  return false
}

/**
 * Find the first matching node in a depth-first traversal of an AST.
 * @param {import('typescript').Node} node - root node to inspect.
 * @param {(node: import('typescript').Node) => boolean} predicate - matching condition.
 * @returns {import('typescript').Node | undefined} first matching node, if present.
 */
function findNode(node, predicate) {
  if (predicate(node)) return node
  return ts.forEachChild(node, (child) => findNode(child, predicate))
}

/**
 * Find the last matching node in the same depth-first traversal order.
 *
 * @internal Exported so the ordering invariant can be property-tested.
 * @param {import('typescript').Node} node - root node to inspect.
 * @param {(node: import('typescript').Node) => boolean} predicate - matching condition.
 * @returns {import('typescript').Node | undefined} last matching node, if present.
 */
export function findLastNode(node, predicate) {
  /** @type {import('typescript').Node[]} */
  const children = []
  ts.forEachChild(node, (child) => { children.push(child) })
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const match = findLastNode(children[index], predicate)
    if (match) return match
  }
  return predicate(node) ? node : undefined
}

/**
 * Whether an AST node contains a module syntax form rejected by ODW.
 * @param {import('typescript').Node} node - node to inspect.
 * @returns {boolean} true for disallowed module syntax.
 */
function isModuleSyntax(node) {
  return ts.isImportDeclaration(node) ||
    ts.isExportDeclaration(node) ||
    ts.isExportAssignment(node) ||
    (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) ||
    (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword)
}

/**
 * Parse JavaScript text into a TypeScript AST without type checking.
 * @param {string} fileName - name used in diagnostics.
 * @param {string} text - the JavaScript source to parse.
 * @returns {import('typescript').SourceFile} the parsed source file.
 */
function parseJavaScript(fileName, text) {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
}

/**
 * Whether an AST node carries an `export` modifier.
 * @param {import('typescript').Node} node - node to inspect.
 * @returns {boolean} true when the node is exported.
 */
function hasExportModifier(node) {
  return ts.canHaveModifiers(node) &&
    ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true
}

/**
 * Whether a statement declares exactly one variable binding named `meta`.
 * @param {import('typescript').Statement} statement - candidate statement.
 * @returns {statement is import('typescript').VariableStatement} true for `const meta = …` with a single declarator.
 */
function isSingleMetaDeclaration(statement) {
  if (!ts.isVariableStatement(statement)) return false
  const declarations = statement.declarationList.declarations
  return declarations.length === 1 &&
    ts.isIdentifier(declarations[0].name) &&
    declarations[0].name.text === 'meta'
}

/**
 * Collect the banner statements that declare a single `meta` binding.
 * @param {import('typescript').SourceFile} sourceFile - parsed metadata banner.
 * @returns {import('typescript').VariableStatement[]} matching statements.
 */
function findMetaStatements(sourceFile) {
  return sourceFile.statements.filter(isSingleMetaDeclaration)
}

/**
 * Whether a variable statement declares an exported `const` with a static
 * object literal initialiser.
 * @param {import('typescript').VariableStatement} statement - candidate declaration.
 * @returns {boolean} true for `export const name = { ... }` with literal values.
 */
function isLiteralMetaStatement(statement) {
  const declaration = statement.declarationList.declarations.at(0)
  return (statement.declarationList.flags & ts.NodeFlags.Const) !== 0 &&
    hasExportModifier(statement) &&
    declaration !== undefined &&
    declaration.initializer !== undefined &&
    ts.isObjectLiteralExpression(declaration.initializer) &&
    isLiteralValue(declaration.initializer)
}

/**
 * Whether a parsed banner is exactly one literal `export const meta = { ... }`.
 * @param {import('typescript').SourceFile} bannerFile - parsed metadata banner.
 * @param {import('typescript').VariableStatement} metaStatement - the candidate statement.
 * @returns {boolean} true when the banner holds exactly the required statement.
 */
function isLiteralMetaBanner(bannerFile, metaStatement) {
  return bannerFile.parseDiagnostics.length === 0 &&
    bannerFile.statements.length === 1 &&
    isLiteralMetaStatement(metaStatement)
}

/**
 * Assert the banner is exactly one literal `export const meta = { ... }`.
 * @param {import('typescript').SourceFile} bannerFile - parsed metadata banner.
 * @returns {import('typescript').VariableStatement} the validated metadata statement.
 */
function assertLiteralMeta(bannerFile) {
  const metaStatements = findMetaStatements(bannerFile)
  const metaStatement = metaStatements.at(0)
  if (
    metaStatement === undefined ||
    metaStatements.length !== 1 ||
    !isLiteralMetaBanner(bannerFile, metaStatement)
  ) {
    reject('BUILD_META_COUNT', 'expected exactly one literal `export const meta = { ... }` statement')
  }
  return metaStatement
}

/**
 * Reject module syntax anywhere in the metadata banner.
 * @param {import('typescript').SourceFile} bannerFile - parsed metadata banner.
 * @returns {void}
 */
function assertBannerIsInert(bannerFile) {
  if (findNode(bannerFile, isModuleSyntax) !== undefined) {
    reject('BUILD_MODULE_SYNTAX', 'metadata banner contains rejected module syntax')
  }
}

/**
 * Whether a node is module syntax rejected in the bundled runtime.
 * @param {import('typescript').Node} node - node to inspect.
 * @returns {boolean} true for imports, exports, or dynamic imports.
 */
function isBundleModuleSyntax(node) {
  return isModuleSyntax(node) || hasExportModifier(node)
}

/**
 * Reject surviving module syntax and exports in the bundle.
 * @param {import('typescript').SourceFile} sourceFile - parsed workflow bundle.
 * @returns {void}
 */
function assertBundleIsInert(sourceFile) {
  if (findNode(sourceFile, isBundleModuleSyntax) !== undefined) {
    reject('BUILD_MODULE_SYNTAX', 'bundle contains module syntax rejected by ODW')
  }
}

/** Names of esbuild's interop wrappers, which the ODW loader cannot provide. */
const MODULE_WRAPPERS = new Set(['__esm', '__commonJS', '__toESM', '__require'])

/**
 * Read the wrapper name when a node is a call to an esbuild module wrapper.
 * @param {import('typescript').Node} node - node to inspect.
 * @returns {string | undefined} the wrapper name, if the node invokes one.
 */
function moduleWrapperName(node) {
  if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return
  if (!MODULE_WRAPPERS.has(node.expression.text)) return
  return node.expression.text
}

/**
 * Find the last module wrapper call in depth-first traversal order, so the
 * reported name matches the innermost surviving wrapper.
 *
 * @internal Exported so the reported-wrapper contract can be property-tested.
 * @param {import('typescript').SourceFile} sourceFile - parsed workflow bundle.
 * @returns {string | undefined} the last wrapper name, if any survives.
 */
export function findModuleWrapperName(sourceFile) {
  const call = findLastNode(sourceFile, (node) => moduleWrapperName(node) !== undefined)
  if (call === undefined) return
  return moduleWrapperName(call)
}

/**
 * Reject any surviving esbuild module wrapper call.
 * @param {import('typescript').SourceFile} sourceFile - parsed workflow bundle.
 * @returns {void}
 */
function assertNoModuleWrapper(sourceFile) {
  const name = findModuleWrapperName(sourceFile)
  if (name !== undefined) {
    reject('BUILD_MODULE_WRAPPER', `bundle contains module wrapper call ${name}()`)
  }
}

/**
 * Whether a statement declares the async `workflowMain` entry point.
 * @param {import('typescript').Statement} statement - statement to inspect.
 * @returns {boolean} true for `async function workflowMain`.
 */
function isWorkflowMain(statement) {
  return ts.isFunctionDeclaration(statement) &&
    statement.name?.text === 'workflowMain' &&
    ts.canHaveModifiers(statement) &&
    ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) === true
}

/**
 * Reject bundles without exactly one async `workflowMain` declaration.
 * @param {import('typescript').SourceFile} sourceFile - parsed workflow bundle.
 * @returns {void}
 */
function assertSingleWorkflowMain(sourceFile) {
  const entryCount = sourceFile.statements.filter(isWorkflowMain).length
  if (entryCount !== 1) {
    reject('BUILD_ENTRY_COUNT', `expected one workflowMain declaration, found ${entryCount}`)
  }
}

/**
 * Reject a bundle that cannot parse inside the ODW loader wrapper.
 * @param {string} banner - the raw metadata banner.
 * @param {string} bundle - the bundled runtime source.
 * @param {import('typescript').VariableStatement} metaStatement - the validated metadata statement.
 * @param {import('typescript').SourceFile} bannerFile - parsed metadata banner.
 * @returns {void}
 */
function assertParsesUnderLoader(banner, bundle, metaStatement, bannerFile) {
  const metaStart = metaStatement.getStart(bannerFile)
  const wrappedBanner = `${banner.slice(0, metaStart)}${banner.slice(metaStart).replace(/^export const meta\s*=/u, 'const meta =')}`
  const wrapped = `${wrappedBanner.trimEnd()}\n{\n${bundle.trimEnd()}\nreturn await workflowMain()\n}\n`
  try {
    new Function(`return (async function __workflow_wrapped__() {\n${wrapped}\n})`)
  } catch (error) {
    reject('BUILD_LOADER_PARSE', `artefact does not parse under the ODW loader: ${error.message}`)
  }
}

/**
 * Reject bundles that cannot execute under the restricted ODW loader.
 * @param {string} banner - the raw metadata banner.
 * @param {string} bundle - the bundled runtime source.
 * @returns {void}
 */
function assertLoaderContract(banner, bundle) {
  const bannerFile = parseJavaScript('meta.js', banner)
  assertBannerIsInert(bannerFile)
  const metaStatement = assertLiteralMeta(bannerFile)
  const sourceFile = parseJavaScript('workflow-bundle.js', bundle)
  assertNoModuleWrapper(sourceFile)
  assertBundleIsInert(sourceFile)
  assertSingleWorkflowMain(sourceFile)
  assertParsesUnderLoader(banner, bundle, metaStatement, bannerFile)
}

/**
 * Checks whether a bundled input is a strict descendant of an approved package root.
 *
 * @param {string} input - the resolved path of a bundled input.
 * @param {string} packageRoot - the root directory of an approved runtime package.
 * @returns {boolean} true when `input` is beneath `packageRoot`, excluding the root itself.
 * @internal
 */
export function isPackageInput(input, packageRoot) {
  const relative = path.relative(packageRoot, input)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

/** Enforces both sides of the workflow runtime input manifest. */
function assertRuntimeInputs(inputs, expectedInputs, packageRoots, srcDir) {
  const missing = [...expectedInputs].find((modulePath) => !inputs.has(modulePath))
  if (missing !== undefined) {
    reject('BUILD_ORPHAN_MODULE', `${path.relative(srcDir, missing)} is absent from the runtime bundle`)
  }
  const unexpected = [...inputs].find((input) =>
    !expectedInputs.has(input) && !packageRoots.some((root) => isPackageInput(input, root)))
  if (unexpected !== undefined) {
    reject('BUILD_ORPHAN_MODULE', `${path.relative(srcDir, unexpected)} is bundled but absent from the runtime manifest`)
  }
}

/** Builds or freshness-checks the canonical workflow artefact. */
export async function buildWorkflow({
  srcDir = DEFAULT_SOURCE,
  entry = path.join(srcDir, 'main.ts'),
  banner = path.join(srcDir, 'meta.js'),
  outFile = DEFAULT_OUTPUT,
  checkOnly = false,
  runtimeModules = RUNTIME_MODULES,
  runtimePackages = RUNTIME_PACKAGES,
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
  const approvedPackageRoots = runtimePackages.map((name) => path.join(ROOT, 'node_modules', name))
  assertRuntimeInputs(inputs, expectedInputs, approvedPackageRoots, srcDir)
  const bundle = result.outputFiles[0].text
  const artefact = [
    '/**',
    ' * @file Generated Dakar ODW workflow runtime artefact.',
    ' *',
    ' * Built by `make workflow-build` from `src/workflows/dakar-review/`.',
    ' * Do not edit directly; edit the source tree and rebuild.',
    ' */',
    bannerText.trimEnd(),
    '',
    '{',
    bundle.trimEnd(),
    '',
    '// --- Entry (generated footer) --------------------------------------------',
    'return await workflowMain()',
    '}',
    '',
  ].join('\n')
  assertLoaderContract(bannerText, bundle)

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
    if (normalizeLineEndings(current) !== normalizeLineEndings(artefact)) {
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

/**
 * CLI entry point: parse `--check` and `--out-file <path>` arguments, then
 * either build the workflow artefact or verify it is fresh.
 *
 * Side effects: writes the artefact (unless `--check`), logs a status line to
 * stderr, and sets `process.exitCode` — 2 for a usage error, 1 for a build or
 * freshness failure, 0 on success. Never throws to the top level; build errors
 * are caught and reported with their {@link WorkflowBuildError} code.
 *
 * @returns {Promise<void>} resolves once the build or check has completed.
 */
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
