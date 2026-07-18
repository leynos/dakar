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

Cost-goal framing (expert-panel finding, adopted): the USD 0.25 and USD 0.11
figures are independently chosen delivery goals, not currency conversions of
ADR 002's GBP targets. ADR 002's hard ordinary-review budget is £0.10, which
is about USD 0.127 at the pricing table's seed exchange snapshot; the
admission controller enforces the GBP budget through that versioned
snapshot. The worst case of the default caps (four Luna transactions plus
one Terra audit, uncached input priced at the cache-write band) is about
USD 0.133, so the USD 0.11 stretch goal is a typical-case goal — reachable
only when fewer transactions fire or cached input reduces spend — and a
worst-case-shaped run that lands near USD 0.13 is expected behaviour, not a
near-miss. The USD 0.25 acceptance goal holds with roughly 2x headroom over
the worst case. Terra dominates the ceiling (roughly 70% of worst-case
spend), so `terraMaxInputTokens` is the lever that matters if cost must
come down later, not the Luna caps.

Success is observable: a live review of a selected estate pull request
completes end to end, the result carries a per-call cost ledger with
provider-reported token usage, and the reported ledger total is below the
target.

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
- Every milestone's exit criteria include updating this plan's `Progress`,
  `Decision Log`, and `Artefacts and notes` sections before the milestone
  is declared complete. Subagents performing milestone work must be
  instructed to do this explicitly.

If satisfying the objective requires violating a constraint, stop, record
the conflict in `Decision Log`, and escalate.

## Tolerances (exception triggers)

- Scope: if a milestone requires net changes beyond roughly 25 files or
  2,500 lines, stop and escalate.
- Interface: if the CLI's existing flag semantics or the workflow result's
  existing top-level fields (`findings`, `discarded`, `metrics`, `recorded`)
  must change incompatibly, stop and escalate. Additive fields are within
  tolerance, as are the dry-run and phase-name changes explicitly recorded
  in the `Decision Log`.
- Dependencies: if any new runtime dependency appears necessary, stop and
  escalate. New pinned dev dependencies require a Decision Log entry.
- Iterations: if a test still fails after three distinct fix attempts, stop
  and escalate.
- Spend: if cumulative live provider spend reaches USD 4.00 before milestone
  M7 completes, stop and escalate with the ledger evidence.
- Ambiguity: if the chosen adapter vehicle cannot be proven to deliver
  `service_tier = "flex"` to the provider, stop and present options rather
  than silently paying standard rates. (Fired and resolved for Codex CLI
  on 2026-07-18; the pi path is proven. It fires again only if pi
  regresses.)

## Risks

- Risk: Codex CLI may not plumb `service_tier = "flex"` through to the
  provider when authenticated with `CODEX_API_KEY`, or may not expose
  which tier the provider actually applied.
  Severity: high. Likelihood: medium.
  Mitigation: milestone M0 proves or refutes this before any implementation
  depends on it, using provider-side evidence (the Responses API echoes the
  applied `service_tier` in the response body), not configuration echo. The
  fallback is a thin host-side Responses API adapter script (Node built-in
  `fetch`, no runtime dependency) registered as an ODW adapter command;
  ADR 002 rejected a bespoke wrapper only "solely to select Flex", so a
  proven plumb-through failure is a documented justification.
- Risk: Flex processing latency (requests can take many minutes; the
  provider's own SDK default timeout is 10 minutes) may exceed ODW agent or
  CLI timeouts and read as failures, or the CLI's outer `--timeout` may
  kill the run before the workflow's own deferral logic fires.
  Severity: high. Likelihood: medium.
  Mitigation: M0 measures real latency; M5 sizes the retry schedule and
  states the outer `--timeout` the harness must pass, sized above the
  worst-case backoff-plus-latency budget, with a test that the workflow's
  deferral path completes within it.
- Risk: `gpt-5.6-luna` at low reasoning may produce too few or too shallow
  candidates for a useful review.
  Severity: medium. Likelihood: medium.
  Mitigation: the live corpus (M7) includes pull requests with known
  substantive changes; if findings are vacuous, escalate Luna finders to
  the pre-registered `pi-luna-flex-medium` adapter (still Flex), rerun
  once, and record both ledgers.
- Risk: ODW may not surface adapter token usage to the workflow result,
  leaving the ledger with estimates only.
  Severity: medium. Likelihood: medium.
  Mitigation: the pi flex extension logs the assistant message's usage
  object (input, output, cacheRead, cacheWrite) to stderr per call; if
  ODW drops it, the harness parses the adapter stderr from the ODW run
  directory instead, and the ledger marks those rows as harness-derived.
  Estimated and reported fields are separate from the start.
- Risk: replacing per-candidate verification with one audit may admit
  false positives that the old adversarial verifier would have refuted, or
  miss defects the per-candidate route caught.
  Severity: medium. Likelihood: low.
  Mitigation: the audit lands first on the existing standard-tier adapters
  (M3) so its behaviour is validated in isolation from Flex plumbing; the
  audit prompt is explicitly adversarial per ADR 002; M7 inspects accepted
  findings by hand on the tiny and small corpus entries where ground truth
  is easy to establish.
- Risk: it may not be possible to observe a genuine Flex
  `resource_unavailable` response on demand, leaving the M5 retryable
  classifier built on an assumed rather than observed signal shape.
  Severity: medium. Likelihood: medium.
  Mitigation: M0 records how `codex exec` reports request failure (exit
  code, JSON event shape) for at least one induced failure (for example an
  unreachable override or tiny timeout); if the specific 429 shape cannot
  be captured, M5 classifies conservatively (retry on timeout and on
  adapter failure whose output does not parse as a model refusal) and the
  `Decision Log` records the assumption for revisiting with live evidence.

## Progress

- [x] (2026-07-18 16:20Z) Reconnaissance: source map, gap analysis, design
  document digest, external facts verified (Flex contract, pricing,
  `CODEX_API_KEY` auth), candidate corpus selected.
- [x] (2026-07-18 16:30Z) Roadmap phase 7 added to `docs/roadmap.md`.
- [x] (2026-07-18 17:10Z) Expert-panel review completed (three panels, six
  lenses); findings folded into this revision. Corpus base and head SHAs
  pinned.
- [x] (2026-07-18 18:05Z) M0: Flex plumb-through and billing-evidence
  probe. Direct-API control probe proves Flex applied and usage
  reported; Codex CLI proven unable to send `service_tier` (three
  versions tested, three upstream issues corroborate); goose eliminated
  by source inspection; pi proven end to end (capture-server payload
  evidence plus a 3-second live Flex round trip with usage reporting).
  Adapter path decided: pi with a Dakar-owned flex extension, per
  operator direction.
- [ ] M1: pricing table, cost ledger types, admission controller (pure
  modules with tests).
- [ ] M2: deterministic host takeover, in four stages (test-harness mock
  helper; prepare to CLI; deterministic rendering; record to CLI).
- [ ] M3: issue-set audit replaces per-candidate verification, on the
  existing standard-tier adapters.
- [ ] M4: Flex adapters, Luna and Terra lane routing, admission wiring.
- [ ] M5: Flex retry, backoff, deferral policy, and timeout budget.
- [ ] M6: contract, dry-run, and documentation updates; full gates.
- [ ] M7: live cost validation on the estate corpus.

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
  `sol` is out of scope but the table schema and the ledger `lane` field
  must not preclude it.
- Observation (M0, blocking): Codex CLI 0.144.4 does not transmit
  `service_tier` to the provider at all. A local capture server registered
  as a Codex model provider shows the `/v1/responses` request body carries
  `model` and `reasoning.effort` (the `-c model_reasoning_effort` override
  works) but no `service_tier` key, for every config spelling tried
  (top-level, provider-scoped, `model_service_tier`). The earlier
  "successful" Codex probe was therefore billed at standard rates,
  silently — exactly the failure mode the Ambiguity tolerance names.
  Evidence: `captured-requests.jsonl` in the scratchpad; four-variant
  probe transcript, 2026-07-18.
  Impact: ADR 002's premise that "Codex CLI can select Flex directly" is
  falsified for the installed version; M0 is a no-go on the Codex path and
  the plan's designated fallback (direct Responses API adapter) is on the
  table. Escalated for direction.
- Observation (M0): each `codex exec` call carries roughly 20,100 input
  tokens of Codex harness overhead before any evidence pack (probe usage:
  20,128 input tokens for a one-line prompt), against ADR 002's
  `transactionMaxInputTokens` of 12,000 for the whole transaction.
  Evidence: `codex-probe.jsonl` usage block, 2026-07-18.
  Impact: through Codex, every Luna transaction would cost roughly
  32k input tokens rather than 12k, materially eroding the cost model
  (partially mitigated by prompt caching of the stable prefix). A direct
  API adapter with purpose-built prompts (~1-3k tokens of instruction plus
  the evidence pack) is cheaper than the ADR's own model, not just
  equal to it.
- Observation (M0): the direct Responses API control probe succeeded
  end to end: `service_tier: "flex"` echoed in the response body (the
  billing-relevant applied-tier evidence), usage reported (13 input /
  5 output tokens), single-word answer returned, sub-second latency on
  this probe.
  Evidence: `flex-control.json` in the scratchpad, 2026-07-18.
  Impact: the API key, model name, Flex tier, and usage reporting are all
  proven on the direct path; only the Codex CLI leg failed.
- Observation (M0): the Codex gap is confirmed upstream, not local
  misconfiguration. Issues openai/codex#26604 (0.137.0 ignores
  `service_tier="flex"` on API-key auth, open since 2026-06-05),
  openai/codex#31562 (tier omitted for gpt-5.5/5.6 on 0.143-0.144.4),
  and openai/codex#2916 (original 2025 feature request, still open) all
  describe it; the source shows `ResponsesApiRequest.service_tier`
  exists but its resolution lives in the TUI crate behind a FastMode
  feature gate, unreachable from `codex exec`. Capture-server tests of
  0.144.4, 0.144.6, and 0.145.0-alpha.23 (including
  `features.fast_mode=true`) all omit the field.
  Evidence: upstream issues; capture transcripts, 2026-07-18.
  Impact: no Codex version currently shippable can select Flex; waiting
  on upstream is not a plan.
- Observation (M0): `goose` cannot select Flex either — its OpenAI
  provider's `create_request` has no service-tier parameter; the only
  `service_tier` occurrences are response-parsing test fixtures.
  Evidence: `crates/goose-provider-types/src/formats/openai.rs`,
  aaif-goose/goose, read 2026-07-18.
  Impact: goose is eliminated without local testing.
- Observation (M0): `pi` (`@earendil-works/pi-coding-agent`) selects
  Flex through a supported extension point. A ten-line extension
  returning `{ ...event.payload, service_tier: "flex" }` from the
  documented `before_provider_request` hook put `service_tier: "flex"`
  into the captured `/v1/responses` payload (mock provider), and a live
  probe through a custom `openai-flex` provider returned HTTP 200 and
  the correct answer in 3 seconds with usage reported as
  `{input: 3, output: 5, cacheRead: 0, cacheWrite: 12819}`. pi also
  supports `PI_CODING_AGENT_DIR` for config isolation, `-p` print mode
  reading stdin, `--thinking` for reasoning effort, and per-model
  custom providers with `$ENV` or `!command` API-key resolution.
  Evidence: `captured-requests.jsonl`, `pi-live.out`, `pi-live.err` in
  the scratchpad, 2026-07-18.
  Impact: pi becomes the adapter vehicle (see Decision Log). Its ~12.8k
  cache-write-token prompt overhead is smaller than Codex's ~20k and
  reducible later via `--tools`/`--system-prompt` tuning; overhead
  tokens land in the cache-write band on first use and the cached band
  thereafter, which the M1 estimator must include. Two operational
  notes: pi's `--mode json` blocked indefinitely in this environment
  (use `-p` with an extension logging usage to stderr instead), and a
  model absent from the selected provider's catalogue makes pi hang
  rather than fail — the adapter must pin `--provider openai-flex` with
  models declared in the Dakar-owned `models.json`.

## Decision log

- Decision: implement ADR 002 as a vertical slice (roadmap 7.1-7.4),
  deferring SARIF envelope adoption, deterministic gate running, and the
  adjudicated comparison corpus (roadmap 7.5).
  Rationale: the delivery goal is a minimally useful live review below
  USD 0.25; the deferred items do not reduce provider spend and each is
  independently landable later. The existing JSON findings contract is
  preserved so nothing downstream breaks. For 7.5.1 (SARIF), note that the
  current candidate schema has no semantic fingerprint distinct from
  `candidateKey`; adopting SARIF later will add a fingerprint field, and
  this slice keeps candidate identity fields additive so that projection
  stays mechanical.
  Date/Author: 2026-07-18, planning agent.
- Decision: the legacy route is removed by this slice rather than retained
  behind `routingPolicy: legacy`; the roadmap 7.5.3 comparison will use a
  git tag (`legacy-route-final`, created at the last pre-M2 commit) as the
  legacy arm.
  Rationale: keeping both pipelines selectable would roughly double the
  orchestration and test surface of every subsequent milestone for a
  comparison that runs once against fixtures. The tag preserves a runnable
  legacy arm at zero maintenance cost. This deliberately collapses
  ADR 002's staged default-cutover (migration step 10) for this
  single-operator repository; `metrics.routingPolicy` is retained so
  results are self-describing.
  Date/Author: 2026-07-18, planning agent, adopting expert-panel finding.
- Decision: deterministic phases move to the CLI process, not into the ODW
  workflow body.
  Rationale: the workflow runs inside the ODW runtime with ambient
  primitives only and cannot execute host commands itself; today it fakes
  determinism by paying a model to run `scripts/review-state.mjs`. The CLI
  already imports both helper scripts. Moving prepare before `odw run` and
  record after it makes the workflow a pure model-orchestration unit and
  deletes four agent calls.
  Date/Author: 2026-07-18, planning agent.
- Decision: this slice deviates from ADR 001's "preserve dry-run output and
  phase names" compatibility clause: the dry-run result loses
  `synthesisModel`, `synthesisAdapter`, and `synthesisSchema`, and the
  phase list in `meta.js` shrinks to Plan, Review, Audit.
  Rationale: ADR 001's non-goal was "change review behaviour" incidentally
  during the compiler migration; ADR 002 is an accepted decision that
  changes review behaviour deliberately. The dry-run characterization test
  is updated red-first in M2/M3 and the users' guide documents the new
  shape in M6.
  Date/Author: 2026-07-18, planning agent, adopting expert-panel finding.
- Decision: the audit response uses a new `AUDIT_SCHEMA` wrapping
  `{ verdicts: Verdict[], clusters?: … }`; `VERDICT_SCHEMA` remains the
  per-item shape. `main.ts` re-pairs returned verdicts to compacted
  candidates by `candidateId` (unknown ids become auditable discards, as
  today), so `acceptedFromVerdicts` and `discardedFromVerdicts` are reused,
  but the pairing harness around them (`main.ts:235-289`) is a rewrite,
  not a reuse.
  Rationale: one agent call returns one schema-validated object; the
  existing per-candidate binding cannot survive unchanged and pretending
  otherwise would misbudget M3.
  Date/Author: 2026-07-18, planning agent, adopting expert-panel finding.
- Decision: prove the issue-set audit on the existing standard-tier
  adapters (M3) before introducing Flex adapters and lane routing (M4).
  Rationale: the plan's two riskiest bets — Flex plumbing and
  one-audit-replaces-thirty-verifications — previously landed in one
  milestone; a failure there could not be attributed. Sequencing them
  separately isolates faults and gives each its own red-first gate and
  iteration tolerance.
  Date/Author: 2026-07-18, planning agent, adopting expert-panel finding.
- Decision: after a Terra-side deferral, a retried review re-runs the Luna
  finder phase and pays for it again; Luna output is not cached across
  workflow invocations in this slice. The harness and users' guide state
  that repeated deferral retries recompound Luna spend, and operators
  should space retries rather than tight-loop them.
  Rationale: cross-invocation caching of paid model output is a new
  persistence surface with its own invalidation problems; the re-pay cost
  is bounded (about USD 0.04 worst case per retry) and acceptable for this
  slice. Revisit if deferrals prove frequent.
  Date/Author: 2026-07-18, planning agent, adopting expert-panel finding.
- Decision: the live corpus reviews estate pull requests by cloning each
  repository into the scratchpad, checking out the pinned head SHA, and
  running `dakar-review --base <base-sha> --head <head-sha>` with an
  isolated `--state-root`. The harness fails closed if the fetched PR head
  does not match the pinned SHA, and asserts the resolved state root is
  under its own scratch directory before invoking the CLI.
  Rationale: exercises the real CLI path end to end, keeps recorded ledger
  numbers reproducible against rebased PRs, and makes state-root isolation
  a code-level guard rather than a procedural promise.
  Date/Author: 2026-07-18, planning agent, adopting expert-panel finding.
- Decision: build-cost control — mechanical module extraction, test
  scaffolding, and documentation sweeps delegate to Sonnet subagents; the
  `main.ts` orchestration redesign and the audit prompt are authored by
  Opus; all commit gates run through scrutineer agents. The arithmetic
  test cases for M1 are the worked examples embedded in this plan
  (Interfaces section), so a fresh subagent needs no external author.
  Rationale: matches effort to task difficulty, keeps bulky gate output
  out of the planning context, and makes M1 delegable after context
  compaction.
  Date/Author: 2026-07-18, planning agent.
- Escalation: M0 reached its Ambiguity tolerance — Codex CLI 0.144.4
  provably does not transmit `service_tier`, so the Codex adapter path
  cannot reach Flex pricing. Options presented to the operator:
  (a) the plan's designated fallback, a direct Responses API adapter
  (`scripts/flex-adapter.mjs`, Node built-in `fetch`, no runtime
  dependency, registered as an ODW adapter command) — proven plumb-through,
  per-call applied-tier and usage evidence, and ~20k tokens per call
  cheaper than the Codex path; evidence packs are host-built so finder and
  audit calls need no agentic file access; (b) upgrade Codex CLI hoping a
  newer version transmits the key — unverified, touches shared system
  tooling, and retains the harness overhead; (c) accept standard pricing
  through Codex — violates ADR 002 and roughly doubles the cost model.
  Recommendation: (a).
  Resolution: the operator directed a source-level confirmation and an
  evaluation of `goose` and `pi` before rolling a bespoke adapter. All
  three were done (see Surprises). Decision: **the ODW adapters use the
  `pi` coding agent** (`@earendil-works/pi-coding-agent`) in print mode
  with a small Dakar-owned pi extension that injects
  `service_tier: "flex"` through pi's documented
  `before_provider_request` hook, and a Dakar-owned pi config directory
  (custom `openai-flex` provider, `apiKey: "$OPENAI_API_KEY"`). This is
  the operator's preferred alternative order (codex confirmed broken
  upstream; goose lacks request-side tier support; pi works through a
  supported extension point, so no bespoke API client is required).
  Milestone M4 is re-specified accordingly, and ADR 002's adapter
  contract section carries a matching amendment.
  Date/Author: 2026-07-18, implementing agent, per operator direction.

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
  bounded `AGENTS.md` context, invokes `odw run` (default `--timeout 900`
  when waiting), and post-processes the result. `recoverRecordFailure`
  (lines 333-368) is the existing deterministic record fallback.
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
  wrapping `review-state.mjs record`). The skip result
  (`main.ts:171-181`) and the verdict-pairing harness
  (`main.ts:235-289`) are contract surfaces this plan touches.
- `src/workflows/dakar-review/model-routing.ts` — roles `medium`, `high`,
  `mini`, `spark` mapped to `gpt-5.5`, `gpt-5.4-mini`,
  `gpt-5.3-codex-spark`; adapters `codex-low|medium|high`.
- `src/workflows/dakar-review/task-graph.ts`, `candidates.ts`,
  `prompts.ts`, `schemas.ts`, `types.ts`, `shell.ts`, `meta.js` — task
  planning, candidate normalization and dedup (`candidateKey`), prompt
  construction, JSON Schemas, shared types, shell quoting, and workflow
  metadata respectively. `PreparedReview` (`types.ts:41-52`) is the shape
  the prepared range travels in.
- `odw.config.json` — three Codex CLI adapters (`codex-low|medium|high`),
  none of which set a service tier.
- `tests/` — the constraint surface. `workflow-orchestration.test.mjs`
  mocks `agent()` per phase with brittle string-slicing of prompts and is
  refactored in M2 stage a before behavioural edits; `review-state*` and
  `review-config` tests already treat the helper scripts as pure units and
  are reusable.

Verified external facts (2026-07-18):

- Flex processing: set `service_tier: "flex"` on Responses or Chat
  Completions; tokens bill at Batch rates; HTTP 429 with the
  `resource_unavailable` error code is not billed and is retryable; SDK
  default timeout is 10 minutes and should be raised for Flex. The
  response body echoes the service tier the provider actually applied,
  which is the billing-relevant evidence.
- Pricing (USD per million tokens, short context): Luna Flex 0.50 input /
  0.05 cached / 0.625 cache-write / 3.00 output; Terra Flex 1.25 / 0.125 /
  1.5625 / 7.50 — matching ADR 002 Table 1. Both models support Flex.
- Codex CLI: `CODEX_API_KEY=<key> codex exec --json "task"` authenticates
  with a platform API key (billed to the API, not a ChatGPT subscription)
  and reports `input_tokens`, `cached_input_tokens`, and `output_tokens`.
  Configuration overrides pass per call as `-c key=value`.

The API key for live validation is at `~/dakar-api-key.txt` (outside the
repository; see Constraints).

Live-validation corpus, selected for size spread from real (non-dependabot)
changes, with base and head SHAs pinned on 2026-07-18. The harness fails
closed on any SHA mismatch.

| Tier | Repository and PR | Files | Diff | Base SHA | Head SHA |
| - | - | -: | - | - | - |
| Tiny | `leynos/comenq` 140 | 1 | +11/−6 | `e39920ff83c2` | `448f1a458185` |
| Small | `leynos/ddlint` 294 | 2 | +57/−29 | `73ad5cbe7b08` | `dab5e73472b4` |
| Medium | `leynos/frankie` 102 | 5 | +63/−8 | `b5695f9a6394` | `e6f6607c0b48` |
| Upper-medium | `leynos/rstest-bdd` 593 | 11 | +228/−117 | `3410c4ab29cf` | `6d0a14bb1cc3` |
| Large | `leynos/wireframe` 612 | 28 | +569/−99 | `6ba14735ca72` | `1df84ef92f91` |
| Oversize probe | `leynos/wireframe` 609 | 101 | +3,988/−176 | `1f8abdb4c536` | `0cf82559ba39` |

Table 1: candidate pull requests for live cost validation (SHAs abbreviated
here; the harness pins the full 40-character values). The oversize probe
exists to observe budget refusal or deferral, not to complete. Note the
coverage bound: `maxLunaFlexCalls` (4) times `transactionMaxFiles` (5)
caps Luna evidence at 20 files, so the Large entry is by construction a
partial-coverage review; its usefulness is judged against the reviewed
subset, not the full file list.

## Plan of work

The work is eight milestones, M0 through M7. Each ends with validation and
with this plan's living sections updated; do not proceed past a failed
validation. Red-Green-Refactor applies to every code milestone: the
project's test framework is `node --test` (run via `make test`), and each
behaviour change lands with a test that fails first for the expected
reason.

### Milestone M0: Flex plumb-through and billing-evidence probe (go/no-go)

Prove, with minimal spend, that the intended plumbing works before any code
depends on it. From the scratchpad directory (never the repo):

1. Direct-API control probe: one `curl` to the Responses API with
   `model: "gpt-5.6-luna"`, `service_tier: "flex"`, and a one-line prompt.
   The response body's `service_tier` field is the provider-side evidence
   of the tier actually applied. Record it, the usage block, and latency.
2. Codex probe: one `codex exec --json` invocation with the Flex and
   low-effort overrides. Capture the full JSON event stream. Evidence of
   success is either a response/turn event exposing the applied service
   tier, or (failing that) the combination of accepted configuration plus
   the direct-API control proving the parameter has effect when it reaches
   the provider.
3. Failure-shape capture: induce at least one failure (for example a
   deliberately tiny `-c` timeout override or an invalid model name) and
   record how `codex exec` reports it: exit code, stderr, and JSON event
   shape. This calibrates the M5 retryable classifier. If a genuine Flex
   `resource_unavailable` occurs naturally during probing, capture it
   verbatim — it is the most valuable single transcript in this plan.

Acceptance: probe 1 returns `service_tier: "flex"` (or the provider's
equivalent applied-tier evidence) in the response body; probe 2 completes
with usage counts and no evidence of tier rejection; probe 3's failure
shape is recorded in `Artefacts and notes`. If probe 2 shows Codex does not
pass the tier through, stop: present the direct-adapter fallback
(`scripts/flex-adapter.mjs` calling the Responses API with Node's built-in
`fetch`, registered as an ODW adapter command) with its trade-offs, and
await direction. Estimated spend: well under USD 0.01 per probe. Record
measured latency for both probes; these numbers size the adapter and outer
timeouts in M4 and M5.

### Milestone M1: pricing table, ledger, and admission control

Create `src/workflows/dakar-review/pricing.ts` and `admission.ts` and
extend `types.ts` exactly as specified in `Interfaces and dependencies`,
including the cache-write band and the two admission inequalities. Seed the
pricing table with the verified 2026-07-18 rates
(`pricingTableVersion: "2026-07-18"`) and the exchange snapshot
(`usdPerGbp: 1.27`, a versioned datum, not a constant). The worst-case
estimator prices uncached input at the cache-write band, matching ADR 002's
stated worst case.

Red first: `tests/workflow-pricing.test.mjs` and
`tests/workflow-admission.test.mjs` assert the worked examples from the
Interfaces section verbatim, the reserve-audit-first inequalities
(including that the audit consumes its own reservation without double
counting), budget refusal at the boundary, and that refusals never mutate
the ledger. These are pure modules; a Sonnet subagent scaffolds the tests
from the worked examples in this plan.

Validation: `make test` passes; the new tests failed before the modules
existed.

### Milestone M2: deterministic host takeover (four stages)

Before stage b, create the git tag `legacy-route-final` on the last
pre-M2 commit (see Decision Log). Each stage is independently landable
with its own red test, validation, and commit.

Stage a — test-harness refactor (no behaviour change): extract a typed
mock-agent-sequence helper in `tests/` keyed by phase and label, so
`workflow-orchestration.test.mjs` fixtures declare expected calls and
responses as data instead of string-slicing prompts. All existing tests
pass unchanged through the helper.

Stage b — prepare to CLI: `bin/dakar-review.mjs` calls `prepare` from
`scripts/review-state.mjs` in-process before `odw run` and passes the
result as the additive `WorkflowArgs.prepared: PreparedReview` field
(exact shape in Interfaces). `main.ts` consumes `args.prepared`, deletes
the Resolve Config and Prepare agent phases, and echoes `headCommit`,
`reviewBase`, `commitCount`, and `changedFiles` back unchanged in its
result so the CLI can record without re-deriving. The `alreadyReviewed`
short-circuit moves to the CLI: if `prepare` reports nothing to review,
the CLI emits the documented skip result without invoking ODW. The CLI
skip shape is pinned as: the workflow skip shape with `resolvedConfig`
replaced by the CLI's `resolveReviewConfig` result under the existing
`config` field (the agent-shaped `resolvedConfig` field is dropped; this
is one of the recorded dry-run deviations). Config and prepare failures
keep their structured `stage` envelopes, now emitted by the CLI.

Stage c — deterministic rendering: delete the Synthesize agent call; the
existing `authoritativeReport` construction becomes the only rendering
path and must be byte-stable for the same consolidated input (add the
byte-stability test).

Stage d — record to CLI: after a successful workflow result the CLI calls
`appendReview` in-process as the primary path (promoting
`recoverRecordFailure`'s logic), stamping `recorded.recordedBy:
"dakar-review"`. The workflow's Record agent phase and `recordPrompt` are
deleted; `meta.js` phases update.

Red first, per stage: stage b — CLI tests prove `prepare` runs without ODW
when nothing is unreviewed and that mocked config or prepare agent calls
now fail the orchestration suite; stage c — byte-stability test plus a
mocked-synthesis-call failure assertion; stage d — a completed result is
recorded with no record agent call, and the dry-run characterization test
is updated to the new phase list with the removed fields enumerated.

Validation: `make test`, `make workflow-build`, `make workflow-freshness`,
and the ODW dry run pass after each stage; the dry-run output no longer
lists agent-mediated config, prepare, synthesize, or record phases after
stage d.

### Milestone M3: issue-set audit on standard-tier adapters

Replace the per-candidate Verify pipeline with deterministic compaction
followed by one issue-set audit call, still using the existing
`codex-high` adapter and synthesis model. Compaction is host code:
`candidateKey` dedup, severity ranking, and a new `maxAuditCandidates`
cap (default 30, configurable) — candidates over the cap are recorded as
discarded with reason `over-audit-cap`, never silently dropped. Add
`AUDIT_SCHEMA` to `schemas.ts` (shape in Interfaces) and `auditPrompt` to
`prompts.ts`, receiving the compacted candidates, changed-line map,
policy context, and remaining budget, with the adversarial duties from
ADR 002's Terra boundary section. `main.ts` re-pairs returned verdicts to
compacted candidates by `candidateId`; unknown or missing ids become
auditable discards. `resolveWorkflowConfig` gains `maxAuditCandidates`
and `routingPolicy` (recorded in metrics; sole value
`deterministic-flex-v1` once M4 lands).

Red first: orchestration tests prove exactly one audit call occurs for an
ordinary review, that over-cap candidates appear as `over-audit-cap`
discards, that a verdict citing an unknown candidate id becomes a
discard, and that accepted findings flow through `acceptedFromVerdicts`
with cluster identifiers preserved.

Validation: full `make check` via scrutineer; dry run shows the audit
phase and the new caps.

### Milestone M4: Flex adapters and lane routing

Create the Dakar-owned pi adapter assets under `adapters/pi/`:
`flex-tier.ts` (the pi extension that returns
`{ ...event.payload, service_tier: "flex" }` from
`before_provider_request` and logs the assistant message's usage object
to stderr from `message_end`) and `models.json` (custom `openai-flex`
provider, `baseUrl` `https://api.openai.com/v1`, `api`
`openai-responses`, `apiKey: "$OPENAI_API_KEY"`, models `gpt-5.6-luna`
and `gpt-5.6-terra`). Add `pi-luna-flex`, `pi-luna-flex-medium` (the
pre-registered escalation adapter), and `pi-terra-flex` adapters to
`odw.config.json`, each invoking
`pi -p --no-session -e adapters/pi/flex-tier.ts --provider openai-flex`
with the lane's `--model` and `--thinking` pinned, `{prompt}` on stdin,
and `PI_CODING_AGENT_DIR` pointing at `adapters/pi/` so the catalogue is
Dakar's own (a model missing from the provider catalogue makes pi hang,
so the pinned provider and declared models are load-bearing). Per-call
timeouts are sized from M0 measurements. Extend `model-routing.ts` with
`luna` and `terra` roles
carrying model, adapter, service tier, and reasoning effort. In
`task-graph.ts`, bound the finder plan to `maxLunaFlexCalls` (default 4)
evidence packs respecting `transactionMaxFiles` (default 5), recording
truncation in metrics. In `main.ts`, route finder tasks through the
admission controller to the Luna lane and the audit to the Terra lane,
reserving the audit's worst-case estimate before any Luna dispatch.
`resolveWorkflowConfig` gains the remaining ADR 002 limit knobs with ADR
defaults.

Red first: routing tests prove finder tasks receive the Luna adapter and
never exceed four calls; orchestration tests prove admission refusal of
the audit aborts before any Luna spend (reserve-first) and that a refused
optional Luna call is skipped with a structured reason; an adapter test
asserts the `odw.config.json` command lines pin the extension, provider,
model, and thinking level per lane, and that `adapters/pi/flex-tier.ts`
sets `service_tier` (cheap regression guards — the authoritative
effective-configuration evidence is the M0 capture-server and live-probe
transcripts, cited in `Artefacts and notes`, satisfying ADR 002's
verification clause).

Validation: full `make check` via scrutineer; dry run shows lanes, caps,
and pricing-table version.

### Milestone M5: Flex retry, backoff, deferral, and the timeout budget

In `main.ts`, wrap Luna and Terra calls in a bounded retry helper using
the ambient `sleep` primitive: on a retryable failure (classified from
the M0 failure-shape evidence; conservatively, timeouts and adapter
failures that do not parse as model refusals), back off exponentially
from `flexInitialBackoffSeconds` with positive jitter derived
deterministically from the attempt counter and call id. This is
reproducible pseudo-randomness, which suffices: jitter exists to
decorrelate concurrent reviews, and call ids differ across runs; a test
asserts two distinct call ids produce materially different offsets.
Exhaustion of an optional Luna call downgrades that pack with a recorded
reason; exhaustion of the required audit produces a structured deferred
result with `recorded` absent, and the CLI must not append history for a
deferred review. No fallback to standard processing exists anywhere.

Timeout budget (explicit, from the expert panel): the retry schedule's
worst case must fit inside the outer `odw run` wait. With the slice
defaults — `flexAttempts` 3 per call, backoff 30 s then 60 s, per-call
adapter timeout from M0 (expected around 120-300 s for Flex) — the
worst-case single-call chain is bounded and the whole review must fit the
harness's outer `--timeout 3600`. M5 lands a computed constant
(`worstCaseReviewSeconds`) and a test asserting it is below the outer
timeout the harness passes. The slice reduces ADR 002's default
`flexAttempts` from 6 to 3 for this reason; the `Decision Log` gains an
entry when the exact numbers are fixed against M0 measurements.

Red first: orchestration tests simulate persistent adapter failure and
assert the deferral shape, the absent record, and the retry count; a CLI
test proves a deferred result leaves `reviews.toml` untouched; the jitter
and timeout-budget tests above.

Validation: `make test` and the dry run pass.

### Milestone M6: contract, documentation, and gate closure

Update `docs/users-guide.md` (new limits, deferral behaviour and its
Luna re-pay cost, cost fields in results, the new dry-run shape),
`docs/developers-guide.md` (lane architecture, adapter contract, ledger
location), `docs/dakar-review-design.md` (mark the superseded
per-candidate verification and agent-wrapped phases; reconcile the
benchmark statement with ADR 002's per-review targets and this plan's
independent USD delivery goals), and `docs/roadmap.md` checkboxes for
completed 7.x tasks. Run the complete gate suite through a scrutineer
agent.

Validation: scrutineer reports every gate green, including Markdown gates.

### Milestone M7: live cost validation

First action on entering or resuming this milestone: sum the ledger
totals already recorded in `Artefacts and notes` and confirm the running
total against the USD 5.00 cap before starting the next corpus entry.

Create `scripts/live-review-harness.mjs` that: clones a corpus repository
into the scratchpad; fetches and checks out the pinned head SHA, failing
closed if the PR head no longer matches Table 1; asserts the resolved
state root is under its own scratch directory before invoking the CLI;
exports `CODEX_API_KEY` by reading `~/dakar-api-key.txt` inside the
process (never on a command line); runs
`dakar-review --base <sha> --head <sha> --state-root <scratch>
--timeout 3600` with telemetry to stderr; and writes the result JSON plus
extracted ledger to a scratch results directory.

Execute in strict cost order: tiny (`comenq` 140), then small
(`ddlint` 294), then medium (`frankie` 102). After each run, record in
this plan the ledger total, token counts, latency, findings summary, and
a hand assessment of usefulness. Proceed to `rstest-bdd` 593 and
`wireframe` 612 only if the summed spend permits within the cap —
remembering the Large entry is a partial-coverage review by construction
(Table 1 note). Run the oversize probe (`wireframe` 609) last and expect
a budget refusal or deferral, not a completed review.

Acceptance: at least one ordinary review (medium tier or above) completes
with genuinely useful findings — findings an implementation agent could
act on, judged by hand — at a reported ledger total below USD 0.25.
Record whether any run beat USD 0.11 (typical-case stretch; see Purpose).
If reviews complete but findings are vacuous, switch Luna finders to
`codex-luna-flex-medium`, rerun once, and record both ledgers.

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

M0 probes (from the scratchpad directory; the key never appears in the
command line — the direct probe reads it into the process environment):

```sh
OPENAI_API_KEY="$(cat ~/dakar-api-key.txt)" curl -s \
  https://api.openai.com/v1/responses \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.6-luna","service_tier":"flex",
       "input":"Reply with the single word: pong"}' \
  > flex-control.json

CODEX_API_KEY="$(cat ~/dakar-api-key.txt)" codex exec --json \
  --skip-git-repo-check --sandbox read-only \
  -c 'service_tier="flex"' -c 'model_reasoning_effort="low"' \
  --model gpt-5.6-luna \
  'Reply with the single word: pong' > codex-probe.jsonl 2>codex-probe.err
```

Expected: `flex-control.json` contains `"service_tier": "flex"` in the
response body and a usage object; `codex-probe.jsonl` ends with a
completed turn containing token counts. Inspect both for applied-tier
evidence per M0's acceptance.

M7 harness run (per corpus entry; illustrative for `comenq` 140):

```sh
node scripts/live-review-harness.mjs \
  --repo leynos/comenq --pr 140 \
  --work "$SCRATCHPAD/corpus" --out "$SCRATCHPAD/results"
```

Expected: stderr shows telemetry; `$SCRATCHPAD/results/comenq-140.json`
contains the result with `metrics.ledger` rows and
`metrics.ledgerTotalReportedUsd` below the target.

## Validation and acceptance

Quality criteria:

- Tests: `make test` passes; every new behaviour has a test that was
  observed failing first (record the red evidence per milestone in
  `Artefacts and notes`).
- Gates: `make check` (formatting, docstrings, markdownlint, nixie,
  typecheck, workflow freshness, ODW dry run, tests, spelling) passes at
  every commit, run via scrutineer.
- ADR 002 verification subset delivered by this slice: a blocking
  admission refusal launches no model calls; config, prepare, rendering,
  and recording launch no model calls; no ordinary review exceeds the
  Luna and audit caps; a retryable Flex failure retries with bounded
  backoff and never uses standard processing; an exhausted required audit
  leaves the head unrecorded; deterministic rendering is byte-stable for
  the same consolidated input; the M0 probe transcript is the
  effective-configuration evidence for `service_tier = "flex"`.
- Cost: one live medium-tier review below USD 0.25 reported provider
  spend (acceptance); below USD 0.11 (typical-case stretch, recorded
  either way).

Quality method: scrutineer gate reports with cited logs; live-run ledgers
captured under the scratchpad results directory and summarized in this
plan.

## Idempotence and recovery

All milestones are ordinary git commits on `api-key-support`; a failed
milestone is abandoned with `git restore`/`git stash`, never left half
staged. The live harness writes only under the scratchpad and an isolated
`--state-root` (both enforced in code; see M7); deleting those
directories fully resets live-validation state. Probe and harness runs
are idempotent and safe to repeat, at the cost of provider spend — sum
the recorded ledger totals in this plan before each repeat. A deferred
review retried after a Flex drought re-pays its Luna phase (see Decision
Log); space retries rather than tight-looping them. `make workflow-build`
is deterministic; regenerating the artefact is always safe.

## Artefacts and notes

To be populated during execution: M0 probe transcripts (with any key
material redacted), the M0 failure-shape record, red-test evidence per
milestone, live-run ledger summaries with a running spend total, and the
final cost table for the corpus.

## Interfaces and dependencies

No new runtime dependencies. No new dev dependencies are anticipated; any
exception triggers the Dependencies tolerance.

In `src/workflows/dakar-review/pricing.ts`:

```ts
export interface PricingBand {
  inputUsdPerMTok: number;
  cachedInputUsdPerMTok: number;
  cacheWriteUsdPerMTok: number;
  outputUsdPerMTok: number;
}
export interface PricingTable {
  version: string;
  usdPerGbp: number; // versioned exchange snapshot, not a constant
  rates: Record<string, PricingBand>; // key: `${model}:${serviceTier}`
}
export function estimateWorstCaseUsd(
  table: PricingTable,
  call: {
    model: string;
    serviceTier: string;
    inputTokens: number; // priced at the cache-write band (worst case)
    cachedInputTokens: number;
    maxOutputTokens: number;
  },
): number;
```

Worked examples (the M1 red tests assert these verbatim):

- One Luna Flex transaction, 12,000 input / 0 cached / 750 output:
  12,000 x 0.625 / 1,000,000 + 750 x 3.00 / 1,000,000 = 0.0075 + 0.00225
  = USD 0.00975.
- One Terra Flex audit, 48,000 input / 0 cached / 2,500 output:
  48,000 x 1.5625 / 1,000,000 + 2,500 x 7.50 / 1,000,000
  = 0.075 + 0.01875 = USD 0.09375.
- Worst case, four Luna plus one Terra: 4 x 0.00975 + 0.09375
  = USD 0.13275.

In `src/workflows/dakar-review/admission.ts`:

```ts
export interface AdmissionState {
  budgetUsd: number; // hard GBP budget x usdPerGbp from the table
  reservedAuditUsd: number;
  spentUsd: number; // sum of admitted worst-case estimates
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

Admission inequalities (normative; the M1 tests assert both):

- A `luna-transaction` is admitted if and only if
  `spentUsd + worstCaseUsd + reservedAuditUsd <= budgetUsd`.
- A `terra-audit` is admitted if and only if
  `spentUsd + worstCaseUsd <= budgetUsd` — the audit consumes its own
  reservation; it is not double-counted.

In `types.ts`, additively:

```ts
export interface WorkflowArgs {
  // existing fields unchanged, plus:
  prepared?: PreparedReview; // required by the workflow from M2 stage b
}
export interface LedgerEntry {
  callId: string;
  phase: string;
  lane: 'luna-flex' | 'terra-flex' | 'standard';
  model: string;
  serviceTier: string;
  reasoningEffort: string;
  estimatedWorstCaseUsd: number;
  reportedUsage?: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
  };
  reportedUsd?: number; // reportedUsage priced with the table
  pricingTableVersion: string;
  attempts: number;
}
```

The `standard` lane value exists for M3's interim standard-tier audit and
keeps the ledger honest if a future policy reintroduces standard calls;
`sol`-class models need no new lane value, only a pricing-table row.

In `schemas.ts`, the audit response schema (M3):

```ts
export const AUDIT_SCHEMA = {
  type: 'object',
  required: ['verdicts'],
  properties: {
    verdicts: { type: 'array', items: VERDICT_SCHEMA_WITH_CLUSTER },
    summary: { type: 'string' },
  },
};
```

where `VERDICT_SCHEMA_WITH_CLUSTER` is the existing per-item
`VERDICT_SCHEMA` plus an optional `clusterId` string. The workflow result
gains additive `metrics.ledger: LedgerEntry[]`,
`metrics.ledgerTotalEstimatedUsd` (sum of admitted worst-case estimates,
the admission audit trail), `metrics.ledgerTotalReportedUsd` (sum of
`reportedUsd`; the M7 acceptance number), and `metrics.routingPolicy`.
The workflow echoes `headCommit`, `reviewBase`, `commitCount`, and
`changedFiles` from `args.prepared` back in its result unchanged.

## Revision note (2026-07-18)

Revised after the three-panel expert review (structure and contracts; cost
and failure modes; alternatives and viability). Material changes: cost-goal
framing corrected (USD goals declared independent of ADR 002's GBP targets;
worst case USD 0.133 stated; stretch goal identified as typical-case);
cache-write band added to the pricing interfaces and worked examples;
admission inequalities made normative; M0 strengthened to require
provider-side applied-tier evidence and a failure-shape capture; the old
M3 split into M3 (audit on standard adapters) and M4 (Flex lanes) for
fault isolation; M2 split into four stages with a test-harness refactor
first and the `legacy-route-final` tag recorded; audit response given its
own `AUDIT_SCHEMA`; `WorkflowArgs.prepared` contract and result echo
pinned; skip-shape and dry-run deviations from ADR 001 recorded as
decisions; timeout budget made explicit with `flexAttempts` reduced to 3
for the slice; corpus SHAs pinned with fail-closed checks; harness
state-root guard made code-level; ledger gained `reportedUsd` and the
`standard` lane; escalation adapter `codex-luna-flex-medium`
pre-registered; living-document updates added to every milestone's exit
criteria. Remaining work is unchanged in intent: prove plumbing, build
the cost machinery, take over deterministic phases, land the audit, then
Flex, then validate live.
