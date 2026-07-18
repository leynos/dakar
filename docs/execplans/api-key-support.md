# Implement the ADR 002 deterministic-tiered review route

This ExecPlan (execution plan) is a living document. The sections
`Constraints`, `Tolerances`, `Risks`, `Progress`, `Surprises & Discoveries`,
`Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work
proceeds.

Status: DRAFT

## Purpose / big picture

After this change, running `dakar-review` on a real branch produces a useful
semantic code review whose measured provider spend is below USD 0.25, with a
stretch goal below USD 0.11. Today one review can launch agents for
configuration resolution, range preparation, up to eight finder tasks, up to
thirty per-candidate verifications, synthesis rendering, and history
recording, with no cost ceiling at all. This plan implements the vertical
slice of [ADR 002](../adr-002-deterministic-tiered-review-cost.md) (roadmap
steps 7.1 through 7.4): deterministic host code absorbs every derivable
phase, the remaining model work routes to two OpenAI Flex-tier lanes
(`gpt-5.6-luna` for bounded finder transactions, `gpt-5.6-terra` for one
issue-set audit), and an admission controller enforces a hard per-review
budget before any call is dispatched.

Success is observable: a live review of a selected estate pull request
completes end to end, the result carries a per-call cost ledger with
provider-reported token usage, and the ledger total is below the target.

## Constraints

- The compiled-artefact contract from ADR 001 holds throughout:
  `workflows/dakar-review.js` is generated, never hand-edited; source lives
  in `src/workflows/dakar-review/` in erasable-syntax TypeScript with
  explicit `.ts` sibling imports, ambient (never imported) Open Dynamic
  Workflows (ODW) primitives, an acyclic ESM module graph, and no runtime
  dependencies. `make workflow-freshness` must pass on every commit.
- The CLI stdout contract holds: stdout carries only the final JSON or
  Markdown result; progress, telemetry, and warnings go to stderr.
- The review-state invariant holds: a review reported as recorded must
  prevent later `prepare` calls from re-including the recorded head's
  ancestors, and a review whose required audit was not completed must leave
  the head unrecorded.
- The CodeRabbit-style configuration precedence order documented in
  `docs/users-guide.md` is preserved.
- The OpenAI API key at `~/dakar-api-key.txt` must never be committed,
  echoed into logs or transcripts, or copied under the repository. It enters
  processes only via the `CODEX_API_KEY` (or, for direct API probes,
  `OPENAI_API_KEY`) environment variable read from that file at invocation
  time.
- Live provider spend during this plan is capped at USD 5.00 in total.
  Every live invocation must use the cheapest configuration that can answer
  the question being asked.
- Agents may not promote themselves to a more expensive model or service
  tier; lane selection is host code (ADR 002 decision principle).
- Prose, comments, and commit messages use en-GB Oxford English. All commit
  gates run before each commit (delegated to a scrutineer agent).

If satisfying the objective requires violating a constraint, stop, record
the conflict in `Decision Log`, and escalate.

## Tolerances (exception triggers)

- Scope: if a milestone requires net changes beyond roughly 25 files or
  2,500 lines, stop and escalate.
- Interface: if the CLI's existing flag semantics or the workflow result's
  existing top-level fields (`findings`, `discarded`, `metrics`, `recorded`)
  must change incompatibly, stop and escalate. Additive fields are within
  tolerance.
- Dependencies: if any new runtime dependency appears necessary, stop and
  escalate. New pinned dev dependencies require a Decision Log entry.
- Iterations: if a test still fails after three distinct fix attempts, stop
  and escalate.
- Spend: if cumulative live provider spend reaches USD 4.00 before milestone
  M6 completes, stop and escalate with the ledger evidence.
- Ambiguity: if the Codex CLI cannot be proven to honour
  `service_tier = "flex"` under API-key authentication (milestone M0), stop
  and present the fallback options rather than silently paying standard
  rates.

## Risks

- Risk: Codex CLI may not plumb `service_tier = "flex"` through to the
  provider when authenticated with `CODEX_API_KEY`, or may not expose
  which tier was billed.
  Severity: high. Likelihood: medium.
  Mitigation: milestone M0 proves or refutes this with one minimal paid
  probe before any implementation work depends on it. The fallback is a
  thin host-side Responses API adapter script (Node built-in `fetch`, no
  runtime dependency) registered as an ODW adapter command; ADR 002
  rejected a bespoke wrapper only "solely to select Flex", so a proven
  plumb-through failure is a documented justification.
- Risk: Flex processing latency (requests can take many minutes; the
  provider's own SDK default timeout is 10 minutes) may exceed ODW agent or
  CLI timeouts and read as failures.
  Severity: medium. Likelihood: medium.
  Mitigation: raise per-call timeouts for Flex adapters; M0 measures real
  latency on a small prompt; the workflow treats timeout as retryable.
- Risk: `gpt-5.6-luna` at low reasoning may produce too few or too shallow
  candidates for a useful review.
  Severity: medium. Likelihood: medium.
  Mitigation: the live corpus (M6) includes a pull request with known
  substantive changes; if findings are vacuous, escalate reasoning effort
  for Luna finders (still Flex) before considering Terra finders, and
  record the cost delta.
- Risk: ODW may not surface adapter token usage to the workflow result,
  leaving the ledger with estimates only.
  Severity: medium. Likelihood: medium.
  Mitigation: `codex exec --json` reports `input_tokens`,
  `cached_input_tokens`, and `output_tokens`; if ODW drops them, the
  harness parses the Codex JSON stream from the ODW run directory instead,
  and the ledger marks those rows as harness-derived. Estimated and
  reported fields are separate from the start.
- Risk: replacing per-candidate verification with one audit may admit
  false positives that the old adversarial verifier would have refuted.
  Severity: medium. Likelihood: low.
  Mitigation: the Terra audit prompt is explicitly adversarial per
  ADR 002; M6 inspects accepted findings by hand on the tiny and small
  corpus entries where ground truth is easy to establish.

## Progress

- [x] (2026-07-18 16:20Z) Reconnaissance: source map, gap analysis, design
  document digest, external facts verified (Flex contract, pricing,
  `CODEX_API_KEY` auth), candidate corpus selected.
- [x] (2026-07-18 16:30Z) Roadmap phase 7 added to `docs/roadmap.md`.
- [ ] M0: Flex plumb-through probe (go/no-go gate).
- [ ] M1: pricing table, cost ledger types, admission controller (pure
  modules with tests).
- [ ] M2: deterministic host takeover of config, prepare, render, and
  record.
- [ ] M3: Flex adapters, Luna finder lane, Terra issue-set audit.
- [ ] M4: Flex retry, backoff, and deferral policy.
- [ ] M5: contract, dry-run, and documentation updates; full gates.
- [ ] M6: live cost validation on the estate corpus.

## Surprises & discoveries

- Observation: the CLI already resolves configuration deterministically via
  `resolveReviewConfig`, yet the workflow re-resolves it through an agent
  call that shells out to the same script and echoes its JSON.
  Evidence: `bin/dakar-review.mjs:172` versus `main.ts:97-121` and
  `prompts.ts:30-37`.
  Impact: milestone M2 is partly a deletion exercise; the deterministic
  logic already exists and is already tested.
- Observation: the CLI's record-recovery path (`recoverRecordFailure`,
  `bin/dakar-review.mjs:333-368`) already calls `appendReview` directly and
  is exactly the shape ADR 002 wants as the primary path.
  Evidence: recon report on `bin/dakar-review.mjs`.
  Impact: M2 promotes an existing fallback to the main path rather than
  writing new recording logic.
- Observation: current OpenAI prices match ADR 002 Table 1 exactly, and a
  larger `gpt-5.6-sol` tier exists above Terra.
  Evidence: pricing page scrape, 2026-07-18.
  Impact: the pricing-table seed data can be committed with confidence;
  `sol` is out of scope but the table schema should not preclude it.

## Decision log

- Decision: implement ADR 002 as a vertical slice (roadmap 7.1-7.4),
  deferring SARIF envelope adoption, deterministic gate running, and the
  legacy-route comparison corpus (roadmap 7.5).
  Rationale: the delivery goal is a minimally useful live review below
  USD 0.25; the deferred items do not reduce provider spend and each is
  independently landable later. The existing JSON findings contract is
  preserved so nothing downstream breaks.
  Date/Author: 2026-07-18, planning agent.
- Decision: deterministic phases move to the CLI process, not into the ODW
  workflow body.
  Rationale: the workflow runs inside the ODW runtime with ambient
  primitives only and cannot execute host commands itself; today it fakes
  determinism by paying a model to run `scripts/review-state.mjs`. The CLI
  already imports both helper scripts. Moving prepare before `odw run` and
  record after it makes the workflow a pure model-orchestration unit and
  deletes four agent calls.
  Date/Author: 2026-07-18, planning agent.
- Decision: keep the existing candidate and verdict JSON schemas; the Terra
  audit returns one verdict per surviving candidate plus cluster
  identifiers, so `acceptedFromVerdicts` and `discardedFromVerdicts`
  continue to work.
  Rationale: minimizes contract churn and test rewrites; SARIF migration is
  deferred by the first decision above.
  Date/Author: 2026-07-18, planning agent.
- Decision: the live corpus reviews estate pull requests by cloning each
  repository into the scratchpad, checking out the PR head, and running
  `dakar-review --base <base-sha> --head <head-sha>` with an isolated
  `--state-root`.
  Rationale: exercises the real CLI path end to end without touching any
  estate repository's state or requiring push access.
  Date/Author: 2026-07-18, planning agent.
- Decision: build-cost control — mechanical module extraction, test
  scaffolding, and documentation sweeps delegate to Sonnet subagents;
  the `main.ts` orchestration redesign and the Terra audit prompt are
  authored by Opus; all commit gates run through scrutineer agents.
  Rationale: matches effort to task difficulty and keeps bulky gate output
  out of the planning context.
  Date/Author: 2026-07-18, planning agent.

## Outcomes & retrospective

To be completed at milestone boundaries and at the end of the work.

## Context and orientation

Dakar is an ODW code-review workflow plus an installable `dakar-review`
command-line interface (CLI). ODW (Open Dynamic Workflows) is a runtime that
executes a single-file JavaScript workflow which orchestrates model calls
through configurable command-line adapters. The workflow source is a
restricted TypeScript module tree under `src/workflows/dakar-review/`,
compiled by `scripts/build-workflow.mjs` into the committed artefact
`workflows/dakar-review.js` (never edit the artefact; run
`make workflow-build`).

Key files, all repository-relative:

- `bin/dakar-review.mjs` — the CLI. Parses options (`OPTION_SPECS`, lines
  22-41), resolves configuration host-side via `resolveReviewConfig`, reads
  bounded `AGENTS.md` context, invokes `odw run`, and post-processes the
  result. `recoverRecordFailure` (lines 333-368) is the existing
  deterministic record fallback.
- `scripts/review-config.mjs` — deterministic CodeRabbit-style config
  resolution with the documented precedence order.
- `scripts/review-state.mjs` — deterministic range preparation
  (`prepare`) and locked TOML history recording (`appendReview`) under the
  XDG state directory.
- `src/workflows/dakar-review/main.ts` — workflow orchestration. Current
  phases: Resolve Config (agent echoing `review-config.mjs`), Prepare
  (agent echoing `review-state.mjs prepare`), Plan (host code:
  `buildTaskGraph`), Review (parallel finder agents, up to `maxTasks` = 8),
  Verify (one agent call per candidate, up to `maxCandidates` = 30),
  Synthesize (agent renders the report), Record (up to three agent calls
  wrapping `review-state.mjs record`).
- `src/workflows/dakar-review/model-routing.ts` — roles `medium`, `high`,
  `mini`, `spark` mapped to `gpt-5.5`, `gpt-5.4-mini`,
  `gpt-5.3-codex-spark`; adapters `codex-low|medium|high`.
- `src/workflows/dakar-review/task-graph.ts`, `candidates.ts`,
  `prompts.ts`, `schemas.ts`, `types.ts`, `shell.ts`, `meta.js` — task
  planning, candidate normalization and dedup (`candidateKey`), prompt
  construction, JSON Schemas, shared types, shell quoting, and workflow
  metadata respectively.
- `odw.config.json` — three Codex CLI adapters (`codex-low|medium|high`),
  none of which set a service tier.
- `tests/` — the constraint surface. `workflow-orchestration.test.mjs`
  mocks `agent()` per phase and will need the largest rewrite;
  `review-state*` and `review-config` tests already treat the helper
  scripts as pure units and are reusable.

Verified external facts (2026-07-18):

- Flex processing: set `service_tier: "flex"` on Responses or Chat
  Completions; tokens bill at Batch rates; HTTP 429 with the
  `resource_unavailable` error code is not billed and is retryable; SDK
  default timeout is 10 minutes and should be raised for Flex.
- Pricing (USD per million tokens, short context): Luna Flex 0.50 input /
  0.05 cached / 3.00 output; Terra Flex 1.25 / 0.125 / 7.50 — matching
  ADR 002 Table 1. Both models support Flex.
- Codex CLI: `CODEX_API_KEY=<key> codex exec --json "task"` authenticates
  with a platform API key (billed to the API, not a ChatGPT subscription)
  and reports `input_tokens`, `cached_input_tokens`, and `output_tokens`.
  Configuration overrides pass per call as `-c key=value`.

The API key for live validation is at `~/dakar-api-key.txt` (outside the
repository; see Constraints).

Live-validation corpus, selected for size spread from real (non-dependabot)
changes:

| Tier | Repository and PR | Files | Diff size |
| - | - | -: | - |
| Tiny | `leynos/comenq` #140 (open) | 1 | +11/−6 |
| Small | `leynos/ddlint` #294 (merged) | 2 | +57/−29 |
| Medium | `leynos/frankie` #102 (merged) | 5 | +63/−8 |
| Upper-medium | `leynos/rstest-bdd` #593 (open) | 11 | +228/−117 |
| Large | `leynos/wireframe` #612 (merged) | 28 | +569/−99 |
| Oversize probe | `leynos/wireframe` #609 (merged) | 101 | +3,988/−176 |

Table 1: candidate pull requests for live cost validation. The oversize
probe exists to observe budget refusal or deferral, not to complete.

## Plan of work

The work is six milestones. Each ends with validation; do not proceed past a
failed validation. Red-Green-Refactor applies to every code milestone: the
project's test framework is `node --test` (run via `make test`), and each
behaviour change lands with a test that fails first for the expected reason.

### Milestone M0: Flex plumb-through probe (go/no-go, prototyping)

Prove, with minimal spend, that the intended per-call plumbing works before
any code depends on it. From the scratchpad directory (never the repo), run
one Codex CLI probe with the API key, requesting `gpt-5.6-luna`, Flex tier,
low reasoning, and a one-line prompt; capture the JSON event stream to a
scratch file. Then run one direct Responses API probe with `curl` and
`service_tier: "flex"` as the control.

Acceptance: the Codex probe completes; its usage block reports token counts;
and either (a) the response metadata or effective configuration proves the
flex tier was applied, or (b) the probe fails in a way that identifies the
gap. On (b), stop: present the direct-adapter fallback (a host script
`scripts/flex-adapter.mjs` calling the Responses API with Node's built-in
`fetch`, registered as an ODW adapter command) with its trade-offs, and
await direction. Estimated spend: well under USD 0.01 per probe.

Record measured latency for both probes in `Artefacts and notes`; these
numbers size the adapter timeouts in M3.

### Milestone M1: pricing table, ledger, and admission control

Create `src/workflows/dakar-review/pricing.ts` defining: the versioned
pricing table type (model, service tier, token-band rates in USD per
million); a seed table for Luna and Terra, standard and Flex, matching the
verified 2026-07-18 rates with `pricingTableVersion: "2026-07-18"`; a
foreign-exchange snapshot type and seed (`usdPerGbp`); and a pure
`estimateWorstCaseUsd(call)` function taking uncached input, cached input,
and maximum output token counts. Create
`src/workflows/dakar-review/admission.ts` defining the admission controller:
given the configured budget, the reserved audit estimate, and the ledger so
far, `admit(call)` returns either an admission or a structured refusal with
a reason. Extend `types.ts` with `LedgerEntry` (call id, phase, lane, model,
service tier, reasoning effort, estimated worst-case cost, reported usage —
estimated and reported fields strictly separate — and pricing-table
version).

Red first: `tests/workflow-pricing.test.mjs` and
`tests/workflow-admission.test.mjs` assert the estimator arithmetic (a
known call costs the hand-computed amount), the reserve-audit-first rule,
budget refusal at the boundary, and that refusals never mutate the ledger.
These are pure modules; a Sonnet subagent can scaffold the tests from this
specification, with the arithmetic cases stated in the plan reviewer's own
words.

Validation: `make test` passes; the new tests failed before the modules
existed.

### Milestone M2: deterministic host takeover

In `bin/dakar-review.mjs`: call `prepare` from `scripts/review-state.mjs`
in-process before `odw run`, and pass the prepared range, changed files,
and diff statistics into the workflow arguments (the config result is
already passed). After a successful workflow result, call `appendReview`
in-process as the primary path — promoting the logic of
`recoverRecordFailure` — and stamp `recorded.recordedBy: "dakar-review"`.
The `alreadyReviewed` short-circuit moves to the CLI: if `prepare` reports
nothing to review, the CLI exits with the documented `skipped: true` result
without invoking ODW at all.

In `src/workflows/dakar-review/main.ts`: delete the Resolve Config,
Prepare, and Record agent phases (the workflow receives prepared inputs as
args and returns `recordInput` for the CLI to persist); delete the
Synthesize agent call and make the existing deterministic
`authoritativeReport` construction the only rendering path. Update
`meta.js` phases accordingly. The workflow's failure taxonomy keeps its
`stage` names — `config` and `prepare` failures now originate in the CLI
with the same structured envelope on stderr and a non-zero exit.

Red first: extend `tests/cli.test.mjs` with cases proving `prepare` runs
without ODW being invoked when nothing is unreviewed, and that a completed
result is recorded without any record agent call; rewrite the affected
fixtures in `tests/workflow-orchestration.test.mjs` so that mocked `agent()`
calls for config, prepare, synthesize, and record now cause test failure
(no such calls may occur). Delete the prompt-builder tests for the removed
prompts.

Validation: `make test`, `make workflow-build`, `make workflow-freshness`,
and the ODW dry run pass; the dry-run output no longer lists agent-mediated
config or prepare phases.

### Milestone M3: Flex lanes

Add `codex-luna-flex` and `codex-terra-flex` adapters to `odw.config.json`
exactly as specified in ADR 002 §"Codex CLI adapter contract" (per-lane
pinned reasoning effort, `-c service_tier="flex"`), with timeouts sized
from M0 measurements. Extend `model-routing.ts` with `luna` and `terra`
roles carrying model, adapter, service tier, and reasoning effort; the
existing roles remain for the legacy route. In `task-graph.ts`, bound the
finder plan to `maxLunaFlexCalls` (default 4) evidence packs respecting
`transactionMaxFiles` (default 5); the pack builder is deterministic and
its truncation is recorded in metrics. In `main.ts`, route finder tasks
through the admission controller to the Luna lane; then replace the
per-candidate Verify pipeline with deterministic compaction
(`candidateKey` dedup, severity ranking, cap application) followed by one
Terra Flex issue-set audit whose prompt (new `auditPrompt` in `prompts.ts`)
receives the compacted candidates, changed-line map, policy context, and
remaining budget, and returns one verdict per candidate plus cluster
identifiers under the existing `VERDICT_SCHEMA` extended additively.
`resolveWorkflowConfig` gains the ADR 002 limit knobs with ADR defaults and
a `routingPolicy` field recorded in metrics.

Red first: routing tests prove finder tasks receive the Luna adapter and
never exceed four calls; orchestration tests prove exactly one audit call
occurs for an ordinary review, that admission refusal of the audit aborts
before any Luna spend (reserve-first), and that audit verdicts flow through
`acceptedFromVerdicts` unchanged; an adapter contract test asserts the
generated adapter command lines contain `service_tier="flex"` and the
pinned efforts.

Validation: full `make check` via scrutineer; dry run shows the new lanes,
caps, and pricing-table version.

### Milestone M4: Flex retry, backoff, and deferral

In `main.ts`, wrap Luna and Terra calls in a bounded retry helper using the
ambient `sleep` primitive: on a retryable failure (timeout or resource
unavailability as surfaced by the adapter), back off exponentially from
`flexInitialBackoffSeconds` with positive jitter derived deterministically
from the attempt counter and call id (no `Math.random`), up to
`flexAttempts`. Exhaustion of an optional Luna call downgrades that pack
with a recorded reason; exhaustion of the required Terra audit produces a
structured deferred result with `recorded` absent, and the CLI must not
append history for a deferred review. No fallback to standard processing
exists anywhere in code.

Red first: orchestration tests simulate persistent adapter failure and
assert the deferral shape, the absent record, and the retry count; a CLI
test proves a deferred result leaves `reviews.toml` untouched.

Validation: `make test` and the dry run pass.

### Milestone M5: contract, documentation, and gate closure

Update `docs/users-guide.md` (new limits, deferral behaviour, cost fields
in results), `docs/developers-guide.md` (lane architecture, adapter
contract, where the ledger lives), `docs/dakar-review-design.md` (mark the
superseded per-candidate verification and agent-wrapped phases; reconcile
the benchmark statement with ADR 002's per-review targets), and
`docs/roadmap.md` checkboxes for completed 7.x tasks. Run the complete gate
suite through a scrutineer agent and commit milestone by milestone if not
already done.

Validation: scrutineer reports every gate green, including Markdown gates.

### Milestone M6: live cost validation

Create `scripts/live-review-harness.mjs` (or a documented shell procedure
if a script proves unnecessary) that: clones a corpus repository into the
scratchpad, checks out the pull-request head, exports `CODEX_API_KEY` by
reading `~/dakar-api-key.txt` inside the process (never on a command line),
runs `dakar-review --base <sha> --head <sha> --state-root <scratch>` with
telemetry to stderr, and writes the result JSON plus extracted ledger to a
scratch results directory.

Execute in strict cost order: tiny (`comenq` #140), then small
(`ddlint` #294), then medium (`frankie` #102). After each run, record in
this plan the ledger total, token counts, latency, findings summary, and a
hand assessment of usefulness. Proceed to `rstest-bdd` #593 and
`wireframe` #612 only if cumulative spend permits within the cap. Run the
oversize probe (`wireframe` #609) last and expect a budget refusal or
deferral, not a completed review.

Acceptance: at least one ordinary review (medium tier or above) completes
with genuinely useful findings — findings an implementation agent could act
on, judged by hand — at a ledger total below USD 0.25. Record whether any
run beat USD 0.11. If reviews complete but findings are vacuous, apply the
Luna-effort escalation from `Risks`, rerun once, and record both ledgers.

## Concrete steps

All commands run from the repository root
`/home/leynos/Projects/dakar.worktrees/api-key-support` unless stated.

Gate runs (every milestone, via scrutineer; manual equivalent shown):

```sh
make check 2>&1 | tee "/tmp/check-dakar-api-key-support.out"
```

Workflow rebuild after any `src/workflows/dakar-review/` change:

```sh
make workflow-build && make workflow-freshness
```

M0 probe (from the scratchpad directory; key never appears in the command):

```sh
CODEX_API_KEY="$(cat ~/dakar-api-key.txt)" codex exec --json \
  --skip-git-repo-check --sandbox read-only \
  -c 'service_tier="flex"' -c 'model_reasoning_effort="low"' \
  --model gpt-5.6-luna \
  'Reply with the single word: pong' > codex-probe.jsonl 2>codex-probe.err
```

Expected: the JSONL stream ends with a completed turn containing a usage
object with `input_tokens`, `cached_input_tokens`, and `output_tokens`.
Inspect the stream (and, if present, the effective-configuration event) for
service-tier evidence.

M6 harness run (per corpus entry; illustrative for `comenq` #140):

```sh
node scripts/live-review-harness.mjs \
  --repo leynos/comenq --pr 140 \
  --work "$SCRATCHPAD/corpus" --out "$SCRATCHPAD/results"
```

Expected: stderr shows telemetry; `$SCRATCHPAD/results/comenq-140.json`
contains the result with `metrics.ledger` rows and a `ledgerTotalUsd`
below the target.

## Validation and acceptance

Quality criteria:

- Tests: `make test` passes; every new behaviour has a test that was
  observed failing first (record the red evidence per milestone in
  `Artefacts and notes`).
- Gates: `make check` (formatting, docstrings, markdownlint, nixie,
  typecheck, workflow freshness, ODW dry run, tests, spelling) passes at
  every commit, run via scrutineer.
- ADR 002 verification subset delivered by this slice: a blocking admission
  refusal launches no model calls; config, prepare, rendering, and
  recording launch no model calls; no ordinary review exceeds the Luna and
  Terra caps; a resource-unavailable response retries with bounded backoff
  and never uses standard processing; an exhausted required audit leaves
  the head unrecorded; deterministic rendering is byte-stable for the same
  consolidated input.
- Cost: one live medium-tier review below USD 0.25 provider spend
  (acceptance); below USD 0.11 (stretch, recorded either way).

Quality method: scrutineer gate reports with cited logs; live-run ledgers
captured under the scratchpad results directory and summarized in this
plan.

## Idempotence and recovery

All milestones are ordinary git commits on `api-key-support`; a failed
milestone is abandoned with `git restore`/`git stash`, never left half
staged. The live harness writes only under the scratchpad and an isolated
`--state-root`; deleting those directories fully resets live-validation
state. Probe and harness runs are idempotent and safe to repeat, at the
cost of provider spend — check the running total against the cap before
each repeat. `make workflow-build` is deterministic; regenerating the
artefact is always safe.

## Artefacts and notes

To be populated during execution: M0 probe transcripts (with any key
material redacted), red-test evidence per milestone, live-run ledger
summaries, and the final cost table for the corpus.

## Interfaces and dependencies

No new runtime dependencies. No new dev dependencies are anticipated; any
exception triggers the Dependencies tolerance.

In `src/workflows/dakar-review/pricing.ts`:

```ts
export interface PricingBand {
  inputUsdPerMTok: number;
  cachedInputUsdPerMTok: number;
  outputUsdPerMTok: number;
}
export interface PricingTable {
  version: string;
  usdPerGbp: number;
  rates: Record<string, PricingBand>; // key: `${model}:${serviceTier}`
}
export function estimateWorstCaseUsd(
  table: PricingTable,
  call: {
    model: string;
    serviceTier: string;
    inputTokens: number;
    cachedInputTokens: number;
    maxOutputTokens: number;
  },
): number;
```

In `src/workflows/dakar-review/admission.ts`:

```ts
export interface AdmissionState {
  budgetUsd: number;
  reservedAuditUsd: number;
  spentUsd: number;
}
export type AdmissionDecision =
  | { admitted: true; worstCaseUsd: number }
  | { admitted: false; reason: string; worstCaseUsd: number };
export function admit(
  state: AdmissionState,
  worstCaseUsd: number,
  kind: 'luna-transaction' | 'terra-audit',
): AdmissionDecision;
```

In `types.ts`, additively:

```ts
export interface LedgerEntry {
  callId: string;
  phase: string;
  lane: 'luna-flex' | 'terra-flex';
  model: string;
  serviceTier: string;
  reasoningEffort: string;
  estimatedWorstCaseUsd: number;
  reportedUsage?: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
  };
  pricingTableVersion: string;
  attempts: number;
}
```

The Terra audit reuses `VERDICT_SCHEMA` with an additive optional
`clusterId` string per verdict. The workflow result gains additive
`metrics.ledger: LedgerEntry[]`, `metrics.ledgerTotalUsd`, and
`metrics.routingPolicy`.
