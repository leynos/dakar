/** @file Execute the compiled Dakar workflow with faithful local ODW primitive mocks. */

import { readFile } from 'node:fs/promises'

import { buildAgentMock, FixtureFailure } from './mock-agents.mjs'

const WORKFLOW_URL = new URL('../../workflows/dakar-review.js', import.meta.url)

/**
 * Load and compile the generated workflow using ODW's injected-primitive order.
 *
 * @returns {Promise<AsyncFunction>} The reusable compiled workflow body.
 */
async function loadWorkflowBody() {
  let source = await readFile(WORKFLOW_URL, 'utf8')
  source = source.replace(/^export const meta\s*=/mu, 'const meta =')
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
  return new AsyncFunction(
    'agent',
    'parallel',
    'pipeline',
    'phase',
    'log',
    'args',
    'budget',
    'workflow',
    'validate',
    'sleep',
    source,
  )
}

/**
 * Reproduce ODW's null-slot result for fixture failures without hiding harness
 * defects or unexpected exceptions.
 *
 * @param {unknown} error The error rejected by a simulated primitive.
 * @returns {null} The failed parallel or pipeline slot.
 * @throws {unknown} Any error that is not an intentional fixture failure.
 */
function nullOnFixtureFailure(error) {
  if (error instanceof FixtureFailure) return null
  throw error
}

/**
 * Execute the compiled workflow against scripted agent responders.
 *
 * The parallel and pipeline mocks preserve ODW's null-slot failure semantics.
 * `nullParallelSlots` additionally simulates a scheduler-aborted thunk whose
 * own retry code never completes. All inputs and captures are local; this
 * helper never starts ODW, pi, or a provider.
 *
 * @param {object} options Simulation controls and fixture state.
 * @param {Array<object>} options.responders Ordered mock-agent responders.
 * @param {object} options.prepared Host-prepared review range and gate results.
 * @param {object} [options.args] Workflow arguments outside tuning knobs.
 * @param {object} [options.knobs] Workflow tuning arguments merged last.
 * @param {Array<object>} [options.agentCalls] Mutable agent-call capture.
 * @param {number[]} [options.sleepDelays] Mutable retry-delay capture.
 * @param {number[]} [options.nullParallelSlots] Parallel slots forced to null.
 * @returns {Promise<object>} The result and deterministic harness captures.
 */
export async function runCompiledWorkflow({
  responders,
  prepared,
  args = {},
  knobs = {},
  agentCalls = [],
  sleepDelays = [],
  nullParallelSlots = [],
}) {
  const body = await loadWorkflowBody()
  const prompts = new Map()
  const agentLabels = []
  const phases = []
  const logs = []
  const agent = buildAgentMock(responders, { prompts, agentLabels, agentCalls })
  const parallel = (thunks) =>
    Promise.all(
      thunks.map((thunk, index) =>
        nullParallelSlots.includes(index)
          ? Promise.resolve(null)
          : Promise.resolve().then(thunk).catch(nullOnFixtureFailure),
      ),
    )
  const pipeline = (items, ...stages) =>
    Promise.all(
      items.map(async (item, index) => {
        try {
          let value = item
          for (const stage of stages) value = await stage(value, item, index)
          return value
        } catch (error) {
          return nullOnFixtureFailure(error)
        }
      }),
    )
  const result = await body(
    agent,
    parallel,
    pipeline,
    (name) => phases.push(name),
    (message) => logs.push(message),
    { ...args, prepared, ...knobs },
    { total: null, spent: () => 0, remaining: () => 0 },
    async () => null,
    () => ({ ok: true, meta: null, errors: [], warnings: [] }),
    async (milliseconds) => {
      sleepDelays.push(milliseconds)
    },
  )
  return { agentLabels, agentCalls, logs, phases, prompts, result, sleepDelays }
}
