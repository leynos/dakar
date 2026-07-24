/** @file Execute the compiled Dakar workflow with faithful local ODW primitive mocks. */

import { readFile } from 'node:fs/promises'

import { FixtureFailure } from './mock-agents.mjs'

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
 * Execute the compiled workflow with caller-supplied deterministic primitives.
 *
 * The parallel and pipeline mocks preserve ODW's null-slot failure semantics.
 * `nullParallelSlots` additionally simulates a scheduler-aborted thunk whose
 * own retry code never completes. Defaults are local and deterministic; this
 * helper never starts ODW, pi, or a provider.
 *
 * @param {object} options Simulation controls and fixture state.
 * @param {Function} options.agent Caller-supplied deterministic agent mock.
 * @param {object} [options.args] Complete workflow argument object.
 * @param {object} [options.budget] Injected budget primitive.
 * @param {Function} [options.workflow] Injected nested-workflow primitive.
 * @param {Function} [options.validate] Injected validation primitive.
 * @param {Function} [options.phase] Optional phase hook replacing collection.
 * @param {Function} [options.log] Optional log hook replacing collection.
 * @param {Function} [options.sleep] Optional sleep hook replacing collection.
 * @param {string[]} [options.phases] Mutable phase-name capture.
 * @param {string[]} [options.logs] Mutable log-message capture.
 * @param {Array<object>} [options.agentCalls] Mutable agent-call capture.
 * @param {number[]} [options.sleepDelays] Mutable retry-delay capture.
 * @param {number[]} [options.nullParallelSlots] Parallel slots forced to null.
 * @returns {Promise<object>} The result and deterministic harness captures.
 */
export async function runCompiledWorkflow({
  agent,
  args = {},
  budget = { total: null, spent: () => 0, remaining: () => 0 },
  workflow = async () => null,
  validate = () => ({ ok: true, meta: null, errors: [], warnings: [] }),
  phase,
  log,
  sleep,
  phases = [],
  logs = [],
  agentCalls = [],
  sleepDelays = [],
  nullParallelSlots = [],
}) {
  const body = await loadWorkflowBody()
  const recordingAgent = async (prompt, options = {}) => {
    agentCalls.push({
      label: options.label,
      adapter: options.adapter,
      model: options.model,
      phase: options.phase,
    })
    return agent(prompt, options)
  }
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
    recordingAgent,
    parallel,
    pipeline,
    phase || ((name) => phases.push(name)),
    log || ((message) => logs.push(message)),
    args,
    budget,
    workflow,
    validate,
    sleep || (async (milliseconds) => {
      sleepDelays.push(milliseconds)
    }),
  )
  return { agentCalls, logs, phases, result, sleepDelays }
}
