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
 * Record a marker represented by a standalone HTML comment block.
 *
 * @param {object} token - Markdown block token to inspect.
 * @param {object} state - Mutable parse state for the document.
 * @returns {boolean} Whether the token was a tested-example marker.
 */
function recordMarker(token, state) {
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
  state.markersByEnd.set(end, { ...entry, start })
}

/**
 * Remove block quote prefixes from a source line before checking its fence.
 *
 * @param {string} line - Raw Markdown line.
 * @returns {string} Line content after block quote markers.
 */
function stripBlockquotePrefixes(line) {
  let content = line
  let prefix = /^ {0,3}> ?/u.exec(content)
  while (prefix) {
    content = content.slice(prefix[0].length)
    prefix = /^ {0,3}> ?/u.exec(content)
  }
  return content
}

/**
 * Build the closing-fence pattern for the indentation of an opening fence.
 *
 * @param {string} opening - Opening fence line after block quote prefixes.
 * @param {object} token - Markdown fence token.
 * @returns {RegExp} Pattern that matches a valid closing delimiter.
 */
function closingFencePattern(opening, token) {
  const openingIndent = /^ */u.exec(opening)[0].length
  const minIndent = token.level === 0 ? 0 : Math.max(0, openingIndent - 3)
  const maxIndent = token.level === 0 ? 3 : openingIndent + 3
  const character = token.markup[0]
  return new RegExp(`^ {${minIndent},${maxIndent}}${character}{${token.markup.length},}[\\t ]*$`, 'u')
}

/**
 * Reject a fenced block that reaches its Markdown block end without a closer.
 *
 * @param {string[]} lines - Raw Markdown document lines.
 * @param {object} token - Markdown fence token.
 * @param {object} state - Mutable parse state for the document.
 * @throws {Error} The opening fence is unterminated.
 */
function assertFenceClosed(lines, token, state) {
  const [openingIndex, endIndex] = token.map
  if (endIndex < openingIndex + 2) {
    throw new Error(`${state.source}:${openingIndex + 1}: unterminated fenced example`)
  }
  const opening = stripBlockquotePrefixes(lines[openingIndex])
  const closing = stripBlockquotePrefixes(lines[endIndex - 1])
  if (!closingFencePattern(opening, token).test(closing)) {
    throw new Error(`${state.source}:${openingIndex + 1}: unterminated fenced example`)
  }
}

/**
 * Parse one fenced block and require its immediately preceding marker.
 *
 * @param {string[]} lines - Raw Markdown document lines.
 * @param {object} token - Markdown fence token.
 * @param {object} state - Mutable parse state for the document.
 * @returns {object} Parsed published example.
 * @throws {Error} A fence has no marker.
 */
function parseExample(lines, token, state) {
  const [openingIndex] = token.map
  assertFenceClosed(lines, token, state)
  const marker = state.markersByEnd.get(openingIndex)
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
  const lines = markdown.split(/\r?\n/u)
  const tokens = MARKDOWN.parse(markdown, {})
  for (const token of tokens) {
    recordMarker(token, state)
    if (token.type === 'fence') {
      const example = parseExample(lines, token, state)
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
