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
  const markers = new Map()
  const identifiers = new Set()
  const examples = new Map()
  const consumedMarkers = new Set()

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const trimmed = line.trim()

    if (trimmed.startsWith(MARKER_PREFIX)) {
      const marker = MARKER_PATTERN.exec(trimmed)
      if (!marker) {
        throw new Error(`${source}:${index + 1}: tested-example marker is missing a valid identifier`)
      }
      const [, identifier] = marker
      if (identifiers.has(identifier)) {
        throw new Error(`${source}:${index + 1}: duplicate tested-example identifier '${identifier}'`)
      }
      identifiers.add(identifier)
      markers.set(index, identifier)
      continue
    }

    const opening = FENCE_PATTERN.exec(line)
    if (!opening) continue

    const [, delimiter, info] = opening
    const fenceCharacter = delimiter[0]
    const closingPattern = new RegExp(`^ {0,3}${fenceCharacter}{${delimiter.length},}[\\t ]*$`, 'u')
    let closingIndex = index + 1
    while (closingIndex < lines.length && !closingPattern.test(lines[closingIndex])) closingIndex += 1
    if (closingIndex >= lines.length) {
      throw new Error(`${source}:${index + 1}: unterminated fenced example`)
    }

    const identifier = markers.get(index - 1)
    if (!identifier) {
      throw new Error(`${source}:${index + 1}: fenced example has no immediately preceding tested-example marker`)
    }
    consumedMarkers.add(index - 1)

    const infoString = info.trim()
    const language = infoString.split(/[\s,]+/u)[0]?.toLowerCase() || ''
    examples.set(identifier, {
      id: identifier,
      source,
      line: index + 1,
      info: infoString,
      language,
      code: lines.slice(index + 1, closingIndex).join('\n'),
    })
    index = closingIndex
  }

  for (const [line, identifier] of markers) {
    if (!consumedMarkers.has(line)) {
      throw new Error(`${source}:${line + 1}: tested-example marker '${identifier}' does not precede a fenced example`)
    }
  }

  return examples
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
