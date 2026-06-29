# Developer's guide

This guide is for maintainers working on Dakar's local ODW review workflow.
The primary architecture reference is
[`docs/design/initial-workflow.md`](design/initial-workflow.md), and delivery
plans live under [`docs/execplans/`](execplans/).

## 1. Local validation

Run the full local gate before committing changes:

```bash
make check
```

This gate checks whitespace, Node syntax for ordinary Node modules, ODW
dry-run, Node tests, Markdown lint, and Mermaid diagrams.

Use focused commands while iterating:

```bash
node --test tests/review-state.test.mjs
node --test tests/workflow-dry-run.test.mjs
npm run odw:dry-run
```

Do not use `node --check workflows/coderabbit-code-review.js` as a workflow
syntax gate. ODW files permit top-level `return`, which ordinary Node syntax
checking rejects. Use `odw run ... --args '{"dryRun":true}'` instead.

## 2. Workflow implementation conventions

`workflows/coderabbit-code-review.js` must remain a pure ODW workflow file:

- keep a literal `meta` export;
- do not add Node imports;
- use injected ODW primitives such as `agent`, `parallel`, `pipeline`, and
  `phase`;
- use JSON Schemas for every agent output consumed by workflow JavaScript;
- filter null or failed slots after `parallel()` and `pipeline()`;
- keep reductions deterministic and independent of completion order.

The workflow should keep deterministic git and filesystem work in
`scripts/review-state.mjs`. Agent prompts may ask Codex to run that helper, but
the workflow file itself should not reimplement those operations.

Assume ODW copy workspace mode unless a run has explicitly chosen another
mode. Copied agent workspaces may not contain `.git`, so live workflow runs
should pass `repoRoot` as an absolute path to the real checkout. Any prompt
that asks an agent to inspect diffs should use `git -C <repoRoot>` rather than
plain `git diff`.

## 3. Routed review conventions

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

- `TASK_KINDS` in `workflows/coderabbit-code-review.js`;
- `buildTaskGraph()` and `taskSpec()`;
- the dry-run contract test in `tests/workflow-dry-run.test.mjs`;
- the workflow contract section in `docs/design/initial-workflow.md`;
- user-facing behaviour in `docs/users-guide.md` if the change affects
  operators.

## 4. State helper conventions

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

## 5. Documentation expectations

Update `docs/users-guide.md` for user-visible command, argument, result, or
state-path changes. Update this developer's guide for maintainer-facing
conventions. Update `docs/design/initial-workflow.md` for architecture and
component contract changes. Use an Architecture Decision Record only when the
decision is narrow, accepted, and important to preserve independently from the
living design.
