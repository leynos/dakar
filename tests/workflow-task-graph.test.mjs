/**
 * @file Unit-test the deterministic review task planner in the ODW workflow.
 *
 * The invariants under test: every changed file is represented, the mandatory
 * review-summary task always survives, the plan never exceeds maxTasks, and the
 * planner fails closed instead of silently dropping work.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fc from 'fast-check'

import { DEFAULT_REVIEW_MODELS } from '../src/workflows/dakar-review/model-routing.ts'
import { buildTaskGraph, chunk, distributeTaskSlots } from '../src/workflows/dakar-review/task-graph.ts'

function plannerConfig(overrides = {}) {
  return {
    maxFindings: 20,
    maxTasks: 8,
    reviewModels: DEFAULT_REVIEW_MODELS,
    ...overrides,
  }
}

function filesIn(tasks) {
  const seen = new Set()
  for (const task of tasks) {
    if (task.kind === 'review-summary') {
      continue
    }
    for (const file of task.files) {
      seen.add(file)
    }
  }
  return seen
}

test('buildTaskGraph represents every changed file and appends a review summary', () => {
  const config = plannerConfig({ maxTasks: 8 })
  const changedFiles = [
    'src/a.js',
    'src/b.js',
    'tests/a.test.js',
    'settings.yaml',
    'docs/guide.md',
  ]

  const tasks = buildTaskGraph({ changedFiles }, config)

  assert.ok(tasks.length <= config.maxTasks)
  assert.equal(tasks[tasks.length - 1].kind, 'review-summary')
  assert.equal(tasks.filter((task) => task.kind === 'review-summary').length, 1)
  assert.deepEqual([...filesIn(tasks)].sort(), [...changedFiles].sort())
})

test('buildTaskGraph rebalances chunking so a large group never drops files', () => {
  const config = plannerConfig({ maxTasks: 4 })
  const changedFiles = Array.from({ length: 20 }, (_, index) => `src/module-${index}.js`)

  const tasks = buildTaskGraph({ changedFiles }, config)

  assert.ok(tasks.length <= config.maxTasks, `expected <= ${config.maxTasks} tasks, got ${tasks.length}`)
  assert.equal(tasks[tasks.length - 1].kind, 'review-summary')
  // Every one of the 20 source files must still be covered by some task.
  assert.equal(filesIn(tasks).size, changedFiles.length)
  assert.deepEqual([...filesIn(tasks)].sort(), [...changedFiles].sort())
})

test('buildTaskGraph fails closed when maxTasks cannot fit every group', () => {
  const config = plannerConfig({ maxTasks: 4 })
  const changedFiles = ['src/a.js', 'tests/a.test.js', 'settings.yaml', 'docs/guide.md']

  // Four distinct groups plus a mandatory review summary cannot fit maxTasks=4;
  // the planner must abort rather than silently truncate the plan.
  assert.throws(() => buildTaskGraph({ changedFiles }, config), /maxTasks=4 is too small/u)
})

test('distributeTaskSlots gives every group at least one slot within budget', () => {
  const groups = [
    { kind: 'source', files: ['a', 'b', 'c', 'd'] },
    { kind: 'tests', files: ['e'] },
  ]

  const slots = distributeTaskSlots(groups, 5)
  const total = [...slots.values()].reduce((sum, value) => sum + value, 0)

  assert.ok(slots.get('source') >= 1)
  assert.ok(slots.get('tests') >= 1)
  assert.ok(total <= 5)
  // The heavier group should receive the surplus slots.
  assert.ok(slots.get('source') > slots.get('tests'))
})

test('chunk rejects sizes that cannot advance its cursor', () => {
  for (const size of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => chunk([1], size), /positive finite/u)
  }
})

test('chunk preserves every value exactly once for every positive size', () => {
  fc.assert(fc.property(
    fc.array(fc.integer()),
    fc.integer({ min: 1, max: 100 }),
    (values, size) => {
      const chunks = chunk(values, size)
      assert.deepEqual(chunks.flat(), values)
      assert.ok(chunks.every((part) => part.length > 0 && part.length <= size))
    },
  ))
})
