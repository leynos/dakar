/**
 * @file Gate the agent hand-off schemas on per-field documentation.
 *
 * `make docs-check` cannot see these constants: they are tagged `@internal`,
 * and `typedoc.json` sets `excludeInternal`, because TypeDoc would otherwise
 * demand a JSDoc comment on every structural keyword inside the schema
 * literals. The tag is justified by the schemas documenting themselves through
 * JSON Schema `description` fields, so this suite enforces that justification
 * deterministically instead of leaving it to review.
 *
 * The mutation cases prove the validator can fail: a fixture with a removed or
 * blanked description must be reported, and reported at the right path.
 *
 * @module
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AUDIT_SCHEMA,
  CANDIDATE_SCHEMA,
  VERDICT_SCHEMA,
  VERDICT_WITH_CLUSTER_SCHEMA,
} from '../src/workflows/dakar-review/schemas.ts'
import { findMissingDescriptions } from './helpers/schema-descriptions.mjs'

/** Every exported hand-off schema, paired with the name used in reported paths. */
const EXPORTED_SCHEMAS = [
  ['CANDIDATE_SCHEMA', CANDIDATE_SCHEMA],
  ['VERDICT_SCHEMA', VERDICT_SCHEMA],
  ['VERDICT_WITH_CLUSTER_SCHEMA', VERDICT_WITH_CLUSTER_SCHEMA],
  ['AUDIT_SCHEMA', AUDIT_SCHEMA],
]

/**
 * Build a self-contained fixture shaped like a hand-off schema.
 *
 * Returning a fresh object per call keeps each mutation case isolated from the
 * others and from the real exported schemas.
 *
 * @returns {object} a fully documented schema fixture.
 */
function documentedFixture() {
  return {
    type: 'object',
    description: 'Fixture hand-off.',
    properties: {
      taskId: { type: 'string', description: 'Identifier of the task.' },
      findings: {
        type: 'array',
        description: 'Proposed findings.',
        items: {
          type: 'object',
          description: 'One proposed finding.',
          properties: {
            title: { type: 'string', description: 'Short finding title.' },
            tags: { type: 'array', description: 'Labels applied to the finding.', items: { type: 'string' } },
          },
        },
      },
    },
  }
}

for (const [name, schema] of EXPORTED_SCHEMAS) {
  test(`${name} documents every property and nested structure`, () => {
    assert.deepEqual(
      findMissingDescriptions(schema, name),
      [],
      `${name} must document every field so its @internal exemption stays honest`,
    )
  })
}

test('a fully documented fixture reports nothing', () => {
  assert.deepEqual(findMissingDescriptions(documentedFixture(), 'FIXTURE'), [])
})

test('removing a property description is reported at that property path', () => {
  const schema = documentedFixture()
  delete schema.properties.taskId.description

  assert.deepEqual(findMissingDescriptions(schema, 'FIXTURE'), ['FIXTURE.properties.taskId'])
})

test('blanking a property description is reported like a removed one', () => {
  const schema = documentedFixture()
  schema.properties.taskId.description = '   '

  assert.deepEqual(findMissingDescriptions(schema, 'FIXTURE'), ['FIXTURE.properties.taskId'])
})

test('a nested property inside an array item is reported at its full path', () => {
  const schema = documentedFixture()
  delete schema.properties.findings.items.properties.title.description

  assert.deepEqual(findMissingDescriptions(schema, 'FIXTURE'), [
    'FIXTURE.properties.findings.items.properties.title',
  ])
})

test('an undocumented object reached through items is reported', () => {
  const schema = documentedFixture()
  delete schema.properties.findings.items.description

  assert.deepEqual(findMissingDescriptions(schema, 'FIXTURE'), ['FIXTURE.properties.findings.items'])
})

test('a scalar item schema needs no description of its own', () => {
  const schema = documentedFixture()

  // `tags.items` is `{ type: 'string' }`: a scalar element, not a hand-off
  // structure, so it documents nothing beyond its parent array.
  assert.deepEqual(findMissingDescriptions(schema, 'FIXTURE'), [])
})

test('composed subschemas are traversed and reported by keyword and index', () => {
  const schema = {
    type: 'object',
    description: 'Composed hand-off.',
    properties: {
      outcome: {
        description: 'Either an acceptance or a refusal.',
        oneOf: [
          { type: 'object', description: 'Acceptance.', properties: { ok: { type: 'boolean', description: 'Accepted.' } } },
          { type: 'object', properties: { reason: { type: 'string' } } },
        ],
      },
    },
  }

  assert.deepEqual(findMissingDescriptions(schema, 'FIXTURE'), [
    'FIXTURE.properties.outcome.oneOf[1]',
    'FIXTURE.properties.outcome.oneOf[1].properties.reason',
  ])
})

test('allOf, anyOf, and not subschemas are traversed', () => {
  for (const keyword of ['allOf', 'anyOf']) {
    const schema = {
      type: 'object',
      description: 'Composed hand-off.',
      properties: {
        value: { description: 'Constrained value.', [keyword]: [{ type: 'object', properties: {} }] },
      },
    }
    assert.deepEqual(findMissingDescriptions(schema, 'FIXTURE'), [`FIXTURE.properties.value.${keyword}[0]`])
  }

  const negated = {
    type: 'object',
    description: 'Composed hand-off.',
    properties: {
      value: { description: 'Constrained value.', not: { type: 'object', properties: {} } },
    },
  }
  assert.deepEqual(findMissingDescriptions(negated, 'FIXTURE'), ['FIXTURE.properties.value.not'])
})

test('composed keywords are traversed in a fixed allOf, anyOf, oneOf order', () => {
  const undocumented = () => ({ type: 'object', properties: {} })
  const schema = {
    type: 'object',
    description: 'Composed hand-off.',
    properties: {
      value: {
        description: 'Constrained value.',
        oneOf: [undocumented()],
        allOf: [undocumented()],
        anyOf: [undocumented()],
      },
    },
  }

  // Declaration order here is oneOf, allOf, anyOf; the walk order is fixed by
  // the helper, so the report must not follow the object's key order.
  assert.deepEqual(findMissingDescriptions(schema, 'FIXTURE'), [
    'FIXTURE.properties.value.allOf[0]',
    'FIXTURE.properties.value.anyOf[0]',
    'FIXTURE.properties.value.oneOf[0]',
  ])
})

test('a self-referential schema terminates instead of recursing forever', () => {
  const schema = { type: 'object', description: 'Recursive hand-off.', properties: {} }
  schema.properties.child = schema

  assert.deepEqual(findMissingDescriptions(schema, 'FIXTURE'), [])
})

test('a cyclic named property reports each missing description before terminating', () => {
  const child = { type: 'object', properties: {} }
  child.properties.self = child
  const schema = {
    type: 'object',
    description: 'Recursive hand-off.',
    properties: { child },
  }

  assert.deepEqual(findMissingDescriptions(schema, 'ROOT'), [
    'ROOT.properties.child',
    'ROOT.properties.child.properties.self',
  ])
})
