# Dakar roadmap

This roadmap translates [`docs/dakar-review-design.md`](dakar-review-design.md)
into an outcome-oriented delivery sequence. It does not promise dates. Each
phase carries one testable idea at the GIST level: phases are ideas, steps are
workstreams that validate or falsify those ideas, and tasks are concrete
execution units.

The roadmap covers the ODW review workflow, installable CLI, review-history
state, AGENTS-aware prompting, telemetry, cost attribution, and the boundary
between Dakar and deterministic linting. The initial design record remains in
[`docs/design/initial-workflow.md`](design/initial-workflow.md); the current
architecture source is [`docs/dakar-review-design.md`](dakar-review-design.md).

## 1. Foundational correctness and operating contract

Idea: if Dakar makes its review range, configuration, recording, and CLI
contracts boringly deterministic first, later routing and cost experiments can
be evaluated without wondering whether the workflow reviewed the wrong thing.

This phase strengthens the existing first-pass workflow so every run has a
trustworthy range, policy, output channel, and record outcome.

### 1.1. Close correctness gaps found by the first self-review

This step answers whether Dakar can act on its own high-signal review findings
without changing the public workflow contract. See
`docs/dakar-review-design.md` §§6-7 and §§11-12.

- [x] 1.1.1. Quote user-controlled refs and paths in generated helper
  commands.
  - Success: `BASE_REF`, `HEAD_REF`, paths, and optional state-root arguments
    enter generated shell commands only through quoting helpers.
  - See `docs/dakar-review-design.md` §12.
- [x] 1.1.2. Reject missing explicit CodeRabbit config paths before review.
  - Success: a typo in `--config` fails with a structured CLI or config-phase
    error and does not launch review agents.
  - See `docs/dakar-review-design.md` §6.
- [x] 1.1.3. Treat verifier candidate ids as untrusted data.
  - Success: stale or mistyped verifier ids become auditable discards rather
    than workflow crashes.
  - See `docs/dakar-review-design.md` §§5 and 11.
- [x] 1.1.4. Reject missing value-bearing helper options.
  - Success: `review-state.mjs prepare --base` fails before computing a range.
  - See `docs/dakar-review-design.md` §12.

### 1.2. Make review-history recording recoverable

This step answers whether a useful review can survive a failed ODW record
agent without re-reviewing the same commits. See
`docs/dakar-review-design.md` §7.

- [x] 1.2.1. Return `recordInput` and `stage: "record"` on workflow record
  failure.
  - Requires 1.1.3.
  - Success: failed record phases include enough data to retry deterministically.
- [x] 1.2.2. Add CLI record recovery for completed reviews.
  - Requires 1.2.1.
  - Success: `dakar-review` can repair a failed workflow record phase once and
    marks `recorded.recoveredBy`.
- [x] 1.2.3. Cover record recovery in the CLI contract tests.
  - Requires 1.2.2.
  - Success: a fake ODW result with `recorded.ok: false` produces a real
    `reviews.toml` entry.

### 1.3. Preserve stable automation channels

This step answers whether interactive telemetry can coexist with parsable
automation output. See `docs/dakar-review-design.md` §10.

- [x] 1.3.1. Keep stdout reserved for final JSON or Markdown.
  - Success: quiet and telemetry CLI modes both leave stdout parseable.
- [x] 1.3.2. Route live ODW progress, run ids, and recovery warnings to stderr.
  - Requires 1.3.1.
  - Success: agents can watch progress without corrupting JSON consumers.
- [x] 1.3.3. Exercise quiet and telemetry modes in one focused CLI test suite.
  - Requires 1.3.1 and 1.3.2.
  - Success: both modes pass with isolated ODW runs roots.

## 2. Vertical slice: Repository-aware review context

Idea: if Dakar includes repository-local instructions without letting them
override workflow safety, the review can respect project conventions while
still producing stable machine-readable output.

This phase makes root `AGENTS.md` an explicit review input and prepares the
path for path-scoped instruction handling.

### 2.1. Load and bound root AGENTS.md context

This step answers whether repository-local instructions improve review
specificity without creating an unbounded prompt or output contract risk. See
`docs/dakar-review-design.md` §6.

- [x] 2.1.1. Load root `AGENTS.md` in the CLI and pass it as workflow args.
  - Success: dry-run output reports whether agent instructions were included.
- [x] 2.1.2. Bound the prompt size of repository instructions.
  - Requires 2.1.1.
  - Success: oversized instruction files are truncated and marked as truncated
    in the workflow context.
- [x] 2.1.3. Add repository `AGENTS.md` guidance for Dakar contributors.
  - Requires 2.1.1.
  - Success: future agents know to prioritize semantic review findings over
    deterministic lint issues.

### 2.2. Apply instructions without weakening Dakar rules

This step answers how Dakar should resolve conflicts between repository
instructions and workflow safety rules. See `docs/dakar-review-design.md` §6.

- [x] 2.2.1. Add prompt language that gives Dakar schema and safety rules
  precedence over `AGENTS.md`.
  - Requires 2.1.1.
  - Success: finder, verifier, and synthesis prompts share the same precedence
    statement.
- [x] 2.2.2. Add a fixture that proves `AGENTS.md` reaches dry-run or prompt
  construction.
  - Requires 2.2.1.
  - Success: tests fail if CLI stops passing repository instructions.

### 2.3. Design path-scoped instruction support

This step answers whether root-only instructions are enough for v1 or whether
path-scoped instruction discovery must land before wider adoption. See
`docs/dakar-review-design.md` §§6 and 9.

- [ ] 2.3.1. Specify instruction discovery and precedence for nested
  `AGENTS.md` files.
  - Requires 2.2.1.
  - Success: the design defines which instruction files apply to each changed
    path and how conflicts are reported.
- [ ] 2.3.2. Prototype task-level instruction packs.
  - Requires 2.3.1.
  - Success: source, tests, docs, and config tasks can receive only the
    instruction text relevant to their files.

## 3. Vertical slice: Useful semantic review over lint replay

Idea: if Dakar explicitly optimizes for findings that deterministic tools do
not catch, review quality should improve even when the number of accepted
findings decreases.

This phase shifts candidate generation, verification, and synthesis away from
style noise and towards issues that change behaviour, security, orchestration,
or state.

### 3.1. Classify deterministic findings before synthesis

This step answers whether Dakar can recognize policy findings that belong in
`odw-lint` without hiding real semantic defects. See
`docs/dakar-review-design.md` §§2 and 9.

- [ ] 3.1.1. Add a candidate field for `deterministicToolCandidate`.
  - Success: finder agents can mark findings that should become lint rules
    rather than review blockers.
- [ ] 3.1.2. Teach the verifier to downgrade deterministic-only candidates
  when no configured gate owns them.
  - Requires 3.1.1.
  - Success: deterministic issues can be reported as gaps without crowding out
    semantic defects.
- [ ] 3.1.3. Record deterministic-gap counts in metrics.
  - Requires 3.1.2.
  - Success: runs show how much Dakar is compensating for missing lint.

### 3.2. Improve finding usefulness for implementation agents

This step answers what information an implementation agent needs to fix a
review finding without relitigating the review. See
`docs/dakar-review-design.md` §9.

- [ ] 3.2.1. Add a `fixHint` or `nextAction` field to accepted findings.
  - Requires 3.1.1.
  - Success: each accepted finding says what concrete change should be made.
- [ ] 3.2.2. Require verifiers to cite the command or source evidence checked.
  - Success: accepted findings include enough evidence for a follow-up agent to
    verify before editing.
- [ ] 3.2.3. Add synthesis rules that cap low-severity policy findings.
  - Requires 3.1.2.
  - Success: reports stay focused when semantic and deterministic findings
    appear in the same run.

### 3.3. Add evaluation fixtures from real self-review output

This step answers whether prompt changes improve the current noisy cases. See
`docs/dakar-review-design.md` §§8-9.

- [ ] 3.3.1. Convert run `20260630-005716-4a9859` into a redacted evaluation
  fixture.
  - Success: the fixture preserves candidates, verdicts, accepted findings, and
    discards without depending on local absolute paths.
- [ ] 3.3.2. Score future synthesis changes against the fixture.
  - Requires 3.3.1.
  - Success: regressions in false-positive discard or semantic prioritization
    are visible before live agent spend.

## 4. Vertical slice: Telemetry and cost recovery

Idea: if Dakar records per-agent usage, output, and value metrics, routing can
be optimized against cost per useful finding rather than anecdotes about model
quality.

This phase turns ODW telemetry and workflow metrics into a review ledger that
can compare Dakar with the USD 0.25 per-file CodeRabbit target.

### 4.1. Define and persist the review ledger

This step answers what data must exist for per-agent cost attribution. See
`docs/dakar-review-design.md` §8.

- [ ] 4.1.1. Add a versioned `agentCalls` metrics array to workflow output.
  - Success: each agent call has run id, phase, label, task id, task kind,
    adapter, model, reasoning, file count, and attempt count.
- [ ] 4.1.2. Store prompt-size and context-size estimates per agent call.
  - Requires 4.1.1.
  - Success: runs can estimate prefix-cache opportunities even before adapters
    expose token usage.
- [ ] 4.1.3. Persist ledger summaries into `reviews.toml` metrics JSON.
  - Requires 4.1.1.
  - Success: historical review entries retain cost and routing evidence.

### 4.2. Integrate adapter-reported token usage when available

This step answers whether Dakar can distinguish estimated tokens from real
provider usage. See `docs/dakar-review-design.md` §8.

- [ ] 4.2.1. Inspect ODW adapter outputs for token usage fields.
  - Requires 4.1.1.
  - Success: the design records which adapters expose input, cached input,
    output, and total token counts.
- [ ] 4.2.2. Extend ODW events or result metadata to capture per-agent usage.
  - Requires 4.2.1.
  - Success: `status.json` total `spentTokens` can be reconciled with
    per-agent ledger rows.
- [ ] 4.2.3. Mark estimated and provider-reported token fields separately.
  - Requires 4.2.2.
  - Success: dashboards and reports never mix estimates with billed usage.

### 4.3. Compute cost and value metrics

This step answers whether Dakar is getting cheaper or more useful as routing
changes. See `docs/dakar-review-design.md` §§8-9.

- [ ] 4.3.1. Add a versioned local pricing table.
  - Requires 4.2.3.
  - Success: cost estimates record the pricing table version used.
- [ ] 4.3.2. Compute cost per changed file, candidate, accepted finding, and
  semantic accepted finding.
  - Requires 4.3.1 and 3.1.3.
  - Success: run metrics can compare against the USD 0.25 per-file target.
- [ ] 4.3.3. Add budget warnings for expensive routes.
  - Requires 4.3.2.
  - Success: synthesis reports when verifier fan-out or low-value task types
    dominate spend.

## 5. Vertical slice: Compile the ODW workflow from typed modules

Idea: if Dakar keeps typed source modules and compiles them into one checked,
committed ODW artefact, maintainability can improve without adding runtime
module or child-workflow boundaries.

This phase addresses the valid module-size concern from self-review while
preserving the installed workflow, CLI, state, and result contracts.

### 5.1. Adopt the source-to-artefact boundary

This step establishes the architectural and compiler contracts before moving
behaviour. See `docs/dakar-review-design.md` §4 and ADR 001.

- [x] 5.1.1. Accept the TypeScript source and generated ODW artefact decision.
  - Success: ADR 001 and the companion designs agree on source ownership,
    module boundaries, rejected alternatives, and compatibility invariants.
- [x] 5.1.2. Add the fail-closed compiler, TypeScript restriction, and freshness
  gates without behavioural decomposition.
  - Requires 5.1.1.
  - Success: a mechanically equivalent `workflows/dakar-review.js` is generated
    deterministically and passes existing dry-run and CLI tests.

### 5.2. Extract directly testable workflow components

This step moves existing contracts behind typed module boundaries without
changing review behaviour. See `docs/design/initial-workflow.md` and the
approved ExecPlan.

- [x] 5.2.1. Extract types, schemas, configuration, model routing, task
  planning, and candidate processing with direct module tests.
  - Requires 5.1.2.
  - Success: helper tests import source modules instead of slicing generated
    workflow text, and dry-run schemas and routing remain unchanged.
- [x] 5.2.2. Extract prompt construction and reduce `main.ts` to orchestration.
  - Requires 5.2.1.
  - Success: resolved policy, AGENTS context, shell quoting, candidate
    containment, phase order, metrics, and record recovery remain unchanged.

### 5.3. Validate generated workflow parity end to end

This step proves that the source split preserves the workflow users run. See
`docs/dakar-review-design.md` §12.

- [x] 5.3.1. Run compile-time, module, freshness, dry-run, and CLI contract
  checks against the generated workflow.
  - Requires 5.2.2.
  - Success: type restrictions, compiler negative probes, deterministic builds,
    output schemas, telemetry mode, record recovery, and AGENTS-aware context
    all pass their documented gates.
- [x] 5.3.2. Run one isolated live review and repeat it at the recorded head.
  - Requires 5.3.1.
  - Success: the workflow prepares, reviews, verifies, synthesizes, records the
    reviewed head under isolated XDG state, and the second run returns
    `skipped: true` without duplicate history.

## 6. Deferred extensions after the core v1 promise

Idea: if the core review loop is trustworthy and measurable, broader
extensions can be evaluated on product value rather than added to compensate
for missing fundamentals.

### 6.1. Static-analysis and codegraph ingestion

- [ ] 6.1.1. Ingest SARIF as candidate evidence rather than final findings.
  - Requires phase 3.
  - See `docs/dakar-review-design.md` §§2 and 9.
- [ ] 6.1.2. Add `sem`, `leta`, and codegraph context packs to task planning.
  - Requires 6.1.1.
  - See `docs/design/initial-workflow.md` research summary.

### 6.2. Path-scoped repository instructions

- [ ] 6.2.1. Implement nested `AGENTS.md` discovery once root instructions are
  stable.
  - Requires 2.3.1.
  - See `docs/dakar-review-design.md` §6.

### 6.3. Review-result publication

- [ ] 6.3.1. Evaluate GitHub pull request comment publishing.
  - Requires phases 3 and 4.
  - Success: publication preserves the structured result and discard audit
    rather than posting unverified candidate noise.

## 7. Deterministic-tiered review cost (ADR 002)

Idea: if deterministic host code owns every derivable decision and the two
Flex-tier model lanes are admitted against a hard budget, an ordinary review
becomes provably affordable — mean at or below £0.05, hard ceiling £0.10 —
without losing high-severity recall (an acceptance target that task 7.5.3
evaluates).

This phase implements
[ADR 002](adr-002-deterministic-tiered-review-cost.md). It supersedes the
USD 0.25 per-file benchmark used by phase 4 with ADR 002's per-review targets
(`targetCostPerReviewGbp = 0.11`); the phase 4 ledger and pricing-table tasks
become prerequisites rather than parallel work. The immediate delivery goal is
a minimally useful live review below USD 0.25 of provider spend, with a
stretch goal below USD 0.11.

### 7.1. Pricing table, cost ledger, and admission control

This step answers whether Dakar can bound worst-case review cost before any
model call is dispatched. Subsumes 4.3.1. See ADR 002 §"Cost budget and
admission control".

- [x] 7.1.1. Land the versioned pricing table with a foreign-exchange
  snapshot.
  - Success: cost estimates record the pricing-table version and FX snapshot;
    rates cover Luna and Terra, standard and Flex, all four token bands.
- [x] 7.1.2. Add the per-call cost ledger with estimated and reported usage.
  - Requires 7.1.1.
  - Success: every model call records model, service tier, reasoning effort,
    estimated worst-case cost, and provider-reported token usage separately.
- [x] 7.1.3. Add the admission controller with the hard ordinary-review
  budget.
  - Requires 7.1.2.
  - Success: the required audit is reserved first, and an optional call whose
    worst-case estimate breaches the remaining budget is refused with a
    structured reason.

### 7.2. Deterministic host takeover of agent-wrapped phases

This step answers whether removing model mediation from derivable phases
preserves the workflow contract while eliminating their spend. See ADR 002
§"Deterministic host boundary" and migration step 2.

- [x] 7.2.1. Call config resolution and range preparation in-process from the
  workflow host.
  - Success: `Resolve Config` and `Prepare` launch no agent; failure modes
    keep their structured `stage` semantics.
- [x] 7.2.2. Render the final report deterministically from accepted
  findings.
  - Success: the synthesis agent call is removed; rendering is byte-stable
    for the same consolidated input.
- [x] 7.2.3. Record review history in-process with the existing lock and
  validation invariants.
  - Success: the record agent loop is removed; the reviewed-head invariant
    and CLI recovery contract still hold.

### 7.3. Flex lanes: Luna transactions and the Terra issue-set audit

This step answers whether one bounded audit can replace per-candidate
verification without material recall loss. See ADR 002 §"Luna Flex
transactional boundary", §"Terra Flex boundary", and §"Flex scheduling and
failure policy".

- [x] 7.3.1. Replace per-candidate verification with deterministic compaction
  and one issue-set audit on the existing standard-tier adapters.
  - Requires 7.2.
  - Success: the verify fan-out is removed; the audit deduplicates,
    consolidates causes, and may state that no actionable issue remains;
    the audit quality bet is validated in isolation from Flex plumbing.
- [x] 7.3.2. Add `pi-luna-flex` and `pi-terra-flex` adapters with contract
  tests.
  - Requires 7.1.1.
  - Success: the provider request contains `service_tier = "flex"` and the
    pinned per-lane reasoning effort for both adapters (Codex CLI cannot
    send the tier; see the ADR 002 amendment of 2026-07-18).
- [x] 7.3.3. Route finder tasks to bounded Luna Flex transactions and the
  audit to Terra Flex.
  - Requires 7.3.1 and 7.3.2.
  - Success: no ordinary review launches more than `maxLunaFlexCalls`
    transactions, each within the configured file and token bounds, and the
    audit reservation precedes any Luna dispatch.
- [x] 7.3.4. Handle Flex resource unavailability with bounded backoff and
  deferral.
  - Requires 7.3.2.
  - Success: HTTP 429 `resource_unavailable` retries with backoff and jitter,
    never silently uses standard processing, and an exhausted required audit
    leaves the head unrecorded as completely reviewed.

### 7.4. Live cost validation on the estate corpus

This step answers whether the implemented route meets the delivery goal on
real branches. See ADR 002 §"Verification".

- [x] 7.4.1. Build the candidate-branch harness for API-key live runs.
  - Requires 7.2 and 7.3.
  - Success: selected estate pull requests of varying sizes can be reviewed
    from clean clones with isolated review state and captured cost ledgers.
- [x] 7.4.2. Measure and record per-review provider cost against the targets.
  - Requires 7.4.1.
  - Success: an ordinary review completes with useful findings below USD 0.25
    provider spend; results record whether the USD 0.11 stretch was met.

### 7.5. Deferred ADR 002 completions

- [ ] 7.5.1. Adopt SARIF 2.1.0 as the canonical findings envelope.
  - Requires 7.3.3.
  - See ADR 002 §"Findings and hand-off format" and roadmap 6.1.1.
- [ ] 7.5.2. Run configured deterministic gates with short-circuit before
  semantic review.
  - Requires 7.2.1.
  - See ADR 002 §"Deterministic gate short-circuit".
- [ ] 7.5.3. Compare legacy and deterministic-flex routes on adjudicated
  fixtures.
  - Requires 7.4.2 and 3.3.1.
  - Success: the acceptance criteria in ADR 002 §"Verification" hold. The
    deterministic-flex route is already the sole live route in this
    repository: ADR 002's staged default-cutover guideline (migration step
    10) was superseded by the recorded decision in the Decision Log of
    `docs/execplans/api-key-support.md`, so this comparison validates
    review quality retrospectively against the `legacy-route-final` tag
    rather than gating a default flip.
- [ ] 7.5.4. Add a knob permitting partial-coverage reviews to record their
  head explicitly.
  - Requires 7.4.2.
  - Success: recording now requires complete planned finder coverage (zero
    truncated files, zero admission refusals, zero downgrades — the
    operator-directed tightening of 2026-07-19); a future opt-in knob (for
    example `allowPartialCoverageRecord`) would let an operator accept the
    coverage gap deliberately, with the partial-coverage evidence preserved
    in the recorded metrics. The earlier downgrade-and-continue recording
    design is retained in history for context.

### 7.6. Gate adoption in df12-build

This step answers whether Dakar can serve as the default host review gate in
the df12-build workshop, replacing the CodeRabbit CLI and its pinned NDJSON
wire contract. Live df12-build traffic then doubles as the comparison corpus
7.5.3 needs.

- [x] 7.6.1. Expose the budget and coverage knobs as `dakar-review` CLI
  flags.
  - Requires 7.4.2.
  - Success: a gate invocation can raise `--budget-gbp` and the pack and
    audit limits so large task branches are reviewed without admission
    refusals.
- [ ] 7.6.2. Add a Dakar review mode to df12-build's host review, defaulting
  to Dakar with CodeRabbit retained behind configuration.
  - Requires 7.6.1.
  - Success: outcome, severity, and findings-sink mappings preserve the
    existing control-loop contract; deferral maps to the rate-limited
    backoff path; the df12-build pull request lands with its gates green.
