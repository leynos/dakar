/**
 * @file Pin the wiring that makes the commit gates run in CI.
 *
 * `tests/makefile-docs-gate.test.mjs` proves `make check` reaches the
 * documentation gate without ignoring its exit status, and
 * `tests/docs-gate.test.mjs` proves the gate decides. Neither notices if CI
 * stops invoking `make check` at all, which is the last link in the chain and
 * the easiest one to sever by accident.
 *
 * The assertions parse the workflow rather than searching its text, because a
 * gate can be disarmed without touching the command. Each one kills a distinct
 * mutation, verified on 2026-09-07:
 *
 * - `if: false` on the step, or any condition at all such as a push-only one,
 *   skips the command with the run value untouched. Falsy spellings are not
 *   enumerated; YAML parses `false` to a boolean, and the assertion is that the
 *   key is absent, which rejects every condition including a plausible one.
 * - `if: false` on the job skips every step in it.
 * - Wrapping the command as `if false; then make check; fi` leaves a step whose
 *   run value contains the command but runs nothing, so the whole run value
 *   must be the command rather than merely contain it.
 * - Changing the command, renaming the job, or removing the `pull_request`
 *   trigger each break a separate assertion.
 *
 * @module
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WORKFLOW_PATH = join(REPO_ROOT, '.github', 'workflows', 'ci.yml')
const workflow = load(readFileSync(WORKFLOW_PATH, 'utf8'))

/** The job that runs the repository's commit gates. */
const GATE_JOB = 'spelling-and-diagrams'
/** The command whose exit status is the gate. */
const GATE_COMMAND = 'make check'

/**
 * Find the steps of the gate job whose entire `run` value is one command.
 *
 * Equality rather than containment is the point: a step reading
 * `if false; then make check; fi` contains the command and runs nothing.
 *
 * @param {string} command - command the step must run and nothing else.
 * @returns {object[]} every matching step, so a case can assert there is one.
 */
function stepsRunning(command) {
  const steps = workflow?.jobs?.[GATE_JOB]?.steps ?? []
  return steps.filter((step) => typeof step.run === 'string' && step.run.trim() === command)
}

test('the workflow triggers on pull requests', () => {
  assert.ok(workflow?.on, `${WORKFLOW_PATH} has no trigger block`)
  assert.ok('pull_request' in workflow.on, 'CI must run on pull requests')
})

test('the gate job exists and carries no condition', () => {
  const job = workflow?.jobs?.[GATE_JOB]

  assert.ok(job, `${WORKFLOW_PATH} has no ${GATE_JOB} job`)
  // A condition on the job skips every step in it, leaving each run value
  // intact and every other assertion here satisfied.
  assert.ok(!('if' in job), 'the gate job must run unconditionally')
})

test('one unconditional step runs the commit gates and nothing else', () => {
  const matches = stepsRunning(GATE_COMMAND)

  assert.equal(matches.length, 1, `expected exactly one step whose run value is "${GATE_COMMAND}"`)
  assert.ok(!('if' in matches[0]), 'the gate step must run unconditionally')
})
