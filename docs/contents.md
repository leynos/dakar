# Documentation contents

This is the index for Dakar's documentation set. Start here to find the right
document for a task, then follow the inline links.

- [Documentation contents](contents.md) — this index; readers can confirm
  they are at the top of the documentation set.

## Guides

- [User's guide](users-guide.md) — run the `dakar-review` workflow on a branch,
  understand what it reviews, where review history is stored, and how to read
  the results.
- [Developer's guide](developers-guide.md) — build, test, and extend the
  compiled Open Dynamic Workflows (ODW) review workflow as a maintainer.
- [Documentation style guide](documentation-style-guide.md) — conventions for
  authoring documentation across df12 Productions projects.

## Design documents

- [Dakar review design](dakar-review-design.md) — the living architecture
  reference for the review workflow: constraints, data flow, and intended
  evolution.
- [Initial workflow design](design/initial-workflow.md) — the design of the
  first routed divide-and-conquer review pass and the compiled-source boundary.

## Decision records

- [ADR 001: Compile the ODW workflow from TypeScript](adr-001-compile-odw-workflow-from-typescript.md)
  — why the workflow is authored as a typed module tree compiled to a single
  artefact.
- [ADR 002: Deterministic review stages and Flex-tier residual judgement](adr-002-deterministic-tiered-review-cost.md)
  — why deterministic host logic runs first and residual judgement uses
  Flex-tier models under a cost budget.

## Reference

- [Repository layout](repository-layout.md) — the shape of the tree and the
  responsibilities of its major paths.
- [Roadmap](roadmap.md) — the outcome-oriented delivery sequence derived from
  the review design.
- [Complexity antipatterns and refactoring strategies](complexity-antipatterns-and-refactoring-strategies.md)
  — reference guidance on recognizing and reducing code complexity.

## Execution plans

- [Execution plans](execplans/) — living plans that record scope, progress, and
  lessons for individual pieces of work.
  - [Design the incremental ODW review workflow](execplans/initial-workflow-design.md)
    — plan for the initial workflow design.
  - [Build the incremental ODW review workflow](execplans/initial-workflow-build.md)
    — plan for the initial workflow build.
  - [Implement the routed divide-and-conquer workflow](execplans/divide-and-conquer-workflow.md)
    — plan for the routed finder-and-verifier pass.
  - [Compile the review workflow from typed modules](execplans/compile-dakar-review-workflow.md)
    — plan for moving the workflow to a compiled TypeScript source boundary.
  - [Implement the ADR 002 deterministic-tiered review route](execplans/api-key-support.md)
    — completed plan for the deterministic-flex route, its live validation,
    and the df12-build gate enablement.
