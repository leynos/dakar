# Build the Dakar incremental ODW review workflow

This ExecPlan (execution plan) is a living document. The sections
`Constraints`, `Tolerances`, `Risks`, `Progress`, `Surprises & Discoveries`,
`Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work
proceeds.

Status: COMPLETE

## Purpose / big picture

This plan builds the first local Dakar workflow. After completion, running
`npm test` proves review-history range selection, and running
`npm run odw:dry-run` proves the ODW workflow loads and returns its configured
model set without launching reviewer agents.

## Constraints

- Do not modify `examples/df12-code-review.yaml`; it is the input policy
  example.
- Keep the initial implementation dependency-free.
- Use Red-Green-Refactor for deterministic state behaviour.
- The ODW workflow must not import Node modules directly.
- The workflow must not edit source files during review.

## Tolerances (exception triggers)

- Scope: if the initial build exceeds six new project files excluding docs,
  stop and reassess structure.
- Dependencies: if a YAML or TOML parser dependency becomes required for the
  first implementation, stop and justify it.
- Tests: if state-helper tests still fail after three implementation attempts,
  stop and document the failure.
- ODW: if `dryRun` cannot validate the workflow without agents, stop and record
  the alternative validation path.

## Risks

- Risk: Agent prompts may fail to execute the helper exactly.
  Severity: medium.
  Likelihood: medium.
  Mitigation: include exact commands and schemas in the workflow.

- Risk: Branch history may be rebased after a review.
  Severity: medium.
  Likelihood: medium.
  Mitigation: use `git merge-base --is-ancestor`; warn and fall back to merge
  base when recorded heads do not apply.

- Risk: Model identifiers may not exist in the local Codex adapter.
  Severity: medium.
  Likelihood: unknown.
  Mitigation: make the model list overridable via workflow args.

## Progress

- [x] (2026-06-29T17:57:30Z) Added `package.json` with Node test and ODW dry-run
  commands.
- [x] (2026-06-29T17:57:30Z) Added `scripts/review-state.mjs` with `prepare`
  and `record` commands.
- [x] (2026-06-29T17:57:30Z) Added `tests/review-state.test.mjs`.
- [x] (2026-06-29T17:57:30Z) Added
  `workflows/dakar-review.js`.
- [x] (2026-06-29T19:01:07Z) Ran `npm test`; all state-helper tests passed.
- [x] (2026-06-29T19:01:07Z) Ran `npm run odw:dry-run`; ODW returned
  `dryRun: true` and the configured model set.
- [x] (2026-06-29T19:01:07Z) Updated this plan to COMPLETE.

## Surprises & discoveries

- Observation: ODW import limitations require agents to call the helper.
  Evidence: design-phase ODW probes rejected import and require.
  Impact: The workflow uses schemas and exact helper commands in prompts.

## Decision log

- Decision: Store metrics as a JSON string inside each TOML review entry.
  Rationale: It keeps the initial TOML writer simple while preserving structured
  metrics for later analysis.
  Date/Author: 2026-06-29T17:57:30Z / Codex.

- Decision: Use Node built-in `node:test` instead of adding a test framework.
  Rationale: The first helper needs no third-party assertions or fixtures.
  Date/Author: 2026-06-29T17:57:30Z / Codex.

## Outcomes & retrospective

The build is complete. The deterministic state helper is covered by tests, and
the ODW workflow loads in dry-run mode without launching reviewer agents.

## Context and orientation

`scripts/review-state.mjs` owns review-history mechanics. Its `prepare` command
calculates the review range and returns JSON. Its `record` command appends a
TOML entry from JSON on stdin. `workflows/dakar-review.js` calls
agents in four phases: prepare, review, synthesize, and record.

## Plan of work

Stage A adds a failing state-helper test for review-history skipping. Stage B
implements the helper. Stage C adds the ODW workflow with `dryRun`. Stage D runs
tests and ODW validation, then updates this plan.

## Concrete steps

Run:

```bash
npm test
```

Expected output after implementation:

```plaintext
tests 4
pass 4
```

Run:

```bash
npm run odw:dry-run
```

Expected result contains:

```plaintext
"dryRun": true
```

## Validation and acceptance

Red: before implementing `scripts/review-state.mjs`, the tests in
`tests/review-state.test.mjs` fail because the module does not exist.

Green: after implementation, `npm test` passes all state-helper tests.

Refactor: after any cleanup, rerun `npm test` and `npm run odw:dry-run`.

Quality criteria:

- Tests: all Node tests pass.
- Workflow syntax: ODW dry-run succeeds without calling reviewer agents.
- Persistence: tests prove recorded heads suppress already reviewed commits.

## Idempotence and recovery

Tests create temporary repositories and temporary state roots under the OS temp
directory. They do not write to real user review history. The workflow dry-run
does not call agents and does not write files.

## Artefacts and notes

The state file path format is:

```plaintext
$XDG_STATE_HOME/dakar/<repo-owner>/<repo-name>/<branch-slug>/reviews.toml
```

## Interfaces and dependencies

`scripts/review-state.mjs prepare`:

```bash
node scripts/review-state.mjs prepare --repo-root . --base origin/main --head HEAD
```

`scripts/review-state.mjs record`:

```bash
node scripts/review-state.mjs record < review-record.json
```

`workflows/dakar-review.js` accepts ODW args `config`, `repoRoot`,
`base`, `head`, `stateRoot`, `agentInstructions`, `models`, `synthesisModel`,
`synthesisReasoning`, `maxTasks`, `maxCandidates`, `maxFindings`, and `dryRun`.

## Revision note

Initial build plan written with implementation scaffold, then updated after
`npm test` and `npm run odw:dry-run` passed. Remaining work moves to real
adapter execution against a branch with reviewed commits.
