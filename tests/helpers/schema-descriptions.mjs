/**
 * @file Recursively check that a JSON Schema documents every hand-off field.
 *
 * The exported `*_SCHEMA` constants are tagged `@internal`, which removes them
 * from TypeDoc's `notDocumented` validation. That exemption is only honest
 * while the schemas carry their own per-field `description` values, so this
 * helper enforces the property the tag assumes rather than trusting it.
 *
 * The walk is pure and data-driven: it inspects a schema object that the
 * caller already holds and never reads, parses, or executes a repository file.
 */

/** Composed-schema keywords whose value is an array of subschemas. */
const COMPOSED_LIST_KEYWORDS = ['allOf', 'anyOf', 'oneOf']

/**
 * Report whether a value is a plain schema object rather than an array or scalar.
 *
 * @param {unknown} value - candidate subschema.
 * @returns {boolean} true when the value can carry schema keywords.
 */
function isSchemaObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Report whether a schema carries a usable `description`.
 *
 * A blank or whitespace-only string documents nothing, so it fails alongside
 * an absent description and a non-string value.
 *
 * @param {object} node - schema object to inspect.
 * @returns {boolean} true when the description is a non-blank string.
 */
function hasNonBlankDescription(node) {
  return typeof node.description === 'string' && node.description.trim() !== ''
}

/**
 * Report whether a schema describes an agent hand-off structure.
 *
 * Object and array schemas carry the shape of a hand-off rather than a single
 * scalar value, so they are documented in their own right. A bare scalar item
 * schema such as `{ type: 'string' }` is not.
 *
 * @param {object} node - schema object to inspect.
 * @returns {boolean} true for object or array schemas.
 */
function isStructuralSchema(node) {
  return node.type === 'object' || node.type === 'array' ||
    isSchemaObject(node.properties) || node.items !== undefined
}

/**
 * Walk one subschema, recording the paths that lack a required description.
 *
 * @param {unknown} node - subschema to inspect.
 * @param {string} path - dotted path used to report a missing description.
 * @param {Set<object>} ancestors - schemas already open on this branch, so a
 * self-referential schema terminates instead of recursing forever.
 * @param {boolean} isNamedProperty - whether the node is a `properties` entry,
 * which must always be documented.
 * @param {string[]} missing - accumulator of offending paths, in walk order.
 * @returns {void}
 */
function walk(node, path, ancestors, isNamedProperty, missing) {
  if (!isSchemaObject(node) || ancestors.has(node)) return
  const branch = new Set(ancestors).add(node)

  if ((isNamedProperty || isStructuralSchema(node)) && !hasNonBlankDescription(node)) {
    missing.push(path)
  }

  if (isSchemaObject(node.properties)) {
    for (const key of Object.keys(node.properties)) {
      walk(node.properties[key], `${path}.properties.${key}`, branch, true, missing)
    }
  }

  if (Array.isArray(node.items)) {
    node.items.forEach((item, index) => walk(item, `${path}.items[${index}]`, branch, false, missing))
  } else if (node.items !== undefined) {
    walk(node.items, `${path}.items`, branch, false, missing)
  }

  for (const keyword of COMPOSED_LIST_KEYWORDS) {
    if (!Array.isArray(node[keyword])) continue
    node[keyword].forEach((sub, index) => walk(sub, `${path}.${keyword}[${index}]`, branch, false, missing))
  }

  if (node.not !== undefined) walk(node.not, `${path}.not`, branch, false, missing)
}

/**
 * List every path in a schema that must carry a description but does not.
 *
 * Every entry under `properties` is required to be documented. Nested object
 * and array schemas — including those reached through `items`, `allOf`,
 * `anyOf`, `oneOf`, or `not` — are required too, because they describe the
 * structure of an agent hand-off.
 *
 * @param {object} schema - root schema to inspect.
 * @param {string} [rootLabel] - name used to prefix reported paths.
 * @returns {string[]} offending paths in deterministic walk order; empty when
 * the schema is fully documented.
 */
export function findMissingDescriptions(schema, rootLabel = 'schema') {
  const missing = []
  walk(schema, rootLabel, new Set(), false, missing)
  return missing
}
