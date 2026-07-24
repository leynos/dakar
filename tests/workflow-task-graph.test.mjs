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
import { buildFlexFinderPlan, buildTaskGraph, chunk, distributeTaskSlots } from '../src/workflows/dakar-review/task-graph.ts'

function flexConfig(overrides = {}) {
  return { maxLunaFlexCalls: 4, maxTasks: 8, transactionMaxFiles: 5, lunaRole: 'luna', maxFindings: 20, ...overrides }
}

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

test('buildFlexFinderPlan bounds packs, drops the review summary, and routes to Luna', () => {
  const changedFiles = ['src/a.js', 'src/b.js', 'tests/a.test.js', 'docs/guide.md']
  const { packs, truncatedFiles } = buildFlexFinderPlan({ changedFiles }, flexConfig())

  assert.ok(packs.length <= 4, 'never more than maxLunaFlexCalls packs')
  assert.equal(truncatedFiles.length, 0)
  assert.equal(packs.every((pack) => pack.files.length <= 5), true)
  assert.equal(packs.some((pack) => pack.kind === 'review-summary'), false)
  assert.equal(packs.every((pack) => pack.adapter === 'pi-luna-flex'), true)
  assert.equal(packs.every((pack) => pack.model === 'gpt-5.6-luna'), true)
  assert.equal(packs.every((pack) => pack.role === 'luna'), true)
  assert.equal(packs.every((pack) => pack.serviceTier === 'flex'), true)
  assert.equal(packs.every((pack) => pack.reasoningEffort === 'low'), true)
  // Every changed file is covered by exactly one pack in the untruncated case.
  const covered = packs.flatMap((pack) => pack.files)
  assert.deepEqual([...covered].sort(), [...changedFiles].sort())
})

test('buildFlexFinderPlan packs are homogeneous by kind when file counts allow', () => {
  const changedFiles = ['src/a.js', 'src/b.js', 'tests/a.test.js', 'tests/b.test.js', 'docs/guide.md']
  const { packs } = buildFlexFinderPlan({ changedFiles }, flexConfig({ transactionMaxFiles: 2 }))

  for (const pack of packs) {
    const kinds = new Set(pack.files.map((file) => (file.startsWith('docs/') || file.endsWith('.md') ? 'docs' : file.includes('test') ? 'tests' : 'source')))
    assert.equal(kinds.size, 1, `pack ${pack.taskId} must be homogeneous, saw ${[...kinds]}`)
  }
})

test('buildFlexFinderPlan truncates files beyond the Luna coverage bound', () => {
  const changedFiles = Array.from({ length: 26 }, (_, index) => `src/module-${String(index).padStart(2, '0')}.js`)
  const { packs, truncatedFiles } = buildFlexFinderPlan({ changedFiles }, flexConfig())

  assert.equal(packs.length, 4)
  assert.equal(packs.reduce((sum, pack) => sum + pack.files.length, 0), 20)
  assert.equal(truncatedFiles.length, 6)
  // The 4x5 coverage window packs the first 20 files; the last 6 are truncated.
  assert.deepEqual(truncatedFiles, changedFiles.slice(20))
})

test('buildFlexFinderPlan honours maxTasks below maxLunaFlexCalls', () => {
  // --max-tasks composes with --max-luna-calls: the effective pack cap is the
  // smaller of the two, and the accounting for truncation reflects that cap.
  const changedFiles = Array.from({ length: 10 }, (_, index) => `src/module-${String(index).padStart(2, '0')}.js`)
  const { packs, truncatedFiles } = buildFlexFinderPlan(
    { changedFiles },
    flexConfig({ maxTasks: 1, maxLunaFlexCalls: 4, transactionMaxFiles: 1 }),
  )

  assert.equal(packs.length, 1, 'the effective cap is min(maxTasks, maxLunaFlexCalls)')
  assert.deepEqual(packs[0].files, ['src/module-00.js'])
  assert.deepEqual(truncatedFiles, changedFiles.slice(1))
})

test('buildFlexFinderPlan routes to the escalation lane when asked', () => {
  const { packs } = buildFlexFinderPlan({ changedFiles: ['src/a.js'] }, flexConfig({ lunaRole: 'luna-medium' }))
  assert.equal(packs[0].adapter, 'pi-luna-flex-medium')
  assert.equal(packs[0].reasoningEffort, 'medium')
  assert.equal(packs[0].role, 'luna-medium')
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

test('chunk rejects sizes that cannot partition by a positive integer', () => {
  for (const size of [0, -1, 0.5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => chunk([1], size), /positive integer/u)
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
