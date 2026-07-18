/** @file Declarative responder registry for the workflow-orchestration test harness.
 *
 * Replaces a label-keyed if-chain with an ordered list of `{ match, respond }`
 * entries, so fixture behaviour lives in data rather than control flow. Later
 * milestones can edit or extend the responder list without touching the
 * dispatch logic below.
 */

import assert from 'node:assert/strict'

/** Thrown by fixture responders to simulate a rejected agent call. */
export class FixtureFailure extends Error {}

/**
 * Extract the candidate JSON embedded in a verify-stage prompt.
 *
 * Verify prompts embed a `Candidate JSON:` block terminated by a blank line
 * and a `Repository root:` marker. This is the one place that understands
 * that shape, so a future prompt change only needs an edit here.
 */
export function extractCandidateJson(prompt) {
  const candidateJson = prompt.split('Candidate JSON:\n')[1].split('\n\nRepository root:')[0]
  return JSON.parse(candidateJson)
}

/**
 * Extract the compacted candidate array embedded in an issue-set audit prompt.
 *
 * Audit prompts embed a `Candidate findings JSON:` block (a JSON array of the
 * compacted candidates) terminated by a blank line and a `Changed files:`
 * marker. Keeping this shape knowledge in one place means a future audit prompt
 * change only needs an edit here.
 */
export function extractAuditCandidates(prompt) {
  const auditJson = prompt.split('Candidate findings JSON:\n')[1].split('\n\nChanged files:')[0]
  return JSON.parse(auditJson)
}

/**
 * Build the `agent()` mock consumed by the compiled workflow body.
 *
 * `responders` is an ordered list of `{ match, respond }` entries evaluated
 * top to bottom; `match` is either an exact label string or a predicate
 * `(label) => boolean`, and `respond(prompt, options)` returns the fixture
 * response, or throws `FixtureFailure` to simulate a rejected call. The
 * first matching responder wins; an unmatched label is a harness bug and
 * throws immediately.
 *
 * `prompts` and `agentLabels` are the caller's shared capture collections,
 * kept here so every mock enforces the same duplicate-label assertion and
 * recording order regardless of which milestone's fixtures are in play.
 */
export function buildAgentMock(responders, { prompts, agentLabels }) {
  return async (prompt, options = {}) => {
    agentLabels.push(options.label)
    assert.equal(prompts.has(options.label), false, `duplicate agent label: ${options.label}`)
    prompts.set(options.label, prompt)
    for (const { match, respond } of responders) {
      const matches = typeof match === 'string' ? match === options.label : match(options.label)
      if (matches) return respond(prompt, options)
    }
    throw new Error(`unexpected agent label: ${options.label}`)
  }
}
