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
- use injected ODW primitives such as `agent`, `parallel`, `pipeline`, and
  `phase`;
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
- `main.ts`: the composition root, phase transitions, agent dispatch, metrics,
  record input, and final result;
- `odw-globals.d.ts`: ambient declarations for every injected ODW primitive;
- `types.ts` and `schemas.ts`: erased cross-module types and runtime JSON
  Schemas;
- `config.ts` and `model-routing.ts`: argument defaults and adapter/model
  selection;
- `shell.ts`: the shared shell-word quoting authority;
- `task-graph.ts`: path classification, slot distribution, and task creation;
- `candidates.ts`: candidate containment, normalization, and verdict
  reduction; and
- `prompts.ts`: stable prompt prefixes and dynamic prompt tails.

The internally facing interfaces follow the same ownership boundaries.
`resolveWorkflowConfig()` returns the frozen `WorkflowConfig` passed into
routing and planning. `modelForRole()` and the other model-routing helpers map
that configuration to model and adapter selections. `buildTaskGraph()` and
`defaultTaskGraph()` consume `TaskGraphConfig`; they return `ReviewTask`
objects without calling ODW. Candidate processing flows through
`normalizeCandidates()`, `candidatesForVerification()`,
`acceptedFromVerdicts()`, and `discardedFromVerdicts()`. Prompt functions take
an explicit `PromptContext`, and `shellWord()` is the only shell-word quoting
interface. Runtime JSON Schemas are exported from `schemas.ts`, while shared
compile-time shapes are exported from `types.ts`. These modules are pure;
`main.ts` alone calls the ambient ODW primitives and owns phase sequencing.

Keep the graph acyclic ESM. Relative imports use explicit `.ts` extensions,
type-only dependencies use `import type`, and TypeScript remains restricted to
erasable syntax. ODW primitives are ambient and must never be imported.

Use pure functions with explicit configuration parameters by default.
Introduce a factory only when a dependency is genuinely bound once and record
the reason in the design or ExecPlan decision log. Never bind a value that
changes between phases: prompt construction must receive the policy path
resolved by the Resolve Config phase rather than capture the initial `auto`
placeholder. Internal bundle names are not interfaces; only the exact
`workflowMain` entry is load-bearing. Declare every runtime module in the build
manifest and wire it from `main.ts` so the compiler can compare the manifest
with esbuild's metafile.

Source tests should import the narrow module they exercise. Do not slice the
generated artefact to recover helpers: esbuild may normalize quotes, remove
comments, and reorder declarations. Artefact tests remain responsible for the
ODW loader shape, dry-run contract, CLI integration, and installed behaviour.

The workflow should keep deterministic git and filesystem work in
`scripts/review-state.mjs`. Agent prompts may ask Codex to run that helper, but
the workflow file itself should not reimplement those operations.

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

`scripts/review-config.mjs` owns CodeRabbit configuration resolution for both
the CLI and workflow. Keep this precedence stable unless the user-facing
contract changes: explicit `--config`, repository-local CodeRabbit YAML,
`$XDG_CONFIG_HOME/dakar/config.yaml` or `~/.config/dakar/config.yaml`, then the
bundled example config.

The default output is one JSON object on standard output. Do not add progress
text around it. On CLI or ODW process failures, write a JSON error object to
standard error and exit non-zero. A successful review with accepted findings is
still a successful CLI invocation; callers should inspect `findings` rather
than rely on exit status for review verdicts.

If a workflow result contains a completed review but `recorded.ok` is false,
the CLI should attempt exactly one deterministic record recovery through
`scripts/review-state.mjs`. Preserve `recorded.recoveredBy` and
`metrics.recordRecoveredByCli` so later evaluation can distinguish native ODW
recording from CLI repair. The workflow makes at most three recording attempts,
logs before attempts two and three, and returns the attempts made as
`recordAttempts`; keep that observability intact when changing Record-phase
handling.

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

The first routed workflow uses deterministic file-class planning. The planner
groups paths into review tasks and assigns models by task shape:

- source and dependency-impact tasks route to `gpt-5.5` high;
- test tasks route to `gpt-5.5` medium;
- docs and config tasks route to `gpt-5.4-mini`;
- review-summary inventory routes to `gpt-5.3-codex-spark`.

The ODW built-in Codex adapter exposes model routing through the agent `model`
option but does not expose Codex reasoning effort. Dakar therefore defines
`codex-low`, `codex-medium`, and `codex-high` in `odw.config.json`. Pass the
plain model id through `model`, and select the adapter that matches the
assigned reasoning level. Do not only mention the reasoning level in prompt
text or metrics.

Finder agents return candidates, not final conclusions. The high verifier
must attempt to refute every candidate before it reaches synthesis. Final
reports include only accepted findings.

When adding a new task kind, update these places together:

- the `taskKinds` configuration in `src/workflows/dakar-review/config.ts` and
  `buildTaskGraph()` and `taskSpec()` in
  `src/workflows/dakar-review/task-graph.ts`;
- the dry-run contract test in `tests/workflow-dry-run.test.mjs`;
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
`tests/review-state.test.mjs`. Tests that change ODW dry-run or routed workflow
contracts belong in `tests/workflow-dry-run.test.mjs`.

## 6. Documentation expectations

Update `docs/users-guide.md` for user-visible command, argument, result, or
state-path changes. Update this developer's guide for maintainer-facing
conventions. Update `docs/design/initial-workflow.md` for architecture and
component contract changes. Update `docs/dakar-review-design.md` when system
boundaries or verification invariants change. Use an Architecture Decision
Record when a narrow architectural choice is important to preserve
independently of the living design; proposed records must remain visibly
proposed until approved.
