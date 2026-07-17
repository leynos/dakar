#!/usr/bin/env node
/** @file Measure JSDoc coverage over Dakar's authored workflow and CLI symbols. */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const minimumPercentage = 80
const defaultSourcePatterns = [
  'bin/dakar-review.mjs',
  'src/workflows/dakar-review/*.js',
  'src/workflows/dakar-review/*.ts',
  ':(exclude)src/workflows/dakar-review/*.d.ts',
]

/** Return tracked authored source files in the documentation audit scope. */
function sourceFiles() {
  const sourcePatterns = process.argv.length > 2 ? process.argv.slice(2) : defaultSourcePatterns
  return execFileSync('git', ['ls-files', ...sourcePatterns], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean)
}

/** Determine whether a syntax node has an immediately associated JSDoc block. */
function hasJsdoc(node, sourceText) {
  const comments = ts.getLeadingCommentRanges(sourceText, node.getFullStart()) ?? []
  return comments.some(({ pos, end }) => sourceText.slice(pos, end).startsWith('/**'))
}

/** Determine whether a source file begins with a module JSDoc after its shebang. */
function hasModuleJsdoc(sourceText) {
  return /^(?:#![^\n]*\n)?\s*\/\*\*/u.test(sourceText)
}

/** Determine whether a declaration carries the export modifier. */
function isExported(node) {
  return node.modifiers?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword) === true
}

/** Collect the documented status of every symbol covered by the audit contract. */
function inspectFile(file) {
  const sourceText = readFileSync(file, 'utf8')
  const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true)
  const symbols = [{ file, name: '<module>', documented: hasModuleJsdoc(sourceText) }]

  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name) {
      symbols.push({ file, name: node.name.text, documented: hasJsdoc(node, sourceText) })
    } else if ((ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) && isExported(node)) {
      symbols.push({ file, name: node.name.text, documented: hasJsdoc(node, sourceText) })
    } else if (ts.isVariableStatement(node) && isExported(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          symbols.push({ file, name: declaration.name.text, documented: hasJsdoc(node, sourceText) })
        }
      }
    }
    ts.forEachChild(node, visit)
  }

  ts.forEachChild(sourceFile, visit)
  return symbols
}

const symbols = sourceFiles().flatMap(inspectFile)
const documented = symbols.filter(({ documented }) => documented).length
const percentage = symbols.length === 0 ? 0 : (documented / symbols.length) * 100

if (symbols.length === 0) {
  process.stderr.write('Docstring coverage failed: no symbols discovered\n')
}

for (const symbol of symbols.filter(({ documented: present }) => !present)) {
  process.stderr.write(`${symbol.file}: undocumented ${symbol.name}\n`)
}
process.stdout.write(
  `Docstring coverage: ${documented}/${symbols.length} (${percentage.toFixed(2)}%; required ${minimumPercentage.toFixed(2)}%)\n`,
)

if (symbols.length === 0 || percentage < minimumPercentage) process.exitCode = 1
