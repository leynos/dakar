# Agent Instructions

This repository builds Dakar, an Open Dynamic Workflows (ODW) code-review
workflow and installable `dakar-review` CLI.

- `workflows/dakar-review.js` is an ODW workflow file. Before editing
  or reviewing it, load and follow the `odw-authoring` skill so the workflow
  dialect, injected primitives, schema contracts, workspace mode, and
  validation expectations are understood.
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

Run `make check` before committing. ODW workflow syntax is checked with the
dry-run command in the Makefile, not with `node --check` directly.
