/**
 * @file Property-based coverage for the schema-description walker.
 *
 * The fixed fixtures in `schema-descriptions.test.mjs` pin specific shapes;
 * these properties drive the same invariants across generated schema graphs —
 * arbitrary nesting, both `items` forms, shared nodes, and cycles.
 *
 * The oracle is the generator, not a second traversal: `buildSchema` records
 * the path of each field it deliberately leaves undocumented as it constructs
 * the graph, so the property compares discovery against construction rather
 * than against a re-implementation of the walker.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import fc from 'fast-check'

import { findMissingDescriptions } from './helpers/schema-descriptions.mjs'

/** Property names the generator may use; distinct so paths stay unambiguous. */
const PROPERTY_KEYS = ['alpha', 'beta', 'gamma', 'delta']

/** A scalar leaf, which may or may not be documented. */
const scalarSpec = fc.record({ kind: fc.constant('scalar'), documented: fc.boolean() })

/**
 * Generate a schema shape specification up to a bounded depth.
 *
 * Only the shape is generated here; `buildSchema` turns it into a schema and
 * reports which paths it left undocumented.
 */
const specNode = fc.memo((depth) => {
  if (depth <= 1) return scalarSpec
  return fc.oneof(
    scalarSpec,
    fc.record({
      kind: fc.constant('object'),
      entries: fc.uniqueArray(fc.tuple(fc.constantFrom(...PROPERTY_KEYS), specNode(depth - 1)), {
        selector: (entry) => entry[0],
        maxLength: 3,
      }),
    }),
    fc.record({ kind: fc.constant('array'), item: specNode(depth - 1) }),
  )
})

/** An always-object root, so back-edge cases need no filtering. */
const objectRootSpec = fc.record({
  kind: fc.constant('object'),
  entries: fc.uniqueArray(fc.tuple(fc.constantFrom(...PROPERTY_KEYS), specNode(3)), {
    selector: (entry) => entry[0],
    maxLength: 3,
  }),
})

/**
 * Build a schema from a specification, recording the paths left undocumented.
 *
 * Structural nodes are always documented, and a scalar reached through `items`
 * is too, so the only undocumented nodes are named scalar properties — which
 * the contract always requires to be documented. That keeps the expected set
 * a by-product of construction.
 *
 * @param {object} spec - generated shape specification.
 * @param {string} path - dotted path of the node being built.
 * @param {object} options - `named` marks a `properties` entry; `documentAll`
 * forces every field to be documented.
 * @param {string[]} missing - accumulator of deliberately undocumented paths.
 * @returns {object} the constructed schema node.
 */
function buildSchema(spec, path, options, missing) {
  if (spec.kind === 'scalar') {
    const documented = options.documentAll || !options.named || spec.documented
    if (!documented) missing.push(path)
    return documented ? { type: 'string', description: 'A scalar field.' } : { type: 'string' }
  }

  if (spec.kind === 'object') {
    const properties = {}
    for (const [key, child] of spec.entries) {
      properties[key] = buildSchema(child, `${path}.properties.${key}`, { ...options, named: true }, missing)
    }
    return { type: 'object', description: 'An object hand-off.', properties }
  }

  return {
    type: 'array',
    description: 'An array hand-off.',
    items: buildSchema(spec.item, `${path}.items`, { ...options, named: false }, missing),
  }
}

/**
 * Build a schema and the paths its construction left undocumented.
 *
 * @param {object} spec - generated shape specification.
 * @param {boolean} [documentAll] - force every field to be documented.
 * @returns {{ schema: object, missing: string[] }} the schema and expected paths.
 */
function buildCase(spec, documentAll = false) {
  const missing = []
  const schema = buildSchema(spec, 'ROOT', { named: false, documentAll }, missing)
  return { schema, missing }
}

/**
 * Rebuild every `properties` object with its keys in reverse order.
 *
 * @param {object} node - schema node to clone.
 * @returns {object} an equivalent schema whose key insertion order differs.
 */
function reverseKeyOrder(node) {
  if (typeof node !== 'object' || node === null) return node
  const clone = { ...node }
  if (node.properties) {
    clone.properties = {}
    for (const key of Object.keys(node.properties).reverse()) {
      clone.properties[key] = reverseKeyOrder(node.properties[key])
    }
  }
  if (node.items !== undefined) clone.items = reverseKeyOrder(node.items)
  return clone
}

test('every undocumented named property is reported, and nothing else is', () => {
  fc.assert(
    fc.property(specNode(4), (spec) => {
      const { schema, missing } = buildCase(spec)

      assert.deepEqual(findMissingDescriptions(schema, 'ROOT').sort(), [...missing].sort())
    }),
  )
})

test('a fully documented graph reports nothing', () => {
  fc.assert(
    fc.property(specNode(4), (spec) => {
      const { schema } = buildCase(spec, true)

      assert.deepEqual(findMissingDescriptions(schema, 'ROOT'), [])
    }),
  )
})

test('a node shared between two branches is reported at both paths', () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(fc.constantFrom(...PROPERTY_KEYS), { minLength: 2, maxLength: 2 }),
      ([first, second]) => {
        // One undocumented object, reached by two distinct paths: cycle
        // detection is branch-local, so neither visit may suppress the other.
        const shared = { type: 'string' }
        const schema = {
          type: 'object',
          description: 'Root hand-off.',
          properties: { [first]: shared, [second]: shared },
        }

        assert.deepEqual(findMissingDescriptions(schema, 'ROOT').sort(), [
          `ROOT.properties.${first}`,
          `ROOT.properties.${second}`,
        ].sort())
      },
    ),
  )
})

test('a back-edge terminates and leaves the findings unchanged', () => {
  fc.assert(
    fc.property(objectRootSpec, (spec) => {
      const { schema } = buildCase(spec)
      const before = findMissingDescriptions(schema, 'ROOT').sort()

      // `selfRef` is never generated, so the back-edge adds a property rather
      // than replacing one. It resolves to the documented root, so a
      // terminating walk must report exactly what it did before.
      schema.properties.selfRef = schema

      const after = findMissingDescriptions(schema, 'ROOT').sort()

      assert.ok(Array.isArray(after), 'the walk must terminate and return paths')
      assert.deepEqual(after, before)
    }),
  )
})

test('reordering property keys preserves the set of reported paths', () => {
  fc.assert(
    fc.property(specNode(4), (spec) => {
      const { schema } = buildCase(spec)

      assert.deepEqual(
        findMissingDescriptions(reverseKeyOrder(schema), 'ROOT').sort(),
        findMissingDescriptions(schema, 'ROOT').sort(),
      )
    }),
  )
})
