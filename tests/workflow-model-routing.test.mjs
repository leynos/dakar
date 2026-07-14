/** @file Unit-test pure model-routing and shell helpers from TypeScript source. */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  adapterForReasoning,
  baseModel,
  isReasoning,
  modelForRole,
  modelName,
  reasoningFromModel,
} from '../src/workflows/dakar-review/model-routing.ts'
import { shellWord } from '../src/workflows/dakar-review/shell.ts'

test('model identifiers preserve explicit reasoning and supply defaults', () => {
  assert.equal(modelName('gpt-5.5/high'), 'gpt-5.5/high')
  assert.equal(modelName('gpt-5.5'), 'gpt-5.5/default')
  assert.equal(modelName({ model: 'gpt-5.5', reasoning: 'high' }), 'gpt-5.5/high')
  assert.equal(baseModel('gpt-5.5/high'), 'gpt-5.5')
  assert.equal(reasoningFromModel('gpt-5.5/high', 'medium'), 'high')
  assert.equal(reasoningFromModel('gpt-5.5', 'medium'), 'medium')
  assert.throws(
    () => modelName({ reasoning: 'high' }),
    /non-empty model string/u,
  )
  assert.throws(
    () => modelName({ model: '', reasoning: 'high' }),
    /non-empty model string/u,
  )
})

test('adapter selection accepts supported reasoning and falls back safely', () => {
  assert.equal(adapterForReasoning('low'), 'codex-low')
  assert.equal(adapterForReasoning('medium'), 'codex-medium')
  assert.equal(adapterForReasoning('high'), 'codex-high')
  assert.equal(adapterForReasoning('experimental'), 'codex-medium')

  assert.equal(isReasoning('low'), true)
  assert.equal(isReasoning('medium'), true)
  assert.equal(isReasoning('high'), true)
  assert.equal(isReasoning('experimental'), false)
})

test('role lookup preserves configuration order and has a closed fallback', () => {
  const models = [
    { model: 'first', reasoning: 'medium', role: 'medium' },
    { model: 'specialist', reasoning: 'high', role: 'high' },
  ]

  assert.equal(modelForRole('high', models), models[1])
  assert.equal(modelForRole('missing', models), models[0])
  assert.deepEqual(modelForRole('missing', []), { model: 'gpt-5.5', reasoning: 'high' })
})

test('shellWord quotes empty, whitespace, and embedded single quotes', () => {
  assert.equal(shellWord(''), "''")
  assert.equal(shellWord('two words'), "'two words'")
  assert.equal(shellWord("it's"), "'it'\"'\"'s'")
})
