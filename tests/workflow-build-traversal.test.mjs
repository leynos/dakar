/** @file Property-test the workflow bundle's depth-first AST traversal order. */

import assert from 'node:assert/strict'
import test from 'node:test'
import fc from 'fast-check'
import ts from 'typescript'
import { findLastNode, findModuleWrapperName } from '../scripts/build-workflow.mjs'

const WRAPPER_NAMES = ['__esm', '__commonJS', '__toESM', '__require']
const PLAIN_NAMES = ['helper', 'wrap', 'transform']

/** Arbitrary nested call expression, bounded by `depth`. */
function callExpressionArb(depth) {
  const leaf = fc.constantFrom('0', '1', 'name')
  if (depth === 0) return leaf
  return fc.oneof(
    leaf,
    fc.record({
      name: fc.constantFrom(...WRAPPER_NAMES, ...PLAIN_NAMES),
      args: fc.array(callExpressionArb(depth - 1), { maxLength: 3 }),
    }).map(({ name, args }) => `${name}(${args.join(', ')})`),
  )
}

/** Visit every node in pre-order depth-first order. */
function visitDepthFirst(node, visit) {
  visit(node)
  ts.forEachChild(node, (child) => { visitDepthFirst(child, visit) })
}

/** Whether a node calls one of the module-wrapper helpers. */
function isWrapperCall(node) {
  if (!ts.isCallExpression(node)) return false
  if (!ts.isIdentifier(node.expression)) return false
  return WRAPPER_NAMES.includes(node.expression.text)
}

/** Collect module-wrapper call names in pre-order depth-first traversal. */
function wrapperNamesInDepthFirstOrder(node) {
  const found = []
  visitDepthFirst(node, (current) => {
    if (isWrapperCall(current)) found.push(current.expression.text)
  })
  return found
}

/** Collect every node in pre-order depth-first traversal. */
function nodesInDepthFirstOrder(node) {
  const found = []
  visitDepthFirst(node, (current) => found.push(current))
  return found
}

/** Parse one generated expression as the body of a constant declaration. */
function parseExpression(expression) {
  return ts.createSourceFile('probe.js', `const value = ${expression}\n`, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
}

test('findModuleWrapperName reports the last wrapper in reference depth-first order', () => {
  fc.assert(fc.property(callExpressionArb(3), (expression) => {
    const sourceFile = parseExpression(expression)
    const expected = wrapperNamesInDepthFirstOrder(sourceFile).at(-1)
    assert.equal(findModuleWrapperName(sourceFile), expected, `generated source: ${expression}`)
  }), { numRuns: 200 })
})

test('findLastNode returns the last match in reference depth-first order', () => {
  const matches = (node) => ts.isIdentifier(node) && node.text.startsWith('__')
  fc.assert(fc.property(callExpressionArb(3), (expression) => {
    const sourceFile = parseExpression(expression)
    const expected = nodesInDepthFirstOrder(sourceFile).filter(matches).at(-1)
    const actual = findLastNode(sourceFile, matches)
    assert.equal(actual?.pos, expected?.pos, `generated source: ${expression}`)
  }), { numRuns: 200 })
})