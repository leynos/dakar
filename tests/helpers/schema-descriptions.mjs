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
 *
 * @module
 */

/** Composed-schema keywords whose value is an array of subschemas. */
const COMPOSED_LIST_KEYWORDS = ['allOf', 'anyOf', 'oneOf']

/**
 * @typedef {object} VisitContext Everything one visit needs to judge a node.
 * @property {string} path Dotted path reported when the description is absent.
 * @property {Set<object>} ancestors Schemas already open on this branch, so a
 * self-referential schema terminates instead of recursing forever.
 * @property {boolean} isNamedProperty Whether the node is a `properties` entry,
 * which must always be documented.
 * @property {string[]} missing Accumulator of offending paths, in walk order.
 */

/**
 * @typedef {object} BranchContext A node's context, extended for its children.
 * @property {string} path Dotted path of the node being descended from.
 * @property {Set<object>} ancestors This branch's open schemas, including the
 * node itself.
 * @property {string[]} missing Accumulator shared with every other visit.
 */

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
 * Record the node's path when it must carry a description but does not.
 *
 * @param {object} node - schema object being visited.
 * @param {VisitContext} context - position and accumulated state.
 * @returns {void}
 */
function recordMissingDescription(node, context) {
  if (!context.isNamedProperty && !isStructuralSchema(node)) return
  if (hasNonBlankDescription(node)) return
  context.missing.push(context.path)
}

/**
 * Build the context for one subschema reached from a branch.
 *
 * @param {BranchContext} branch - context of the schema being descended from.
 * @param {string} suffix - path segment identifying the subschema.
 * @param {boolean} isNamedProperty - whether the subschema is a `properties` entry.
 * @returns {VisitContext} context for visiting that subschema.
 */
function childContext(branch, suffix, isNamedProperty) {
  return {
    path: `${branch.path}${suffix}`,
    ancestors: branch.ancestors,
    isNamedProperty,
    missing: branch.missing,
  }
}

/**
 * Visit each entry of a schema's `properties`, in declaration order.
 *
 * @param {object} node - schema object being descended from.
 * @param {BranchContext} branch - branch state for its children.
 * @returns {void}
 */
function visitProperties(node, branch) {
  if (!isSchemaObject(node.properties)) return
  for (const key of Object.keys(node.properties)) {
    visitSchema(node.properties[key], childContext(branch, `.properties.${key}`, true))
  }
}

/**
 * Visit a schema's `items`, whether a tuple of subschemas or a single one.
 *
 * @param {object} node - schema object being descended from.
 * @param {BranchContext} branch - branch state for its children.
 * @returns {void}
 */
function visitItems(node, branch) {
  if (Array.isArray(node.items)) {
    node.items.forEach((item, index) => visitSchema(item, childContext(branch, `.items[${index}]`, false)))
    return
  }
  if (node.items !== undefined) visitSchema(node.items, childContext(branch, '.items', false))
}

/**
 * Visit the subschemas of every composed keyword holding a list.
 *
 * @param {object} node - schema object being descended from.
 * @param {BranchContext} branch - branch state for its children.
 * @returns {void}
 */
function visitComposedLists(node, branch) {
  for (const keyword of COMPOSED_LIST_KEYWORDS) {
    if (!Array.isArray(node[keyword])) continue
    node[keyword].forEach((sub, index) => visitSchema(sub, childContext(branch, `.${keyword}[${index}]`, false)))
  }
}

/**
 * Visit the subschema of a `not` keyword.
 *
 * @param {object} node - schema object being descended from.
 * @param {BranchContext} branch - branch state for its children.
 * @returns {void}
 */
function visitNot(node, branch) {
  if (node.not === undefined) return
  visitSchema(node.not, childContext(branch, '.not', false))
}

/**
 * Judge one subschema, then descend into the subschemas it holds.
 *
 * Descent order is fixed — `properties`, `items`, the composed lists, then
 * `not` — so reported paths stay in a deterministic order. The branch extends
 * `ancestors` with this node, which keeps cycle detection local to the current
 * chain: a schema shared between two branches is still visited on both.
 *
 * @param {unknown} node - subschema to inspect.
 * @param {VisitContext} context - position and accumulated state.
 * @returns {void}
 */
function visitSchema(node, context) {
  if (!isSchemaObject(node)) return
  recordMissingDescription(node, context)
  if (context.ancestors.has(node)) return

  const branch = {
    path: context.path,
    ancestors: new Set(context.ancestors).add(node),
    missing: context.missing,
  }
  visitProperties(node, branch)
  visitItems(node, branch)
  visitComposedLists(node, branch)
  visitNot(node, branch)
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
  visitSchema(schema, { path: rootLabel, ancestors: new Set(), isNamedProperty: false, missing })
  return missing
}
