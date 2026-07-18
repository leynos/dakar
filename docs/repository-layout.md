# Repository layout

This document explains the shape of the Dakar repository and the
responsibilities of its major paths. It is the canonical location for
repository-layout guidance; the [developer's guide](developers-guide.md)
covers build and contribution workflows instead.

Dakar builds an Open Dynamic Workflows (ODW) code-review workflow and the
installable `dakar-review` command-line interface (CLI). The ODW workflow is
authored as a typed module tree and compiled to a single-file artefact, so the
tree separates authored source from generated output.

## Top-level tree

The following tree is an orientation sketch. It highlights the paths a new
contributor must understand quickly and omits incidental files.

```plaintext
.
├── bin/                  User-facing CLI entry point
├── src/workflows/        Authored ODW workflow source (TypeScript)
├── workflows/            Generated single-file workflow artefact
├── scripts/              Build and support scripts, plus their tests
├── tests/                Node test suite for the CLI, scripts, and workflow
├── examples/             Illustrative configuration samples
├── docs/                 Documentation set (see docs/contents.md)
│   ├── design/           Supplementary design notes
│   └── execplans/        Living execution plans
├── .github/workflows/    Continuous integration (CI) configuration
├── AGENTS.md             Repository contract for contributors and agents
├── Makefile              Commit-gate targets (formatting, lint, tests)
├── odw.config.json       ODW adapter and runtime configuration
├── package.json          Build and test tooling, pinned exactly
└── typos.toml            Generated spelling configuration
```

## Path responsibilities

The table below describes each major path, its ownership boundary, and any
notable conventions.

| Path | Responsibility |
| --- | --- |
| `bin/dakar-review.mjs` | User-facing CLI. Reserves stdout for the final JSON or Markdown result; progress and diagnostics go to stderr. |
| `src/workflows/dakar-review/` | Authored ODW workflow source. Edit these modules rather than the generated artefact. `meta.js` remains plain JavaScript; sibling modules are erasable-syntax TypeScript using explicit `.ts` imports. |
| `workflows/dakar-review.js` | Generated single-file workflow artefact. Never edit by hand; regenerate with `make workflow-build` and commit alongside the source. |
| `scripts/` | Build and support scripts: workflow build (`build-workflow.mjs`), docstring checks, and CodeRabbit-style config and review-history state helpers. |
| `scripts/tests/` | Tests for the Python spelling-rollout helper. |
| `tests/` | Node test suite covering the CLI, scripts, and workflow orchestration, including property and robustness tests. |
| `examples/` | Illustrative configuration samples, such as a CodeRabbit-style review configuration. |
| `docs/` | Documentation set. The [contents file](contents.md) is the index; decision records live here as `adr-NNN-*.md`. |
| `docs/design/` | Supplementary design notes that expand on the primary design document. |
| `docs/execplans/` | Living execution plans that record scope, progress, and lessons for individual pieces of work. |
| `.github/workflows/` | CI configuration that runs the commit gates. |
| `AGENTS.md` | The repository contract that contributors and agents must follow. |
| `Makefile` | Commit-gate targets. `make check` runs formatting, linting, type checks, workflow freshness, the ODW dry run, and tests. |

## Generated paths

Some paths hold generated output and must not be edited directly.

- `workflows/dakar-review.js` is compiled from `src/workflows/dakar-review/`.
  `make workflow-freshness` rejects a stale artefact.
- `typos.toml` is produced by the spelling-configuration builder invoked from
  the `Makefile`. Regenerate it with `make spelling-config-write` rather than
  editing it by hand.
