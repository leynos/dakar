/**
 * Load marked examples from Dakar's published user-facing documentation.
 *
 * The loader keeps examples in the tests connected to the text users read and
 * rejects missing, malformed, orphaned, or duplicate example markers.
 *
 * @module
 */

import { readFileSync } from 'node:fs'
import MarkdownIt from 'markdown-it'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// This gate covers published user-facing examples, not maintainer documents.
const DOCUMENTS = Object.freeze(['README.md', 'docs/users-guide.md', 'docs/migration-0.1.md'])
const MARKER_PATTERN = /^<!-- tested-example: ([a-z][a-z0-9]*(?:-[a-z0-9]+)*) -->$/u
const MARKER_PREFIX = '<!-- tested-example:'
const CONTAINER_TAGS = new Set(['blockquote', 'li', 'ol', 'ul'])
const MARKDOWN = new MarkdownIt('commonmark', { html: true })

/**
 * Create parser state shared by the document-token helpers.
 *
 * @param {string} source - Document name used in diagnostics.
 * @returns {object} Mutable parse state for one Markdown document.
 */
function createParseState(source) {
  return {
    source,
    markers: new Map(),
    markersByEnd: new Map(),
    identifiers: new Set(),
    examples: new Map(),
    consumedMarkers: new Set(),
  }
}

/**
 * Track the token identities of the current Markdown containers.
 *
 * @param {object} token - Markdown block token to inspect.
 * @param {number} tokenIndex - Stable index in the parsed token list.
 * @param {number[]} containers - Open container token indexes.
 */
function updateContainerPath(token, tokenIndex, containers) {
  if (!CONTAINER_TAGS.has(token.tag)) return
  if (token.nesting === 1) containers.push(tokenIndex)
  if (token.nesting === -1) containers.pop()
}

/**
 * Encode the current Markdown container path for marker-fence matching.
 *
 * @param {number[]} containers - Open container token indexes.
 * @returns {string} Stable identity for the current container stack.
 */
function containerIdentity(containers) {
  return containers.join('/')
}

/**
 * Record a marker represented by a standalone HTML comment block.
 *
 * @param {object} token - Markdown block token to inspect.
 * @param {object} state - Mutable parse state for the document.
 * @param {string} identity - Identity of the current Markdown containers.
 */
function recordMarker(token, state, identity) {
  if (token.type !== 'html_block') return
  const trimmed = token.content.trim()
  if (!trimmed.startsWith(MARKER_PREFIX)) return

  const marker = MARKER_PATTERN.exec(trimmed)
  const [start, end] = token.map
  if (!marker) {
    throw new Error(`${state.source}:${start + 1}: tested-example marker is missing a valid identifier`)
  }
  const [, identifier] = marker
  if (state.identifiers.has(identifier)) {
    throw new Error(`${state.source}:${start + 1}: duplicate tested-example identifier '${identifier}'`)
  }

  const entry = { identifier, end, level: token.level }
  state.identifiers.add(identifier)
  state.markers.set(start, entry)
  state.markersByEnd.set(`${end}:${identity}`, { ...entry, start })
}

/**
 * Reject a fence token that MarkdownIt did not close.
 *
 * MarkdownIt applies block quote and list indentation before populating
 * `content`. A closed fence omits both delimiter lines; an open fence keeps
 * the final source line as content. Comparing those line counts therefore
 * follows the parser's container-aware rules.
 *
 * @param {object} token - Markdown fence token.
 * @param {object} state - Mutable parse state for the document.
 * @throws {Error} The opening fence is unterminated.
 */
function assertFenceClosed(token, state) {
  const [openingIndex, endIndex] = token.map
  const contentLineCount = token.content.split('\n').length
    - Number(token.content === '' || token.content.endsWith('\n'))
  if (endIndex - openingIndex !== contentLineCount + 2) {
    throw new Error(`${state.source}:${openingIndex + 1}: unterminated fenced example`)
  }
}

/**
 * Parse one fenced block and require its immediately preceding marker.
 *
 * @param {object} token - Markdown fence token.
 * @param {object} state - Mutable parse state for the document.
 * @param {string} identity - Identity of the current Markdown containers.
 * @returns {object} Parsed published example.
 * @throws {Error} A fence has no marker.
 */
function parseExample(token, state, identity) {
  const [openingIndex] = token.map
  assertFenceClosed(token, state)
  const marker = state.markersByEnd.get(`${openingIndex}:${identity}`)
  if (!marker || marker.level !== token.level) {
    throw new Error(`${state.source}:${openingIndex + 1}: fenced example has no immediately preceding tested-example marker`)
  }
  state.consumedMarkers.add(marker.start)

  const info = token.info.trim()
  const language = info.split(/[\s,]+/u)[0]?.toLowerCase() || ''
  return {
    id: marker.identifier,
    source: state.source,
    line: openingIndex + 1,
    info,
    language,
    code: token.content.replace(/\n$/u, ''),
  }
}

/**
 * Reject markers that were not attached to a fenced example.
 *
 * @param {object} state - Mutable parse state for the document.
 * @throws {Error} A marker does not precede a fenced example.
 */
function assertMarkersConsumed(state) {
  for (const [line, marker] of state.markers) {
    if (!state.consumedMarkers.has(line)) {
      throw new Error(`${state.source}:${line + 1}: tested-example marker '${marker.identifier}' does not precede a fenced example`)
    }
  }
}

/**
 * Parse every marked fenced example in one Markdown document.
 *
 * Markdown block tokens preserve CommonMark container structure, so fences
 * inside block quotes and nested list items receive the same coverage checks
 * as fences at the document root. The parser also removes container prefixes
 * from the extracted example content.
 *
 * @param {string} markdown - Published Markdown source.
 * @param {string} source - Document name used in diagnostics.
 * @returns {Map<string, object>} Examples keyed by stable identifier.
 * @throws {Error} A fence or marker violates the published example contract.
 */
export function parseTestedExamples(markdown, source = '<markdown>') {
  const state = createParseState(source)
  const tokens = MARKDOWN.parse(markdown, {})
  const containers = []
  for (const [tokenIndex, token] of tokens.entries()) {
    updateContainerPath(token, tokenIndex, containers)
    const identity = containerIdentity(containers)
    recordMarker(token, state, identity)
    if (token.type === 'fence') {
      const example = parseExample(token, state, identity)
      state.examples.set(example.id, example)
    }
  }

  assertMarkersConsumed(state)
  return state.examples
}

/**
 * Load examples from the user-facing documents covered by the style guide.
 *
 * @param {string} rootDirectory - Repository root containing the documents.
 * @returns {Map<string, object>} Examples keyed by unique stable identifier.
 * @throws {Error} A marker is invalid or duplicated across documents.
 */
export function loadTestedExamples(rootDirectory = REPOSITORY_ROOT) {
  const examples = new Map()
  for (const document of DOCUMENTS) {
    const source = readFileSync(path.resolve(rootDirectory, document), 'utf8')
    for (const [identifier, example] of parseTestedExamples(source, document)) {
      if (examples.has(identifier)) {
        throw new Error(`${document}:${example.line}: duplicate tested-example identifier '${identifier}'`)
      }
      examples.set(identifier, example)
    }
  }
  return examples
}

/**
 * Return one published example, loading the documents when no index is given.
 *
 * @param {string} identifier - Stable tested-example identifier.
 * @param {Map<string, object>} examples - Previously loaded example index.
 * @returns {object} The published example identified by `identifier`.
 * @throws {Error} No published example has that identifier.
 */
export function getTestedExample(identifier, examples = loadTestedExamples()) {
  const example = examples.get(identifier)
  if (!example) throw new Error(`No published tested example has identifier '${identifier}'`)
  return example
}
