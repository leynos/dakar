# Developer's guide

This guide is for maintainers working on Dakar's local ODW review workflow.
The primary architecture reference is
[`docs/dakar-review-design.md`](dakar-review-design.md). The initial design
record remains at [`docs/design/initial-workflow.md`](design/initial-workflow.md),
the accepted compilation boundary is recorded in
[`docs/adr-001-compile-odw-workflow-from-typescript.md`](adr-001-compile-odw-workflow-from-typescript.md),
and delivery plans live under [`docs/execplans/`](execplans/).

## 1. Local validation

Run the full local gate before committing changes:

```bash
make check
```

This gate checks whitespace, Node syntax for ordinary Node modules, ODW
dry-run, Node tests, Markdown lint, en-GB-oxendict spelling, and Mermaid
diagrams.

Use focused commands while iterating:

```bash
node --test tests/cli.test.mjs
node --test tests/review-state.test.mjs
node --test tests/workflow-dry-run.test.mjs
npm run odw:dry-run
```

Do not use `node --check workflows/dakar-review.js` as a workflow
syntax gate. ODW files permit top-level `return`, which ordinary Node syntax
checking rejects. Use `odw run ... --args '{"dryRun":true}'` instead.

### Spelling policy

Run `make spelling` to enforce en-GB-oxendict spelling. The dictionary-based
Typos scan checks tracked Markdown, while the phrase-correction check covers the
whole tracked repository, including JavaScript, tests and workflow files. The
generated and tracked `typos.toml` starts from the shared Oxford dictionary.
Its builder refreshes the untracked `.typos-oxendict-base.toml` cache and
metadata only when the shared dictionary is newer, so the last fetched base
remains usable in a network-restricted checkout.

Keep repository-specific formal names and machine interfaces in
`typos.local.toml`. Run `make spelling-config-write` to regenerate the tracked
configuration and `make spelling-config` to verify it. Never edit generated
entries by hand.

## 2. Workflow implementation conventions

`workflows/dakar-review.js` must remain a pure ODW runtime artefact:

- keep a literal `meta` export;
- do not add Node imports;
- use injected ODW primitives such as `agent`, `parallel`, `pipeline`,
  `sleep`, and `phase`;
- use JSON Schemas for every agent output consumed by workflow JavaScript;
- filter null or failed slots after `parallel()` and `pipeline()`;
- keep reductions deterministic and independent of completion order.

The maintainable workflow source lives in `src/workflows/dakar-review/`; the
compiler preserves the runtime contract in the committed artefact. Never
hand-edit `workflows/dakar-review.js`. Edit the source tree, run
`make workflow-build`, and commit source and artefact together. Run
`make workflow-freshness` to prove that the committed artefact matches its
inputs without rewriting it.

The source tree has these responsibilities:

- `meta.js`: one literal metadata export, concatenated verbatim;
- `main.ts`: the composition root, phase transitions (Plan, Review, Audit),
  admission dispatch, retry orchestration, metrics, record input, and final
  result;
- `odw-globals.d.ts`: ambient declarations for every injected ODW primitive;
- `types.ts` and `schemas.ts`: erased cross-module types and runtime JSON
  Schemas, including `AUDIT_SCHEMA` and the ledger, admission-refusal, and
  Luna-downgrade shapes;
- `config.ts` and `model-routing.ts`: argument defaults, the Flex lane roles
  (`luna`, `luna-medium`, `terra`), and adapter/model selection;
- `pricing.ts`: the versioned pricing table and `estimateWorstCaseUsd()`,
  which prices uncached input at the cache-write band (ADR 002's worst
  case);
- `admission.ts`: the reserve-first budget controller (`admit()`) that
  enforces `budgetGbp` before any Flex call is dispatched;
- `retry.ts`: the pure Flex retry schedule — deterministic FNV-1a jitter,
  exponential backoff, the conservative retryable classifier, and
  `worstCaseReviewSeconds()`;
- `shell.ts`: the shared shell-word quoting authority;
- `task-graph.ts`: path classification, finder-pack bounding
  (`buildFlexFinderPlan()`), and task creation;
- `candidates.ts`: candidate containment, normalization, audit compaction
  (`compactForAudit()`: dedup, severity ranking, `over_audit_cap`
  discards), and verdict reduction; and
- `prompts.ts`: stable prompt prefixes and dynamic prompt tails, including
  `auditPrompt()`.

The internally facing interfaces follow the same ownership boundaries.
`resolveWorkflowConfig()` returns the frozen `WorkflowConfig` passed into
routing and planning; it also carries the ADR 002 Flex knobs (budget, Flex
limits, retry schedule) alongside the existing task and candidate limits.
`modelForRole()`, `flexLaneRole()`, and the other model-routing helpers map
that configuration to model, adapter, and service-tier selections. The host
selects each Flex lane; agents may not promote themselves to a costlier
model or service tier. `buildTaskGraph()` and `buildFlexFinderPlan()`
consume `TaskGraphConfig`; they return `ReviewTask` objects without calling
ODW. Candidate processing flows through `normalizeCandidates()`,
`candidatesForVerification()`, `compactForAudit()`,
`acceptedFromVerdicts()`, and `discardedFromVerdicts()`. Prompt functions
take an explicit `PromptContext`, and `shellWord()` is the only shell-word
quoting interface. Runtime JSON Schemas are exported from `schemas.ts`,
while shared compile-time shapes are exported from `types.ts`. These
modules are pure; `main.ts` alone calls the ambient ODW primitives, the
`sleep()` retry helper, and owns phase sequencing.

Document each module with a top-of-file `/** @file … */` block, and document
exported functions plus non-obvious trust, loader, and state boundaries with
JSDoc. The generated `workflows/dakar-review.js` artefact and ambient
declarations are outputs or contracts rather than authoring surfaces; assess
docstring coverage against their source modules instead of duplicating comments
in generated output or declaration signatures.

Keep the graph acyclic ESM. Relative imports use explicit `.ts` extensions,
type-only dependencies use `import type`, and TypeScript remains restricted to
erasable syntax. ODW primitives are ambient and must never be imported.

Use pure functions with explicit configuration parameters by default.
Introduce a factory only when a dependency is genuinely bound once and record
the reason in the design or ExecPlan decision log. Never bind a value that
changes between phases: prompt construction must receive the policy path the
CLI resolved host-side rather than capture the initial `auto` placeholder.
Internal bundle names are not interfaces; only the exact `workflowMain`
entry is load-bearing. Declare every runtime module in the build manifest and
wire it from `main.ts` so the compiler can compare the manifest with
esbuild's metafile.

Source tests should import the narrow module they exercise. Do not slice the
generated artefact to recover helpers: esbuild may normalize quotes, remove
comments, and reorder declarations. Artefact tests remain responsible for the
ODW loader shape, dry-run contract, CLI integration, and installed behaviour.

Configuration resolution and range preparation are deterministic host code
that runs entirely in the CLI, before `odw run` is invoked; the workflow
consumes the CLI's result as the `prepared` argument and never re-resolves
either. The workflow should keep any remaining deterministic git and
filesystem work in `scripts/review-state.mjs`; the workflow file itself
should not reimplement those operations.

Assume ODW copy workspace mode unless a run has explicitly chosen another
mode. Copied agent workspaces may not contain `.git`, so live workflow runs
should pass `repoRoot` as an absolute path to the real checkout. Any prompt
that asks an agent to inspect diffs should use `git -C <repoRoot>` rather than
plain `git diff`.

## 3. CLI conventions

`bin/dakar-review.mjs` is the installable command exposed by `package.json`.
It must remain usable after Bun installs Dakar from an absolute checkout path
or package tarball.

`install.sh` is the preferred local installer. It intentionally calls
`bun install -g` with Dakar's absolute checkout path because Bun 1.3.11 does
not create package bin links for bare `bun install -g .`.

The CLI should run the workflow from Dakar's package root as ODW `--source`
and pass the reviewed repository as the workflow `repoRoot` argument. This is
intentional: globally installed agents need Dakar's workflow, state helper, and
`odw.config.json` to be available even when they review another checkout.

When the reviewed repository has a root `AGENTS.md`, the CLI should pass its
content as `agentInstructions`. Keep this as context for review agents, not as
an override for Dakar's schema, output, or safety rules.

`scripts/review-config.mjs` owns CodeRabbit configuration resolution. The
CLI is now the sole caller: it resolves configuration and prepares the
review range (`scripts/review-state.mjs prepare`) in-process before `odw
run`, and passes the result to the workflow as `config` and the additive
`prepared: PreparedReview` argument. The workflow no longer re-resolves
either; it only validates `args.prepared` fail-closed. Keep the
configuration precedence stable unless the user-facing contract changes:
explicit `--config`, repository-local CodeRabbit YAML,
`$XDG_CONFIG_HOME/dakar/config.yaml` or `~/.config/dakar/config.yaml`, then the
bundled example config.

The default output is one JSON object on standard output. Do not add progress
text around it. On CLI or ODW process failures, write a JSON error object to
standard error and exit non-zero. A successful review with accepted findings is
still a successful CLI invocation; callers should inspect `findings` rather
than rely on exit status for review verdicts.

Recording is CLI-owned, not workflow-owned: after ODW returns a successful,
non-skipped result, the CLI calls `appendReview` from
`scripts/review-state.mjs` in-process (`recordReview()` in
`bin/dakar-review.mjs`) and stamps `recorded: { ok, stateFile, headCommit,
recordedBy: "dakar-review" }` onto the result. On append failure the CLI
sets `ok: false` and `stage: "record"`, preserving the workflow's
`recordInput` for a manual retry, and exits non-zero. The workflow itself no
longer performs an agent-mediated record phase and has no
`recordAttempts`/`stateFile`/`recorded` fields of its own; the CLI derives
the destination from its trusted `repo-root`/`state-root` and ignores any
state-file path in workflow output.

`--telemetry` is the only supported live-progress mode. It starts ODW in the
background, follows `odw logs <run-id> --follow`, writes that stream to
standard error, then fetches `odw result <run-id>` for the final output. Keep
all progress, run ids, and log-follow warnings on standard error so standard
output remains reserved for JSON or Markdown result data.

When changing CLI arguments or output, update these places together:

- `bin/dakar-review.mjs`;
- `tests/cli.test.mjs`;
- `docs/users-guide.md`;
- the workflow contract section in `docs/dakar-review-design.md` when the
  underlying ODW result changes.

## 4. Routed review conventions

The default `deterministic-flex-v1` route uses deterministic file-class
planning to build bounded Flex evidence packs, not per-kind model routing.
`buildFlexFinderPlan()` in `task-graph.ts` groups changed files by coarse
kind (`source`, `tests`, `config`, `docs`, in that fixed order for
determinism), chunks each group into homogeneous packs of at most
`transactionMaxFiles` files, and caps the total at `maxLunaFlexCalls`
packs. Every admitted pack is dispatched to the same Luna Flex lane
(`gpt-5.6-luna`, low reasoning by default; `luna-medium`, medium reasoning,
for the pre-registered escalation); there is no per-kind model assignment
on this route. Files beyond the pack cap are recorded as `truncatedFiles`
rather than silently dropped. Deterministic host code
(`candidates.ts::compactForAudit()`) then deduplicates, severity-orders,
and caps the resulting candidates at `maxAuditCandidates` before the
single Terra Flex audit call (`gpt-5.6-terra`, medium reasoning) returns
one verdict per candidate.

The Flex lanes are pinned in `model-routing.ts::FLEX_LANE_ROLES` and
selected only by host code (`flexLaneRole()`); ADR 002 forbids an agent
promoting itself to a costlier model or service tier, so lane choice never
appears in a prompt. `adapters/pi/` is the Dakar-owned adapter contract for
these lanes:

- `adapters/pi/flex-tier.ts`: the pi extension that stamps
  `service_tier: "flex"` from the `before_provider_request` hook and logs
  the assistant message's usage object to stderr with a `DAKAR-USAGE:`
  marker from the `message_end` hook, so the harness can recover per-call
  token counts that pi's print mode does not otherwise surface.
- `adapters/pi/models.json`: the Dakar-owned `openai-flex` provider
  catalogue (`baseUrl https://api.openai.com/v1`, `api openai-responses`,
  `apiKey: "$OPENAI_API_KEY"`), declaring `gpt-5.6-luna` and
  `gpt-5.6-terra`. A model missing from the selected provider's catalogue
  makes pi hang rather than fail, so the pinned provider and declared
  models are load-bearing.
- `odw.config.json`'s `pi-luna-flex`, `pi-luna-flex-medium`, and
  `pi-terra-flex` adapters invoke
  `pi -p --no-session -e adapters/pi/flex-tier.ts --provider openai-flex`
  with the lane's `--model` and `--thinking` pinned and `{prompt}` on
  stdin.
- The CLI sets `PI_CODING_AGENT_DIR` to `adapters/pi/` (and
  `PI_SKIP_VERSION_CHECK=1`) so pi resolves its provider catalogue from
  Dakar's own config directory rather than any ambient pi configuration.

The legacy per-kind Codex routing (`gpt-5.5` high for source, medium for
tests, `gpt-5.4-mini` for docs/config, `gpt-5.3-codex-spark` for a
cross-cutting summary, via the `codex-low`/`codex-medium`/`codex-high`
adapters) is retained in `taskSpec()`, `buildTaskGraph()`, and
`defaultTaskGraph()`, and still shapes the illustrative task graph shown by
`--dry-run`, but no live review dispatches through it: the
`deterministic-flex-v1` route uses `buildFlexFinderPlan()` exclusively.
The Codex adapters remain in `odw.config.json` for reference and for the
`legacy-route-final` git tag, which preserves a runnable pre-Flex arm at
the last commit before the deterministic host takeover.

Finder agents return candidates, not final conclusions. The Terra audit
must attempt to refute every candidate before it reaches the final
result. Final reports include only accepted findings.

When adding a new task kind, update these places together:

- the `taskKinds` configuration in `src/workflows/dakar-review/config.ts`,
  `flexPackKind()` and `buildFlexFinderPlan()` in
  `src/workflows/dakar-review/task-graph.ts` for the live route, and
  `buildTaskGraph()`/`taskSpec()` for the illustrative dry-run graph;
- the dry-run contract test in `tests/workflow-dry-run.test.mjs` and the
  finder-pack tests in `tests/workflow-task-graph.test.mjs`;
- the workflow contract section in `docs/design/initial-workflow.md`;
- user-facing behaviour in `docs/users-guide.md` if the change affects
  operators.

## 5. State helper conventions

`scripts/review-state.mjs` owns review-history behaviour. It computes the
unreviewed range and appends completed `[[reviews]]` TOML entries. Keep its
public commands stable:

```bash
node scripts/review-state.mjs prepare \
  --repo-root /path/to/repo \
  --base origin/main \
  --head HEAD
node scripts/review-state.mjs record < review.json
```

Tests that change range or state behaviour belong in
`tests/review-state.test.mjs` (plus its property and robustness suites).
Tests that change ODW dry-run or routed workflow contracts belong in
`tests/workflow-dry-run.test.mjs`. The remaining pure-module test files map
onto the source modules they exercise:

- `tests/workflow-pricing.test.mjs`: `pricing.ts` worked examples;
- `tests/workflow-admission.test.mjs`: `admission.ts` reserve-first
  inequalities;
- `tests/workflow-retry.test.mjs`: `retry.ts` jitter, backoff, and
  `worstCaseReviewSeconds()`;
- `tests/workflow-compact-audit.test.mjs`: `candidates.ts::compactForAudit()`
  dedup, ordering, and the `over_audit_cap` boundary;
- `tests/workflow-model-routing.test.mjs`: `model-routing.ts`, including the
  Flex lane roles;
- `tests/workflow-task-graph.test.mjs`: `task-graph.ts`, including
  `buildFlexFinderPlan()`;
- `tests/workflow-rendering.test.mjs`: the deterministic report's
  byte-stability across repeated runs of the same consolidated input;
- `tests/adapter-config.test.mjs`: the `adapters/pi/` extension, catalogue,
  and `odw.config.json` Flex adapter command shapes;
- `tests/workflow-orchestration.test.mjs`: end-to-end phase sequencing
  through the mock-agent-sequence helper in `tests/helpers/mock-agents.mjs`.

## 6. Documentation expectations

Update `docs/users-guide.md` for user-visible command, argument, result, or
state-path changes. Update this developer's guide for maintainer-facing
conventions. Update `docs/design/initial-workflow.md` for architecture and
component contract changes. Update `docs/dakar-review-design.md` when system
boundaries or verification invariants change. Use an Architecture Decision
Record when a narrow architectural choice is important to preserve
independently of the living design; proposed records must remain visibly
proposed until approved.

Run `npm run docstrings` when adding or changing authored workflow or CLI
symbols. The audit covers module headers, named functions (including internal
functions), exported interfaces and types, and exported constants in
`bin/dakar-review.mjs` and `src/workflows/dakar-review/`. It excludes the
generated `workflows/dakar-review.js` artefact and ambient `*.d.ts`
declarations. The default authored-source scope contains 117 documented symbols
and fails below 80% coverage; `make lint` and therefore `make check` run it
automatically.

Configuration resolution and range preparation no longer make agent calls
at all: both run as deterministic host code in the CLI before `odw run`,
and a failure there is reported by the CLI with stage `config` or
`prepare`, never by the workflow. Within the workflow, the two remaining
phases are Review (the Luna Flex finder fan-out) and Audit (the single
Terra Flex call). An admission refusal for the audit's own reservation
returns `stage: "admission"` before any model call. A finder call that
exhausts its Flex retries downgrades that pack (`lunaDowngrades`) rather
than failing the review; the audit exhausting its retries defers instead
(`stage: "deferred"`, no `recordInput`). An audit that returns without a
valid verdict for every candidate fails closed with `stage: "audit"` so
nothing is recorded. Preserve the original error or refusal text in each
case. Fan-out review calls retain their separate null-slot handling; the
audit call retains its separate verdict-completeness handling.
