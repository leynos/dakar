# Agent Instructions

This repository builds Dakar, an Open Dynamic Workflows (ODW) code-review
workflow and installable `dakar-review` CLI. The ODW source is a restricted
TypeScript dialect that compiles to a single-file workflow artefact; ordinary
TypeScript or JavaScript assumptions do not override the ODW contract.

- `workflows/dakar-review.js` is generated. Edit the TypeScript module tree
  under `src/workflows/dakar-review/` instead (`meta.js` remains plain
  JavaScript), run `make workflow-build`, and commit the source and regenerated
  artefact together. `make workflow-freshness` rejects stale artefacts.
- Before editing, reviewing, or validating the workflow, load and follow the
  `odw-authoring` skill so the dialect, injected primitives, schema contracts,
  workspace mode, and validation expectations are understood.
- ODW primitives are ambient, not imported. Keep the module graph acyclic ESM,
  use explicit `.ts` extensions for sibling imports, and use erasable TypeScript
  syntax. Do not introduce CommonJS, runtime dependencies, `Date.now()`,
  `Math.random()`, or argument-less `new Date()` calls.
- Begin every JavaScript or TypeScript module with a `/** @file … */` comment
  describing its purpose and responsibilities. Prefer small cohesive functions,
  precise names, immutable data, and comments that explain why rather than what.
- `bin/dakar-review.mjs` is the user-facing CLI. Keep stdout reserved for the
  final JSON or Markdown result. Progress, telemetry, run ids, and recovery
  warnings belong on stderr.
- `scripts/review-state.mjs` owns review-history state. Preserve the invariant
  that completed reviews record the reviewed head under the XDG state directory
  so later runs do not review the same commits again.
- `scripts/review-config.mjs` owns CodeRabbit-style config resolution. Preserve
  the precedence order documented in `docs/users-guide.md`.
- Dakar reviews should prioritize semantic correctness, security,
  behavioural regressions, missing review context, and workflow orchestration
  failures. Do not spend review budget relitigating deterministic formatting or
  linter findings unless the repository policy explicitly requires it and no
  deterministic tool covers it yet.

Write prose, comments, and commit messages in en-GB Oxford English. Keep changes
small and atomic, update the relevant user, developer, and architecture
documentation when contracts change, and add a regression test for each bug
fix. Pin build and test tooling exactly in `package.json`; the shipped workflow
has no runtime dependencies.

Run `make check` before committing. It covers formatting, linting, type checks,
workflow freshness, the ODW dry run, and tests. ODW syntax is checked through
the Makefile dry-run target, not with `node --check` directly. Prefer a
scrutineer agent to run commit gates sequentially and summarize the results.
Only commit changes after every applicable gate succeeds.
