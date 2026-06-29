# Implement the routed divide-and-conquer review workflow

This ExecPlan (execution plan) is a living document. The sections
`Constraints`, `Tolerances`, `Risks`, `Progress`, `Surprises & Discoveries`,
`Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work
proceeds.

Status: DRAFT

## Purpose / big picture

The goal is to replace the current equal full-diff fan-out review with a first
usable routed review workflow. After this change, an agent working on a Dakar
branch can run `odw` against `workflows/coderabbit-code-review.js` and receive
one actionable code-review report for only the commits that have not already
been reviewed on that branch.

Success is observable when the workflow prepares an unreviewed range, builds a
bounded task graph from changed files, sends scoped review tasks to appropriate
Codex models, verifies proposed findings with `gpt-5.5` high, synthesizes a
deduplicated reviewer-facing report, records the review in `reviews.toml`, and
returns JSON containing `reportMarkdown`, accepted findings, discarded
findings, task metrics, and the review-history path.

## Constraints

- Keep `workflows/coderabbit-code-review.js` valid ODW workflow JavaScript:
  literal `meta`, no workflow-level imports, injected primitives only, and
  schema-based handoffs for agent outputs.
- Keep review range and XDG state behavior delegated to
  `scripts/review-state.mjs`; do not reimplement git or filesystem logic in the
  ODW workflow.
- Keep the workflow read-only with respect to repository files. The only
  persistent write is appending review history after synthesis.
- Do not add an external runtime dependency. The first pass must continue to
  use Node built-ins, Make, the existing ODW CLI, and the Codex adapter.
- Preserve the existing default model family:
  `gpt-5.5` low/medium/high, `gpt-5.4-mini`, and
  `gpt-5.3-codex-spark`.
- Preserve `dryRun` so `make check` can validate workflow syntax without
  launching review agents.
- Follow Red-Green-Refactor for production changes. Add the focused failing
  test before modifying the workflow.
- Do not change the public `scripts/review-state.mjs prepare` or `record`
  command-line contract unless the plan is revised and approved.

## Tolerances (exception triggers)

- Scope: if the implementation needs changes to more than five repository
  files excluding this ExecPlan, stop and escalate.
- Size: if production JavaScript changes exceed roughly 350 net new lines,
  stop and propose a smaller first milestone.
- Interface: if ODW requires a different public workflow invocation than
  `odw run workflows/coderabbit-code-review.js --source . --wait`, stop and
  escalate.
- Dependencies: if any new npm package, global binary, hosted service, or
  database is required, stop and escalate.
- State: if review history cannot remain in the XDG state path computed by
  `scripts/review-state.mjs`, stop and escalate.
- Iterations: if the focused workflow test or `make check` still fails after
  three implementation attempts, stop and document options.
- Live agent availability: if a live non-dry-run smoke test fails because a
  requested model or adapter is unavailable, do not change the model contract
  silently. Record the failure and validate with dry-run plus unit tests.

## Risks

- Risk: ODW workflows cannot call local shell helpers directly; they must ask a
  Codex agent to run `scripts/review-state.mjs`.
  Severity: medium.
  Likelihood: high.
  Mitigation: Keep the existing prepare and record prompts, make their expected
  command output schema explicit, and preserve dry-run validation.

- Risk: A first-pass routed task graph may be too shallow to catch every
  semantic issue.
  Severity: medium.
  Likelihood: medium.
  Mitigation: Make the returned report explicit about accepted and discarded
  findings, cap claims to changed-range evidence, and record metrics that show
  which task types survive verification.

- Risk: Live agent output may not follow schema perfectly.
  Severity: medium.
  Likelihood: medium.
  Mitigation: Keep schemas small, use literal enums, normalize candidates in
  workflow JavaScript, and filter null results from `parallel()` and
  `pipeline()`.

- Risk: A full non-dry-run workflow may be slow or costly to validate locally.
  Severity: low.
  Likelihood: medium.
  Mitigation: Use dry-run and Node tests as required gates; treat live review as
  a manual acceptance smoke when credentials and model access are available.

## Progress

- [x] (2026-06-29T22:37:30Z) Inspected the current workflow, helper, tests,
  package scripts, and Makefile.
- [x] (2026-06-29T22:37:30Z) Confirmed the existing workflow still sends the
  whole diff to every default model and synthesizes those full reviews.
- [x] (2026-06-29T22:37:30Z) Drafted this ExecPlan.
- [ ] Receive explicit approval to begin implementation.
- [ ] Add the focused red test for routed dry-run/workflow contract.
- [ ] Implement the routed task graph, scoped task prompts, candidate
  normalization, verification, and report synthesis.
- [ ] Run focused tests, `make check`, and an ODW dry-run smoke.
- [ ] Update this ExecPlan with red/green/refactor evidence and mark complete.

## Surprises & discoveries

- Observation: The current `workflows/coderabbit-code-review.js` is still a
  homogeneous fan-out design.
  Evidence: It maps every default model over the same `reviewPrompt(spec,
  prepared)` and sends each prompt the same review range and changed file list.
  Impact: The implementation can be focused in one workflow file while keeping
  `scripts/review-state.mjs` stable.

## Decision log

- Decision: Draft the ExecPlan and wait for approval before implementation.
  Rationale: The `execplans` skill requires a draft approval gate before code
  execution, even though the user requested plan and implementation together.
  Date/Author: 2026-06-29T22:37:30Z / Codex.

- Decision: Use a deterministic JavaScript task planner inside the ODW file
  rather than asking an agent to invent the first task graph.
  Rationale: ODW can run plain helper functions in the workflow file after
  `prepare` returns structured data. A deterministic planner makes dry-run
  tests meaningful and keeps fan-out bounded.
  Date/Author: 2026-06-29T22:37:30Z / Codex.

- Decision: Use one `gpt-5.5` high verification pass per normalized candidate
  in the first implementation.
  Rationale: This delivers the core proposer/verifier split without adding
  cross-model debate or multiple refuters before the workflow is proven
  runnable.
  Date/Author: 2026-06-29T22:37:30Z / Codex.

## Outcomes & retrospective

No implementation has started. This section will be updated after the approved
implementation passes validation.

## Context and orientation

This repository is a small Node/ODW project. ODW means Open Dynamic Workflow:
a JavaScript workflow file run by the `odw` CLI, where primitives such as
`agent`, `parallel`, `pipeline`, `phase`, and `args` are injected by the
runtime. An ODW file cannot import Node modules directly.

The key files are:

- `workflows/coderabbit-code-review.js`: the ODW workflow to update.
- `scripts/review-state.mjs`: a Node helper that computes the unreviewed git
  range and appends review entries to `reviews.toml`.
- `tests/review-state.test.mjs`: current Node tests for the state helper.
- `package.json`: npm scripts for tests and ODW dry-run.
- `Makefile`: repository quality gates; `make check` runs formatting checks,
  Node syntax checks, ODW dry-run, tests, Markdown lint, and Mermaid diagram
  validation.
- `examples/df12-code-review.yaml`: sample CodeRabbit policy file used by the
  workflow default.

The existing workflow has four phases: Prepare, Review, Synthesize, and Record.
It asks a Codex agent to run `scripts/review-state.mjs prepare`, sends the same
whole-diff review prompt to all default models with `parallel()`, asks a
synthesis agent to combine those reviews, then asks a Codex agent to run
`scripts/review-state.mjs record`.

The first pass keeps the Prepare and Record mechanism, but replaces the Review
phase with a routed task graph. A task graph is a list of task objects. Each
task object has a stable `taskId`, a `kind`, a list of files, a model
assignment, a prompt boundary, a maximum finding count, and a verification
policy.

## Plan of work

Stage A is this draft. No production code changes occur before approval.

Stage B adds a focused red test in a new file,
`tests/workflow-dry-run.test.mjs`. The test runs:

```bash
npm run odw:dry-run
```

It expects dry-run output to include a routed workflow contract with fields
such as `workflowVersion`, `taskKinds`, `defaultTaskGraph`, `candidateSchema`,
`verdictSchema`, and `synthesisSchema`. This fails against the current
workflow because dry-run only returns `ok`, `dryRun`, `config`, `base`, `head`,
and `models`.

Stage C updates `workflows/coderabbit-code-review.js`.

The workflow keeps `meta.name = 'coderabbit-code-review'` and adds a planning
phase after Prepare. It defines small schemas for task review candidates,
verification verdicts, and final synthesis. It adds helper functions inside
the workflow file:

- `classifyPath(path)`: returns `source`, `test`, `docs`, `config`,
  `dependency`, or `unknown`.
- `buildTaskGraph(prepared)`: groups changed files into bounded tasks and
  assigns each task to `gpt-5.3-codex-spark`, `gpt-5.4-mini`, `gpt-5.5`
  medium, or `gpt-5.5` high according to path class and risk.
- `taskPrompt(task, prepared)`: creates a scoped prompt that includes the
  review range, relevant changed files, CodeRabbit config path, allowed
  commands, maximum findings, and an explicit `no_findings` option.
- `candidateKey(candidate)`: returns a deterministic dedupe key from path,
  line, title, and task kind.
- `normalizeCandidates(taskResults)`: flattens review results, adds task
  metadata, drops malformed candidates, and caps candidate count.
- `discardReasonCounts(verdicts)`: summarizes rejected candidates by reason.

The review phase runs independent task prompts with `parallel()`. Each task
returns a small structured result containing `taskId`, `summary`, `candidates`,
and task metrics.

The verification phase uses `pipeline()` over normalized candidates. Each
candidate is sent to `gpt-5.5` high with an adversarial prompt: try to refute
the candidate using the changed-range evidence, and accept it only if it is
actionable, in scope, and supported by source or tool evidence. The verdict
schema includes `accepted`, `status`, `reason`, `acceptedSeverity`, and
`evidenceChecked`.

The synthesis phase asks `gpt-5.5` high to produce one reviewer-facing report
from accepted candidates and discarded-candidate metrics. The workflow returns
the report as `reportMarkdown` and includes machine-readable `findings`,
`discarded`, `taskGraph`, and `metrics`.

The record phase writes the review history exactly once after synthesis. The
recorded metrics include task count, candidate count, accepted count,
discarded count, discard reason counts, model assignments, diff stat, and
warnings from prepare.

Stage D refactors only if the first implementation becomes repetitive or hard
to test. Any refactor must preserve the focused test and `make check`.

## Concrete steps

Run all commands from `/data/leynos/Projects/dakar`.

First, confirm the current branch and clean working tree:

```bash
git status --short --branch
```

Expected output before implementation:

```plaintext
## initial-workflow...origin/initial-workflow
```

After approval, add `tests/workflow-dry-run.test.mjs` and run the red test:

```bash
node --test tests/workflow-dry-run.test.mjs
```

Expected red result before implementation is one failing assertion showing that
the dry-run output does not expose the routed workflow contract, for example:

```plaintext
not ok 1 - dry-run exposes routed workflow contract
```

Then implement the workflow changes in
`workflows/coderabbit-code-review.js` and run the focused test again:

```bash
node --test tests/workflow-dry-run.test.mjs
```

Expected green result:

```plaintext
ok 1 - dry-run exposes routed workflow contract
```

Run the existing helper tests:

```bash
npm test
```

Expected output includes:

```plaintext
# pass 5
# fail 0
```

The exact pass count may be higher if more tests are added, but failures must
be zero.

Run the full gate:

```bash
make check
```

Expected output ends with successful Node tests, Markdown lint, and Mermaid
validation. No command in `make check` should require live model calls because
`npm run odw:dry-run` uses `dryRun`.

For manual acceptance when model access is available, run:

```bash
odw run workflows/coderabbit-code-review.js --source . --wait --timeout 900 \
  --args '{"config":"examples/df12-code-review.yaml","base":"origin/main"}'
```

Expected live result shape:

```json
{
  "ok": true,
  "reportMarkdown": "## Code review\n...",
  "findings": [],
  "discarded": [],
  "recorded": { "ok": true }
}
```

The result may contain findings. Each finding must include severity, path,
title, detail, and evidence. If no actionable issues are found, the report must
say that no blocking findings were accepted and still record the review.

## Validation and acceptance

The Red-Green-Refactor evidence must be recorded here during implementation:

- Red command: `node --test tests/workflow-dry-run.test.mjs`.
  Expected failure: the current dry-run output lacks routed workflow contract
  fields such as `taskKinds`, `defaultTaskGraph`, and verification schemas.
- Green command: `node --test tests/workflow-dry-run.test.mjs`.
  Expected pass: the new dry-run output exposes the routed contract and default
  task graph.
- Refactor command sequence: `npm test` and `make check`.
  Expected pass: all tests, syntax checks, dry-run, Markdown lint, and diagram
  validation succeed.

Quality criteria:

- `npm test` passes.
- `make check` passes.
- `npm run odw:dry-run` returns `ok: true` and includes routed task contract
  fields.
- A live ODW run with model access returns one `reportMarkdown` string and
  machine-readable findings/discards for the unreviewed range.
- Running the workflow twice at the same `HEAD` skips the second run through
  existing review-history behavior.

Quality method:

- Use Node's built-in test runner for contract tests.
- Use `odw run ... --wait --args '{"dryRun":true}'` for ODW syntax and dry-run
  contract validation.
- Use `make check` as the final local quality gate.

## Idempotence and recovery

The implementation is safe to retry. The red test is additive. The workflow
itself is read-only until the final Record phase, and `scripts/review-state.mjs`
already skips a branch head that has been recorded.

For live smoke tests, pass `stateRoot` to isolate review history:

```bash
odw run workflows/coderabbit-code-review.js --source . --wait --timeout 900 \
  --args '{"config":"examples/df12-code-review.yaml","base":"origin/main","stateRoot":"/tmp/dakar-review-state"}'
```

If a live run records an unwanted test review, remove only that temporary
`stateRoot`. Do not delete real `$XDG_STATE_HOME/dakar` entries unless the user
explicitly asks.

## Artifacts and notes

Current dry-run output before this implementation is:

```json
{
  "ok": true,
  "dryRun": true,
  "config": "examples/df12-code-review.yaml",
  "base": "origin/main",
  "head": "HEAD",
  "models": [
    "gpt-5.5/low",
    "gpt-5.5/medium",
    "gpt-5.5/high",
    "gpt-5.4-mini/medium",
    "gpt-5.3-codex-spark/medium"
  ]
}
```

The implementation should evolve dry-run into a useful contract preview rather
than a bare config echo.

## Interfaces and dependencies

`workflows/coderabbit-code-review.js` must expose the same ODW entrypoint:

```javascript
export const meta = {
  name: 'coderabbit-code-review',
  // ...
}
```

The workflow args after implementation are:

- `config`: CodeRabbit YAML path. Default:
  `examples/df12-code-review.yaml`.
- `base`: base ref for merge-base calculation. Default: `origin/main`.
- `head`: reviewed head ref. Default: `HEAD`.
- `stateRoot`: optional state-root override for tests and isolated smoke runs.
- `dryRun`: when true, returns routed workflow configuration without launching
  agents.
- `maxTasks`: optional cap for planned review tasks. Default: 8.
- `maxCandidates`: optional cap for normalized candidate findings. Default:
  30.
- `maxFindings`: optional cap for accepted final findings. Default: 20.
- `models`: optional model assignment override for tests or future routing.
- `synthesisModel`: model used for prepare, verification, synthesis, and
  record prompts. Default: `gpt-5.5`.

The final live workflow return object must include:

```javascript
{
  ok: true,
  stateFile: string,
  reviewBase: string,
  headCommit: string,
  commitCount: number,
  changedFiles: string[],
  taskGraph: object[],
  taskResults: object[],
  findings: object[],
  discarded: object[],
  reportMarkdown: string,
  metrics: object,
  recorded: object
}
```

`tests/workflow-dry-run.test.mjs` should use Node built-ins only. It may invoke
`npm run odw:dry-run` or `odw run workflows/coderabbit-code-review.js --source
. --wait --timeout 20 --args '{"dryRun":true}'` and parse the JSON object from
the command output.

## Revision note

Initial draft written on 2026-06-29. It captures the first-pass implementation
path for a routed ODW code-review workflow and pauses before implementation
pending explicit approval, as required by the `execplans` skill.
