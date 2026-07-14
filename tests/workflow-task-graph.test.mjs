/**
 * @file Unit-test the deterministic review task planner in the ODW workflow.
 *
 * `buildTaskGraph` is defined inside the workflow body, so the tests slice the
 * declaration region above the control flow and compile it with inert injected
 * primitives (mirroring ODW's loader) to exercise the planner directly. The
 * invariants under test: every changed file is represented, the mandatory
 * review-summary task always survives, the plan never exceeds maxTasks, and the
 * planner fails closed instead of silently dropping work.
 */

import { readFile } from 'node:fs/promises'
import test from 'node:test'
import assert from 'node:assert/strict'

const WORKFLOW_PATH = new URL('../workflows/dakar-review.js', import.meta.url)
const CONTROL_FLOW_MARKER = 'if (cfg.dryRun === true) {'

async function loadPlanner(workflowArgs = {}) {
  let source = await readFile(WORKFLOW_PATH, 'utf8')
  source = source.replace(/^export const meta\s*=/mu, 'const meta =')
  source = source.replace(/^async function workflowMain\(\) \{\n/mu, '')
  const markerIndex = source.indexOf(CONTROL_FLOW_MARKER)
  assert.notEqual(markerIndex, -1, 'control-flow marker should exist above the planner region')
  const helperSource = source.slice(0, markerIndex)
  const factory = new Function(
    'args',
    'phase',
    'log',
    'agent',
    'parallel',
    'pipeline',
    'budget',
    'workflow',
    'validate',
    `${helperSource}\nreturn { buildTaskGraph, distributeTaskSlots, MAX_TASKS }`,
  )
  return factory(
    workflowArgs,
    () => {},
    () => {},
    async () => ({}),
    async () => [],
    async () => [],
    { total: null, spent: () => 0, remaining: () => Infinity },
    async () => ({}),
    () => ({ ok: true, errors: [], warnings: [] }),
  )
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

test('buildTaskGraph represents every changed file and appends a review summary', async () => {
  const { buildTaskGraph, MAX_TASKS } = await loadPlanner({ maxTasks: 8 })
  const changedFiles = [
    'src/a.js',
    'src/b.js',
    'tests/a.test.js',
    'settings.yaml',
    'docs/guide.md',
  ]

  const tasks = buildTaskGraph({ changedFiles })

  assert.ok(tasks.length <= MAX_TASKS)
  assert.equal(tasks[tasks.length - 1].kind, 'review-summary')
  assert.equal(tasks.filter((task) => task.kind === 'review-summary').length, 1)
  assert.deepEqual([...filesIn(tasks)].sort(), [...changedFiles].sort())
})

test('buildTaskGraph rebalances chunking so a large group never drops files', async () => {
  const { buildTaskGraph, MAX_TASKS } = await loadPlanner({ maxTasks: 4 })
  const changedFiles = Array.from({ length: 20 }, (_, index) => `src/module-${index}.js`)

  const tasks = buildTaskGraph({ changedFiles })

  assert.ok(tasks.length <= MAX_TASKS, `expected <= ${MAX_TASKS} tasks, got ${tasks.length}`)
  assert.equal(tasks[tasks.length - 1].kind, 'review-summary')
  // Every one of the 20 source files must still be covered by some task.
  assert.equal(filesIn(tasks).size, changedFiles.length)
  assert.deepEqual([...filesIn(tasks)].sort(), [...changedFiles].sort())
})

test('buildTaskGraph fails closed when maxTasks cannot fit every group', async () => {
  const { buildTaskGraph } = await loadPlanner({ maxTasks: 4 })
  const changedFiles = ['src/a.js', 'tests/a.test.js', 'settings.yaml', 'docs/guide.md']

  // Four distinct groups plus a mandatory review summary cannot fit maxTasks=4;
  // the planner must abort rather than silently truncate the plan.
  assert.throws(() => buildTaskGraph({ changedFiles }), /maxTasks=4 is too small/u)
})

test('distributeTaskSlots gives every group at least one slot within budget', async () => {
  const { distributeTaskSlots } = await loadPlanner({})
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
