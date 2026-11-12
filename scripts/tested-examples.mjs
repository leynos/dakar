/**
 * Load marked examples from Dakar's published user-facing documentation.
 *
 * The loader keeps examples in the tests connected to the text users read and
 * rejects missing, malformed, orphaned, or duplicate example markers.
 *
 * @module
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DOCUMENTS = Object.freeze(['README.md', 'docs/users-guide.md', 'docs/migration-0.1.md'])
const MARKER_PATTERN = /^<!-- tested-example: ([a-z][a-z0-9]*(?:-[a-z0-9]+)*) -->$/u
const MARKER_PREFIX = '<!-- tested-example:'
const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})(.*)$/u

/**
 * Create parser state shared by the document-line helpers.
 *
 * @param {string} source - Document name used in diagnostics.
 * @returns {object} Mutable parse state for one Markdown document.
 */
function createParseState(source) {
  return {
    source,
    markers: new Map(),
    identifiers: new Set(),
    examples: new Map(),
    consumedMarkers: new Set(),
  }
}

/**
 * Record a marker line and reject malformed or duplicate identifiers.
 *
 * @param {string} line - Markdown line to inspect.
 * @param {number} index - Zero-based line index.
 * @param {object} state - Mutable parse state for the document.
 * @returns {boolean} Whether the line was a tested-example marker.
 */
function recordMarker(line, index, state) {
  const trimmed = line.trim()
  if (!trimmed.startsWith(MARKER_PREFIX)) return false

  const marker = MARKER_PATTERN.exec(trimmed)
  if (!marker) {
    throw new Error(`${state.source}:${index + 1}: tested-example marker is missing a valid identifier`)
  }
  const [, identifier] = marker
  if (state.identifiers.has(identifier)) {
    throw new Error(`${state.source}:${index + 1}: duplicate tested-example identifier '${identifier}'`)
  }
  state.identifiers.add(identifier)
  state.markers.set(index, identifier)
  return true
}

/**
 * Find the matching closing fence for an opening delimiter.
 *
 * @param {string[]} lines - Markdown document lines.
 * @param {number} openingIndex - Zero-based line index of the opening fence.
 * @param {string} delimiter - Opening fence delimiter.
 * @param {object} state - Mutable parse state for the document.
 * @returns {number} Zero-based line index of the closing fence.
 * @throws {Error} The opening fence is unterminated.
 */
function closingFenceIndex(lines, openingIndex, delimiter, state) {
  const fenceCharacter = delimiter[0]
  const closingPattern = new RegExp(`^ {0,3}${fenceCharacter}{${delimiter.length},}[\\t ]*$`, 'u')
  let index = openingIndex + 1
  while (index < lines.length && !closingPattern.test(lines[index])) index += 1
  if (index >= lines.length) {
    throw new Error(`${state.source}:${openingIndex + 1}: unterminated fenced example`)
  }
  return index
}

/**
 * Parse one marked fenced example at a document line.
 *
 * @param {string[]} lines - Markdown document lines.
 * @param {number} index - Zero-based line index of the candidate opening fence.
 * @param {object} state - Mutable parse state for the document.
 * @returns {{ example: object, closingIndex: number } | undefined} Parsed example, or undefined for a non-fence line.
 * @throws {Error} A fence has no marker or is unterminated.
 */
function parseExampleAt(lines, index, state) {
  const opening = FENCE_PATTERN.exec(lines[index])
  if (!opening) return

  const [, delimiter, info] = opening
  const closingIndex = closingFenceIndex(lines, index, delimiter, state)
  const markerIndex = index - 1
  const identifier = state.markers.get(markerIndex)
  if (!identifier) {
    throw new Error(`${state.source}:${index + 1}: fenced example has no immediately preceding tested-example marker`)
  }
  state.consumedMarkers.add(markerIndex)

  const infoString = info.trim()
  const language = infoString.split(/[\s,]+/u)[0]?.toLowerCase() || ''
  return {
    closingIndex,
    example: {
      id: identifier,
      source: state.source,
      line: index + 1,
      info: infoString,
      language,
      code: lines.slice(index + 1, closingIndex).join('\n'),
    },
  }
}

/**
 * Reject markers that were not attached to a fenced example.
 *
 * @param {object} state - Mutable parse state for the document.
 * @throws {Error} A marker does not precede a fenced example.
 */
function assertMarkersConsumed(state) {
  for (const [line, identifier] of state.markers) {
    if (!state.consumedMarkers.has(line)) {
      throw new Error(`${state.source}:${line + 1}: tested-example marker '${identifier}' does not precede a fenced example`)
    }
  }
}

/**
 * Consume one line and return the last line that can be skipped by the caller.
 *
 * @param {string[]} lines - Markdown document lines.
 * @param {number} index - Zero-based line index.
 * @param {object} state - Mutable parse state for the document.
 * @returns {number} Current line or closing-fence line for the parsed example.
 */
function parseDocumentLine(lines, index, state) {
  if (recordMarker(lines[index], index, state)) return index
  const parsed = parseExampleAt(lines, index, state)
  if (!parsed) return index
  state.examples.set(parsed.example.id, parsed.example)
  return parsed.closingIndex
}

/**
 * Parse every marked fenced example in one Markdown document.
 *
 * A marker must be the complete line immediately before its opening fence.
 * Fence delimiters follow CommonMark's matching character and minimum-length
 * rules, so a closing fence must use the same character and at least as many
 * delimiters as its opener.
 *
 * @param {string} markdown - Published Markdown source.
 * @param {string} source - Document name used in diagnostics.
 * @returns {Map<string, object>} Examples keyed by stable identifier.
 * @throws {Error} A fence or marker violates the published example contract.
 */
export function parseTestedExamples(markdown, source = '<markdown>') {
  const lines = markdown.split(/\r?\n/u)
  const state = createParseState(source)
  for (let index = 0; index < lines.length; index += 1) {
    index = parseDocumentLine(lines, index, state)
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
