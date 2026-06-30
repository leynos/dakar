# Implement the routed divide-and-conquer review workflow

This ExecPlan (execution plan) is a living document. The sections
`Constraints`, `Tolerances`, `Risks`, `Progress`, `Surprises & Discoveries`,
`Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work
proceeds.

Status: COMPLETE

## Purpose / big picture

The goal is to replace the current equal full-diff fan-out review with a first
usable routed review workflow. After this change, an agent working on a Dakar
branch can run `odw` against `workflows/dakar-review.js` and receive
one actionable code-review report for only the commits that have not already
been reviewed on that branch.

Success is observable when the workflow prepares an unreviewed range, builds a
bounded task graph from changed files, sends scoped review tasks to appropriate
Codex models, verifies proposed findings with `gpt-5.5` high, synthesizes a
deduplicated reviewer-facing report, records the review in `reviews.toml`, and
returns JSON containing `reportMarkdown`, accepted findings, discarded
findings, task metrics, and the review-history path.

## Constraints

- Keep `workflows/dakar-review.js` valid ODW workflow JavaScript:
  literal `meta`, no workflow-level imports, injected primitives only, and
  schema-based handoffs for agent outputs.
- Keep review range and XDG state behaviour delegated to
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
  `odw run workflows/dakar-review.js --source . --wait`, stop and
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
- [x] (2026-06-29T22:45:17Z) Received explicit approval to begin
  implementation, with additional documentation requirements for user,
  developer, and design-facing behaviour.
- [x] (2026-06-29T22:45:17Z) Added
  `tests/workflow-dry-run.test.mjs` and observed the expected red failure:
  dry-run output had no `workflowVersion`.
- [x] (2026-06-29T22:45:17Z) Implemented the routed task graph, scoped task
  prompts, dry-run contract, candidate normalization, verification, and report
  synthesis in `workflows/dakar-review.js`.
- [x] (2026-06-29T22:45:17Z) Documented user-facing behaviour in
  `docs/users-guide.md`, maintainer conventions in `docs/developers-guide.md`,
  and component architecture updates in `docs/design/initial-workflow.md`.
- [x] (2026-06-29T23:11:42Z) Found that live ODW smoke runs need an explicit
  `repoRoot` because the copied workspace used by agents does not include
  `.git`.
- [x] (2026-06-29T23:11:42Z) Added `repoRoot` to the workflow contract and
  changed prepare, finder, and verifier command prompts to use the real git
  checkout via `git -C`.
- [x] (2026-06-30T00:03:52Z) Ran a live smoke review with isolated state; it
  completed and recorded history, and its accepted finding showed that
  reasoning-qualified model strings were not being passed to ODW agent calls.
- [x] (2026-06-30T00:03:52Z) Changed review, verification, synthesis, prepare,
  and record agent calls to select reasoning-specific ODW adapters while
  passing plain Codex model ids.
- [x] (2026-06-30T00:13:06Z) Ran focused dry-run test, `npm test`,
  `npm run odw:dry-run`, live ODW smoke, and `make check` successfully.
- [x] (2026-06-30T00:13:06Z) Updated this ExecPlan with validation evidence
  and marked it complete.
- [x] (2026-06-30T01:12:00Z) Added optional CLI telemetry mode that starts ODW
  in the background, follows live logs on standard error, then emits the final
  workflow result on standard output.

## Surprises & discoveries

- Observation: The current `workflows/dakar-review.js` is still a
  homogeneous fan-out design.
  Evidence: It maps every default model over the same `reviewPrompt(spec,
  prepared)` and sends each prompt the same review range and changed file list.
  Impact: The implementation can be focused in one workflow file while keeping
  `scripts/review-state.mjs` stable.

- Observation: `node --check workflows/dakar-review.js` is not a
  valid syntax gate for ODW workflow files.
  Evidence: Node reports `SyntaxError: Illegal return statement` at the
  top-level `return`, while `odw run workflows/dakar-review.js
  --source . --wait --timeout 20 --args '{"dryRun":true}'` succeeds.
  Impact: Workflow validation must use ODW dry-run rather than direct Node
  syntax checking.

- Observation: ODW copy-mode agent workspaces may not contain `.git`.
  Evidence: A live smoke run failed in the Prepare phase with
  `fatal: not a git repository` from `git -C /tmp/odw-ws-.../dakar rev-parse
  HEAD`.
  Impact: Live workflow runs need a `repoRoot` argument pointing to the real
  checkout, and all git-backed helper or diff prompts must use that path.

- Observation: The workflow's own live smoke review found one real defect in
  the first implementation.
  Evidence: Run `20260629-235614-6ac248` completed with one accepted finding:
  the workflow displayed `gpt-5.5/high` in prompts and metrics but passed only
  `gpt-5.5` to the ODW `agent()` model option.
  Impact: The workflow now selects reasoning-specific ODW adapters at every
  agent-call boundary.

- Observation: Passing `gpt-5.5/high` as the `model` option is rejected by the
  backend for this ChatGPT-account Codex setup.
  Evidence: `codex exec -m gpt-5.5/high ...` failed with
  `The 'gpt-5.5/high' model is not supported when using Codex with a ChatGPT
  account`, while `codex exec -m gpt-5.5 -c
  'model_reasoning_effort="high"' ...` produced output.
  Impact: The implementation must use custom ODW adapters that pass Codex
  config for reasoning effort, rather than encoding reasoning in the model id.

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

- Decision: Treat `docs/design/initial-workflow.md` as the component
  architecture document for this first pass, and add `docs/users-guide.md` and
  `docs/developers-guide.md` for public and maintainer-facing guidance.
  Rationale: The repository already uses `docs/design/initial-workflow.md` as
  the design and architecture source of truth. Adding a separate architecture
  document would exceed the approved scope without adding useful separation at
  this stage.
  Date/Author: 2026-06-29T22:45:17Z / Codex.

- Decision: Add `repoRoot` rather than switching the workflow to an implicit
  ODW workspace mode.
  Rationale: The ODW authoring contract says copy mode is the default, and
  copied workspaces are not a reliable git handoff channel. Passing the real
  checkout path makes range preparation and diff evidence explicit while
  keeping the workflow read-only.
  Date/Author: 2026-06-29T23:11:42Z / Codex.

- Decision: Add repo-local ODW adapters for Codex reasoning levels.
  Rationale: ODW custom adapters can include fixed Codex config arguments.
  `codex-low`, `codex-medium`, and `codex-high` make reasoning effort a runtime
  choice while keeping `model` as a backend-supported plain model id.
  Date/Author: 2026-06-30T00:03:52Z / Codex.

- Decision: Keep `dakar-review` telemetry opt-in and stderr-only.
  Rationale: Agents and humans need visible ODW progress during long reviews,
  but automation depends on standard output containing only the final workflow
  result. Running ODW in the background and following logs preserves both use
  cases without changing the default quiet mode.
  Date/Author: 2026-06-30T01:12:00Z / Codex.

## Outcomes & retrospective

The first routed divide-and-conquer review workflow is implemented. A user can
run `odw run workflows/dakar-review.js --source . --wait` with
`repoRoot` pointing at their real checkout and receive a single JSON review
result containing `reportMarkdown`, accepted findings, discarded candidates,
task graph data, metrics, and review-history recording status.

The implementation keeps deterministic review range and TOML state writes in
`scripts/review-state.mjs`, uses a JavaScript task planner for bounded review
tasks, routes finder work to model/adapter pairs, verifies candidates with a
high-reasoning Codex adapter, and records only after synthesis. The live smoke
run proved the workflow can prepare, review, verify, synthesize, discard a stale
candidate, and write isolated review history.

The main lesson is that ODW model routing and Codex reasoning effort are
separate concerns. The built-in ODW Codex adapter forwards only `model`, so the
repo now owns `odw.config.json` adapters for low, medium, and high reasoning.
The second lesson is that ODW copy workspaces should be treated as read-only
snapshots without git metadata; `repoRoot` is required for robust git evidence.
The follow-up CLI lesson is that live supervision belongs on standard error:
telemetry can satisfy interactive agents without weakening the JSON stdout
contract.

## Context and orientation

This repository is a small Node/ODW project. ODW means Open Dynamic Workflow:
a JavaScript workflow file run by the `odw` CLI, where primitives such as
`agent`, `parallel`, `pipeline`, `phase`, and `args` are injected by the
runtime. An ODW file cannot import Node modules directly.

The key files are:

- `workflows/dakar-review.js`: the ODW workflow to update.
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

Stage C updates `workflows/dakar-review.js`.

The workflow keeps `meta.name = 'dakar-review'` and adds a planning
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
`workflows/dakar-review.js` and run the focused test again:

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
odw run workflows/dakar-review.js --source . --wait --timeout 900 \
  --args '{"config":"examples/df12-code-review.yaml","base":"origin/main","repoRoot":"/data/leynos/Projects/dakar"}'
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
  Observed failure on 2026-06-29T22:45:17Z:
  `actual undefined`, `expected 'divide-and-conquer-v1'`.
- Green command: `node --test tests/workflow-dry-run.test.mjs`.
  Expected pass: the new dry-run output exposes the routed contract and default
  task graph.
  Observed pass on 2026-06-29T22:45:17Z and again on
  2026-06-30T00:08:20Z.
- Refactor command sequence: `npm test` and `make check`.
  Expected pass: all tests, syntax checks, dry-run, Markdown lint, and diagram
  validation succeed.
  Observed pass for `npm test` on 2026-06-30T00:08:20Z and for `make check`
  on 2026-06-30T00:13:06Z.

Live smoke command:

```bash
odw run workflows/dakar-review.js --source . --wait --timeout 900 \
  --args '{"config":"examples/df12-code-review.yaml","base":"origin/main","repoRoot":"/data/leynos/Projects/dakar","stateRoot":"/tmp/dakar-review-smoke-adapters","maxTasks":1,"maxCandidates":1,"maxFindings":1}'
```

Observed result on 2026-06-30T00:13:06Z: run
`20260630-000828-d9d5a6` returned `ok: true`, recorded history under
`/tmp/dakar-review-smoke-adapters/dakar/leynos/dakar/initial-workflow/reviews.toml`,
used `codex-high` for the source task, verified one stale candidate as
`not_applicable`, and produced a pass report with no accepted findings.

Quality criteria:

- `npm test` passes.
- `make check` passes.
- `npm run odw:dry-run` returns `ok: true` and includes routed task contract
  fields.
- A live ODW run with model access returns one `reportMarkdown` string and
  machine-readable findings/discards for the unreviewed range.
- Running the workflow twice at the same `HEAD` skips the second run through
  existing review-history behaviour.

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
odw run workflows/dakar-review.js --source . --wait --timeout 900 \
  --args '{"config":"examples/df12-code-review.yaml","base":"origin/main","repoRoot":"/data/leynos/Projects/dakar","stateRoot":"/tmp/dakar-review-state"}'
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

`workflows/dakar-review.js` must expose the same ODW entrypoint:

```javascript
export const meta = {
  name: 'dakar-review',
  // ...
}
```

The workflow args after implementation are:

- `config`: CodeRabbit YAML path. Default:
  `examples/df12-code-review.yaml`.
- `repoRoot`: real git checkout path used by prepare and diff prompts.
  Default: `.`; live ODW runs should pass an absolute path.
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
- `synthesisReasoning`: reasoning suffix used when `synthesisModel` has no
  suffix. Default: `high`.

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
`npm run odw:dry-run` or `odw run workflows/dakar-review.js --source
. --wait --timeout 20 --args '{"dryRun":true}'` and parse the JSON object from
the command output.

## Revision note

Initial draft written on 2026-06-29. It captures the first-pass implementation
path for a routed ODW code-review workflow and pauses before implementation
pending explicit approval, as required by the `execplans` skill.

Final update on 2026-06-30 records the implemented workflow, custom ODW Codex
adapters, `repoRoot` live-run requirement, focused and full validation, and the
successful isolated live smoke run.
