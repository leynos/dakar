/** @file Test deterministic path-policy matching and prompt-safe slicing. */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  pathInstructionsFor,
  policyGuidanceBlock,
  policyPathMatches,
} from '../src/workflows/dakar-review/policy.ts'

const POLICY = {
  version: 1,
  language: 'en-GB',
  toneInstructions: 'Be direct.',
  profile: 'assertive',
  pathInstructions: [
    {
      policyRef: 'reviews.path_instructions[0]',
      path: '**/*.{js,ts}',
      instructions: 'JavaScript and TypeScript rule.',
    },
    {
      policyRef: 'reviews.path_instructions[1]',
      path: '**/*.md',
      instructions: 'Markdown rule.',
    },
  ],
  customChecks: [{
    gateId: 'gate-001-contract',
    name: 'Contract',
    blocking: false,
    instructions: 'Preserve the public contract.',
  }],
  ignoredKeys: ['early_access'],
}

test('policyPathMatches handles recursive globs and brace expansion deterministically', () => {
  assert.equal(policyPathMatches('src/main.ts', '**/*.{js,ts}'), true)
  assert.equal(policyPathMatches('main.js', '**/*.{js,ts}'), true)
  assert.equal(policyPathMatches('docs/guide.md', '**/*.{js,ts}'), false)
  assert.equal(policyPathMatches('README.md', '**/*.md'), true)
})

test('pathInstructionsFor slices policy to each evidence pack in source order', () => {
  assert.deepEqual(pathInstructionsFor(POLICY, ['src/main.ts']), [{
    ...POLICY.pathInstructions[0],
    matchingPaths: ['src/main.ts'],
  }])
  assert.deepEqual(pathInstructionsFor(POLICY, ['docs/guide.md']), [{
    ...POLICY.pathInstructions[1],
    matchingPaths: ['docs/guide.md'],
  }])
})

test('policyGuidanceBlock omits non-matching and unsupported policy', () => {
  const block = policyGuidanceBlock(POLICY, ['src/main.ts'])

  assert.match(block, /JavaScript and TypeScript rule/u)
  assert.doesNotMatch(block, /Markdown rule/u)
  assert.doesNotMatch(block, /early_access/u)
  assert.doesNotMatch(block, /ignored/u)
  assert.match(block, /Preserve the public contract/u)
})
