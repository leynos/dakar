/**
 * Verify host-side MCP context translation and shell-safe prompt examples.
 *
 * @module
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import fc from 'fast-check'

import { contextToolsBlock } from '../scripts/context-tools.mjs'
import { shellWord } from '../src/workflows/dakar-review/shell.ts'

const REPO_ROOT = '/tmp/repo with spaces'

test('context adapter shell-quotes every MCP JSON payload', () => {
  const repoRoot = "/tmp/repo'; echo unwanted"
  const repoSlug = "owner/repo'; echo unwanted"
  const guidance = contextToolsBlock(repoRoot, repoSlug)
  const payload = (value) => shellWord(JSON.stringify(value))

  assert.ok(guidance.includes(`codegraph_get_ai_context ${payload({ uri: `file://${repoRoot}/<path>`, line: '<n>', intent: 'explain' })}`))
  assert.ok(guidance.includes(`codegraph_get_callers ${payload({ uri: `file://${repoRoot}/<path>`, line: '<n>' })}`))
  assert.ok(guidance.includes(`codegraph_analyze_impact ${payload({ uri: `file://${repoRoot}/<path>`, line: '<n>', changeType: 'modify' })}`))
  assert.ok(guidance.includes(`codegraph_symbol_search ${payload({ query: '...' })} and codegraph_search_docs ${payload({ query: '...' })}`))
  assert.ok(guidance.includes(`deepwiki ask_question ${payload({ repoName: repoSlug, question: '...' })}`))
  assert.ok(guidance.includes(`deepwiki read_wiki_structure ${payload({ repoName: repoSlug })}`))
  assert.ok(!guidance.includes(`'{"repoName":"${repoSlug}`), 'repository identity must remain inside a JSON shell argument')
})

test('context adapter keeps arbitrary repository values inside one JSON shell argument', () => {
  const arbitraryRepoValue = fc.tuple(
    fc.string({ maxLength: 24 }),
    fc.constantFrom("'", '"', '`', '$()', ';', '&', '|', '\n', '雪/🧭'),
    fc.string({ maxLength: 24 }),
  ).map((parts) => parts.join(''))

  fc.assert(
    fc.property(arbitraryRepoValue, arbitraryRepoValue, (repoRoot, repoSlug) => {
      const guidance = contextToolsBlock(repoRoot, repoSlug)
      const expected = [
        ['codegraph_get_ai_context', { uri: `file://${repoRoot}/<path>`, line: '<n>', intent: 'explain' }, ' —'],
        ['codegraph_get_callers', { uri: `file://${repoRoot}/<path>`, line: '<n>' }, ' (and codegraph_get_callees)'],
        ['codegraph_analyze_impact', { uri: `file://${repoRoot}/<path>`, line: '<n>', changeType: 'modify' }, ' —'],
        ['codegraph_symbol_search', { query: '...' }, ' and codegraph_search_docs '],
        ['codegraph_search_docs', { query: '...' }, ' —'],
        ['deepwiki ask_question', { repoName: repoSlug, question: '...' }, ' —'],
        ['deepwiki read_wiki_structure', { repoName: repoSlug }, ' then read_wiki_contents —'],
      ]

      assert.equal(
        guidance.split('\n').filter((line) => /^- mcp (?:codegraph|deepwiki)\b/u.test(line)).length,
        6,
        'all expected CodeGraph and DeepWiki command examples must be present',
      )
      for (const [marker, payloadValue, expectedSuffix] of expected) {
        const lines = guidance.split('\n').filter((line) => line.includes(marker))
        assert.equal(lines.length, 1, `${marker} should appear in one command example`)
        const line = lines[0]
        const markerEnd = line.indexOf(marker) + marker.length
        const encoded = /^'(?:[^']|'"'"')*'/u.exec(line.slice(markerEnd).trimStart())?.[0]
        assert.ok(encoded, `${marker} payload should be one single-quoted shell word`)
        const json = encoded.slice(1, -1).replaceAll(`'"'"'`, "'")
        assert.deepEqual(JSON.parse(json), payloadValue, `${marker} should decode to its original JSON payload`)
        const suffix = line.slice(markerEnd).trimStart().slice(encoded.length)
        assert.ok(suffix.startsWith(expectedSuffix), `${marker} must not append shell syntax after its payload`)
      }
    }),
    { numRuns: 200 },
  )
})

test('context adapter omits DeepWiki commands without a GitHub identity', () => {
  const guidance = contextToolsBlock(REPO_ROOT, '')

  assert.match(guidance, /DeepWiki: unavailable for this repository/u)
  assert.doesNotMatch(guidance, /mcp deepwiki/u)
})

test('context adapter warns that DeepWiki can be stale and is not head evidence', () => {
  const guidance = contextToolsBlock(REPO_ROOT, 'owner/repository')

  assert.match(guidance, /not realtime/iu, 'DeepWiki guidance must state that its content is not current')
  assert.match(guidance, /over the past week/iu, 'DeepWiki guidance must disclose its staleness window')
  assert.match(guidance, /never cite it as evidence about the current head/iu, 'DeepWiki must not be treated as evidence for the reviewed head')
})
