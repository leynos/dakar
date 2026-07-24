/** @file Declarative responder registry for the workflow-orchestration test harness.
 *
 * Replaces a label-keyed if-chain with an ordered list of `{ match, respond }`
 * entries, so fixture behaviour lives in data rather than control flow. Later
 * milestones can edit or extend the responder list without touching the
 * dispatch logic below.
 */

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
 * Extract the changed files a finder pack prompt was scoped to.
 *
 * Finder prompts embed a `Changed files for this task: a, b` line. Keeping this
 * shape knowledge here means a finder-prompt change only needs an edit in one
 * place. Returns an empty array for the `(no changed files)` sentinel.
 */
export function extractTaskFiles(prompt) {
  const line = prompt.split('Changed files for this task: ')[1]?.split('\n')[0] ?? ''
  if (line === '' || line === '(no changed files)') return []
  return line.split(', ')
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
export function buildAgentMock(responders, { prompts, agentLabels, agentCalls }) {
  return async (prompt, options = {}) => {
    agentLabels.push(options.label)
    if (agentCalls) {
      agentCalls.push({ label: options.label, adapter: options.adapter, model: options.model, phase: options.phase })
    }
    // The Flex retry helper reissues the same label on each attempt, so a
    // repeated label is expected. `agentCalls` records attempt order and count;
    // `prompts` keeps the last prompt seen for a label (a retry reuses the same
    // durable input, so this loses nothing the assertions need).
    prompts.set(options.label, prompt)
    for (const { match, respond } of responders) {
      const matches = typeof match === 'string' ? match === options.label : match(options.label)
      if (matches) return respond(prompt, options)
    }
    throw new Error(`unexpected agent label: ${options.label}`)
  }
}
