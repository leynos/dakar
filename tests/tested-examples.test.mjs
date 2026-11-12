/**
 * Verify the published example loader and the test coverage inventory.
 *
 * @module
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import fc from 'fast-check'
import { load as loadYaml } from 'js-yaml'
import { loadTestedExamples, parseTestedExamples } from '../scripts/tested-examples.mjs'

const REPOSITORY_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const EXPECTED_EXAMPLES = [
  'migration-0-1-install-contract',
  'readme-install-cli',
  'readme-review-commands',
  'readme-review-flow',
  'users-guide-cli-error',
  'users-guide-custom-checks',
  'users-guide-direct-workflow',
  'users-guide-dry-run',
  'users-guide-dry-run-result',
  'users-guide-install-cli',
  'users-guide-review-branch',
  'users-guide-skipped-result',
  'users-guide-state-root',
  'users-guide-state-root-direct-workflow',
  'users-guide-telemetry',
  'users-guide-telemetry-redirect',
  'users-guide-tuning-workflow',
]
const IDENTIFIER_ARBITRARY = fc.stringMatching(/^[a-z][a-z0-9]*(?:-[a-z0-9]+){0,3}$/u)
const INFO_ARBITRARY = fc.stringMatching(/^[a-z][a-z0-9-]{0,8}$/u)

function renderMarkedExamples(identifiers) {
  return identifiers
    .map((identifier, index) => [
      `<!-- tested-example: ${identifier} -->`,
      `${' '.repeat(index % 4)}${'```'}bash`,
      `echo ${index}`,
      `${' '.repeat((index + 2) % 4)}${'```'}`,
    ].join('\n'))
    .join('\n')
}

test('published examples are marked, unique, and present in the coverage inventory', () => {
  const examples = loadTestedExamples(REPOSITORY_ROOT)
  assert.deepEqual([...examples.keys()].toSorted(), [...EXPECTED_EXAMPLES].toSorted())
})

test('the shared loader rejects an unmarked fence', () => {
  assert.throws(() => parseTestedExamples('```bash\necho ready\n```', 'fixture.md'), /no immediately preceding/u)
})

test('the shared loader rejects unmarked fences in block quotes and nested lists', () => {
  assert.throws(
    () => parseTestedExamples('> ```bash\n> echo ready\n> ```', 'blockquote.md'),
    /no immediately preceding/u,
  )
  assert.throws(
    () => parseTestedExamples('- outer\n  - inner\n\n    ```bash\n    echo ready\n    ```', 'nested-list.md'),
    /no immediately preceding/u,
  )
})

test('a marker in one list item does not mark a fence in its sibling', () => {
  const markdown = [
    '- <!-- tested-example: sibling -->',
    '- ```bash',
    '  echo unmarked',
    '  ```',
  ].join('\n')

  assert.throws(() => parseTestedExamples(markdown, 'sibling-items.md'), /no immediately preceding/u)
})

test('the parser follows CommonMark fence character, length, and indentation rules', () => {
  fc.assert(
    fc.property(
      fc.constantFrom('`', '~'),
      fc.integer({ min: 3, max: 6 }),
      fc.integer({ min: 0, max: 3 }),
      fc.integer({ min: 0, max: 3 }),
      fc.integer({ min: 0, max: 3 }),
      INFO_ARBITRARY,
      (character, openingLength, extraLength, openingIndent, closingIndent, info) => {
        const opening = `${' '.repeat(openingIndent)}${character.repeat(openingLength)} ${info}`
        const closing = `${' '.repeat(closingIndent)}${character.repeat(openingLength + extraLength)}`
        const markdown = `<!-- tested-example: generated -->\n${opening}\necho ready\n${closing}`
        const example = parseTestedExamples(markdown).get('generated')

        assert.equal(example.info, info)
        assert.equal(example.code, 'echo ready')
      },
    ),
  )

  fc.assert(
    fc.property(
      fc.constantFrom('`', '~'),
      fc.integer({ min: 3, max: 6 }),
      fc.integer({ min: 0, max: 3 }),
      fc.integer({ min: 0, max: 3 }),
      INFO_ARBITRARY,
      (character, openingLength, openingIndent, closingIndent, info) => {
        const otherCharacter = character === '`' ? '~' : '`'
        const opening = `${' '.repeat(openingIndent)}${character.repeat(openingLength)} ${info}`
        const closing = `${' '.repeat(closingIndent)}${otherCharacter.repeat(openingLength)}`
        const markdown = `<!-- tested-example: generated -->\n${opening}\necho ready\n${closing}`

        assert.throws(() => parseTestedExamples(markdown), /unterminated/u)
      },
    ),
  )

  fc.assert(
    fc.property(
      fc.constantFrom('`', '~'),
      fc.integer({ min: 4, max: 6 }).chain((openingLength) =>
        fc.integer({ min: 3, max: openingLength - 1 }).map((closingLength) => ({ openingLength, closingLength })),
      ),
      fc.integer({ min: 0, max: 3 }),
      fc.integer({ min: 0, max: 3 }),
      INFO_ARBITRARY,
      (character, { openingLength, closingLength }, openingIndent, closingIndent, info) => {
        const opening = `${' '.repeat(openingIndent)}${character.repeat(openingLength)} ${info}`
        const closing = `${' '.repeat(closingIndent)}${character.repeat(closingLength)}`
        const markdown = `<!-- tested-example: generated -->\n${opening}\necho ready\n${closing}`

        assert.throws(() => parseTestedExamples(markdown), /unterminated/u)
      },
    ),
  )
})

test('marker and fence sequences preserve a one-to-one identifier mapping', () => {
  fc.assert(
    fc.property(fc.uniqueArray(IDENTIFIER_ARBITRARY, { minLength: 1, maxLength: 6 }), (identifiers) => {
      const examples = parseTestedExamples(renderMarkedExamples(identifiers))
      assert.deepEqual([...examples.keys()], identifiers)
      assert.throws(
        () => parseTestedExamples(renderMarkedExamples([...identifiers, identifiers[0]])),
        /duplicate tested-example identifier/u,
      )
      assert.throws(
        () => parseTestedExamples(`${renderMarkedExamples(identifiers)}\n<!-- tested-example: orphan -->`),
        /does not precede a fenced example/u,
      )
      assert.throws(
        () => parseTestedExamples(`${renderMarkedExamples(identifiers)}\n\`\`\`bash\necho unmarked\n\`\`\``),
        /no immediately preceding/u,
      )
    }),
  )
})

test('the shared loader extracts marked fences from block quotes and nested lists', () => {
  const examples = parseTestedExamples(
    [
      '> <!-- tested-example: quoted -->',
      '> ```bash',
      '> echo quoted',
      '> ```',
      '- outer',
      '  - inner',
      '',
      '    <!-- tested-example: nested-list -->',
      '    ```bash',
      '    echo nested',
      '    ```',
    ].join('\n'),
    'containers.md',
  )

  assert.equal(examples.get('quoted').code, 'echo quoted')
  assert.equal(examples.get('nested-list').code, 'echo nested')
})

test('the shared loader rejects an unterminated fence', () => {
  assert.throws(
    () => parseTestedExamples('<!-- tested-example: open-fence -->\n```bash\necho ready', 'fixture.md'),
    /unterminated/u,
  )
  assert.throws(
    () => parseTestedExamples('- outer\n  - inner\n\n    <!-- tested-example: open-list-fence -->\n    ```bash\n    echo ready', 'nested-list.md'),
    /unterminated/u,
  )
})

test('the shared loader rejects a missing marker identifier', () => {
  assert.throws(
    () => parseTestedExamples('<!-- tested-example: -->\n```bash\necho ready\n```', 'fixture.md'),
    /missing a valid identifier/u,
  )
})

test('the shared loader rejects duplicate identifiers and orphan markers', () => {
  assert.throws(
    () => parseTestedExamples(
      '<!-- tested-example: repeated -->\n```bash\necho one\n```\n<!-- tested-example: repeated -->\n```bash\necho two\n```',
      'fixture.md',
    ),
    /duplicate tested-example identifier/u,
  )
  assert.throws(
    () => parseTestedExamples('<!-- tested-example: orphan -->\nparagraph', 'fixture.md'),
    /does not precede a fenced example/u,
  )
})

test('published shell, JSON, and YAML examples pass their language parsers', () => {
  const examples = loadTestedExamples(REPOSITORY_ROOT)
  for (const example of examples.values()) {
    if (example.language === 'bash' || example.language === 'sh') {
      const checked = spawnSync('bash', ['-n'], { input: example.code, encoding: 'utf8' })
      assert.equal(checked.status, 0, `${example.source}:${example.line}: ${checked.stderr}`)
    } else if (example.language === 'json') {
      assert.doesNotThrow(() => JSON.parse(example.code), `${example.id} must remain valid JSON`)
    } else if (example.language === 'yaml') {
      assert.doesNotThrow(() => loadYaml(example.code), `${example.id} must remain valid YAML`)
    } else {
      assert.ok(['mermaid'].includes(example.language), `${example.id} has an untested language '${example.language}'`)
      assert.match(example.code, /^flowchart\s/u, `${example.id} must remain a renderable Mermaid flowchart`)
    }
  }
})

test('custom checks example is accepted by Dakar policy validation', async () => {
  const { parseReviewPolicy } = await import('../scripts/review-config.mjs')
  const example = loadTestedExamples(REPOSITORY_ROOT).get('users-guide-custom-checks')
  const policy = parseReviewPolicy(example.code, { configPath: 'users-guide-custom-checks.yaml' })

  assert.deepEqual(policy.customChecks.map(({ name, blocking, command }) => ({ name, blocking, command })), [
    { name: 'Test', blocking: true, command: 'make test' },
    { name: 'Advisory analysis', blocking: false, command: 'make advisory' },
  ])
})

test('docs:check runs the example contract before TypeDoc', () => {
  const packageJson = JSON.parse(readFileSync(join(REPOSITORY_ROOT, 'package.json'), 'utf8'))
  assert.equal(packageJson.scripts['docs:examples:check'], 'node scripts/check-tested-examples.mjs')
  assert.equal(
    packageJson.scripts['docs:check'],
    'npm run docs:examples:check && typedoc --options typedoc.json',
  )
})
