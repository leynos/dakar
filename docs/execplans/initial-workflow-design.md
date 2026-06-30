# Design the Dakar incremental ODW review workflow

This ExecPlan (execution plan) is a living document. The sections
`Constraints`, `Tolerances`, `Risks`, `Progress`, `Surprises & Discoveries`,
`Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work
proceeds.

Status: COMPLETE

## Purpose / big picture

This plan designs a Dakar Open Dynamic Workflow that reviews only commits not
previously covered by review history. Success is observable when
`docs/design/initial-workflow.md` names the state model, workflow contract,
agent model set, metrics, static-analysis hooks, failure modes, and validation
strategy.

## Constraints

- The design must use the user-requested CodeRabbit YAML as review policy input.
- The review history must live under an XDG state directory scoped by repository
  owner, repository name, and branch slug.
- The ODW script must obey ODW v0.4 workflow syntax: literal `meta`, injected
  primitives, schemas for structured handoffs, and bounded fan-out.
- Deterministic state and git behaviour must be testable outside agent prompts.
- The initial model set must include Codex reviewers for `gpt-5.5` low, medium,
  and high, `gpt-5.4-mini`, and `gpt-5.3-codex-spark`.

## Tolerances (exception triggers)

- Scope: if the design requires a hosted service, database, or external
  dependency before an initial local workflow can run, stop and escalate.
- Interface: if ODW cannot pass model identifiers to the Codex adapter, stop and
  document model-routing alternatives.
- Ambiguity: if CodeRabbit YAML must be fully schema-validated rather than used
  as policy text, stop and request a schema-validation milestone.
- Safety: if review history would be written inside the repository rather than
  XDG state, stop and redesign.

## Risks

- Risk: The requested path `~/.local/data` conflicts with XDG state semantics.
  Severity: medium.
  Likelihood: high.
  Mitigation: document the conflict and implement `$XDG_STATE_HOME`, defaulting
  to `~/.local/state`.

- Risk: ODW may not allow filesystem imports in workflow JavaScript.
  Severity: high.
  Likelihood: medium.
  Mitigation: probe ODW locally and move state work into a helper if imports are
  unavailable.

- Risk: Static-analysis and codegraph tools are useful but can expand scope.
  Severity: medium.
  Likelihood: high.
  Mitigation: design metrics and extension points first; do not add tool
  dependencies to the initial build.

## Progress

- [x] (2026-06-29T17:57:30Z) Inspected the repository and found only
  `examples/df12-code-review.yaml`.
- [x] (2026-06-29T17:57:30Z) Researched CodeRabbit configuration, XDG state,
  SARIF, Semgrep, SCIP, and Tree-sitter.
- [x] (2026-06-29T17:57:30Z) Probed ODW v0.4 and confirmed workflow JavaScript
  cannot use dynamic `import()` or `require`.
- [x] (2026-06-29T17:57:30Z) Drafted
  `docs/design/initial-workflow.md`.

## Surprises & discoveries

- Observation: The repository has no package metadata or source tree yet.
  Evidence: `rg --files` returned only `examples/df12-code-review.yaml`.
  Impact: The implementation must introduce a minimal project structure.

- Observation: ODW rejects workflow-level dynamic imports and `require`.
  Evidence: local probe runs failed before execution.
  Impact: The design uses a deterministic Node helper invoked by agents.

## Decision log

- Decision: Use `$XDG_STATE_HOME/dakar/.../reviews.toml`, defaulting to
  `$HOME/.local/state/dakar/...`.
  Rationale: The XDG specification assigns persistent history to state, not data.
  Date/Author: 2026-06-29T17:57:30Z / Codex.

- Decision: Keep static analysis and codegraph support as recorded metrics and
  future enrichment points.
  Rationale: The initial repository has no language target or dependency policy.
  Date/Author: 2026-06-29T17:57:30Z / Codex.

- Decision: Put deterministic range calculation in `scripts/review-state.mjs`.
  Rationale: ODW workflow JavaScript cannot import filesystem or child-process
  modules directly.
  Date/Author: 2026-06-29T17:57:30Z / Codex.

## Outcomes & retrospective

The design is complete and directly shaped the build plan. The main lesson is
that ODW syntax constraints must be verified before placing deterministic logic
inside workflow JavaScript.

## Context and orientation

The repository is `/data/leynos/Projects/dakar` on branch `initial-workflow`.
The only pre-existing file is `examples/df12-code-review.yaml`, an untracked
CodeRabbit configuration with review tone, path instructions, labels, and
pre-merge checks. ODW means Open Dynamic Workflow, a JavaScript workflow format
run by the `odw` CLI. CodeRabbit YAML is used here as a policy document for
review agents.

## Plan of work

Stage A researches prior art and local constraints. Stage B writes
`docs/design/initial-workflow.md` with architecture, state model, metrics, and
verification properties. Stage C hands the design to the build ExecPlan.

## Concrete steps

Run from `/data/leynos/Projects/dakar`:

```bash
rg --files
```

Expected output includes:

```plaintext
examples/df12-code-review.yaml
```

Run:

```bash
odw --help
```

Expected output identifies ODW v0.4.0 and `odw run`.

## Validation and acceptance

Acceptance for the design phase is:

- `docs/design/initial-workflow.md` exists and starts with a level 1 heading.
- The design references CodeRabbit configuration, XDG state, SARIF, Semgrep,
  SCIP, and Tree-sitter sources.
- The design specifies observable helper and workflow validation.

## Idempotence and recovery

The design phase only writes Markdown. Re-running it should update the same
documents without mutating state files.

## Artifacts and notes

Research sources:

```plaintext
https://docs.coderabbit.ai/reference/configuration
https://specifications.freedesktop.org/basedir/
https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html
https://docs.semgrep.dev/cli-reference
https://github.com/scip-code/scip
https://tree-sitter.github.io/
```

## Interfaces and dependencies

The design defines these build artefacts:

- `scripts/review-state.mjs`: deterministic prepare/record helper.
- `workflows/dakar-review.js`: ODW orchestrator.
- `tests/review-state.test.mjs`: state-helper behaviour tests.

## Revision note

Initial complete design plan written after repository inspection, Firecrawl
research, and ODW import probing. The build plan can proceed against the helper
plus pure ODW workflow architecture.
