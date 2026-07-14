# Architectural decision record (ADR) 001: Compile the ODW workflow from TypeScript

## Status

Accepted.

## Date

2026-07-14.

## Context and problem statement

`workflows/dakar-review.js` is both Dakar's largest source file and the runtime
artefact loaded by Open Dynamic Workflows (ODW). ODW does not load an ordinary
ECMAScript module. It accepts one literal `export const meta = { ... }`, wraps
the remaining source in an asynchronous function, and injects primitives such
as `agent`, `parallel`, `pipeline`, `phase`, and `args`. Top-level `return` is
therefore valid, while ordinary imports and additional exports are not.

The current 966-line workflow keeps that runtime contract visible, but couples
schemas, model routing, task planning, prompt construction, candidate
normalization, verdict reduction, and orchestration in one file. Tests for pure
helpers recover functions by slicing workflow source text before the dry-run
branch. That technique makes movement risky and prevents TypeScript from
checking cross-component contracts.

The df12-build repository demonstrates a compilation boundary that preserves
the ODW runtime dialect: maintain a typed module tree, concatenate literal
metadata verbatim, flatten the reachable modules with esbuild, and append the
top-level entry call required by the ODW wrapper. Dakar needs to decide whether
to adopt that boundary and which safeguards make the generated artefact a
trustworthy replacement for hand-authored workflow source.

## Decision drivers

- Preserve `workflows/dakar-review.js` as the installed and directly runnable
  ODW entrypoint.
- Preserve literal metadata, injected primitives, top-level return semantics,
  agent schemas, phase names, and result shapes.
- Make pure workflow logic directly type-checkable and testable without
  parsing generated source text.
- Fail before runtime when bundling introduces a loader-incompatible construct
  or omits a declared runtime module.
- Keep the generated artefact deterministic, inspectable, and available in an
  installed package without a build step.
- Avoid adding a second runtime or decomposing one workflow into child
  workflows merely to create source-code boundaries.
- Keep the compiler small enough to audit in one sitting.

## Requirements

### Functional requirements

- `dakar-review` and direct `odw run workflows/dakar-review.js` invocations
  must keep their current arguments and observable results.
- The workflow must still resolve policy, prepare the incremental range, route
  finder tasks, verify candidates, synthesize the report, and record the
  reviewed head in XDG state.
- Dry-run output must preserve the workflow version, metadata, limits, model
  assignments, task kinds, default task graph, and JSON Schemas.
- Standard output must remain reserved for the final JSON or Markdown result;
  telemetry, run identifiers, and recovery warnings must remain on standard
  error.
- Record-phase failure must continue returning `recordInput` so the CLI can
  repair review history.

### Technical requirements

- The source tree must use strict TypeScript restricted to erasable syntax.
- ODW primitives must be ambient declarations, never imported values.
- The generated artefact must contain exactly one literal metadata export, no
  module imports or additional exports, and exactly one workflow entry.
- The build must reject module wrappers, dynamic imports, `import.meta`, an
  omitted runtime module, and output that fails the ODW-style
  asynchronous-function-body parse.
- Relative source imports must carry explicit `.ts` extensions, and the module
  graph must remain acyclic ECMAScript modules (ESM).
- The generated artefact must be committed and protected by a content-based
  freshness gate that works before a commit exists.
- Source-level tests must read or import source modules; artefact-level tests
  must exercise the actual generated workflow.

## Options considered

### Keep the hand-authored monolith

This retains the simplest build but leaves the size, coupling, and source-slice
test problems intact. It does not satisfy the maintainability goal.

### Split work into child workflows or runtime helper files

Child workflows add orchestration and failure boundaries rather than source
boundaries. Runtime helper imports violate the ODW loader contract. Moving
deterministic logic into host scripts can be appropriate when that logic owns
host state, but schemas, routing, reductions, and prompt construction remain
workflow concerns.

### Concatenate TypeScript or JavaScript files directly

Text concatenation avoids a bundler but requires authors to manage declaration
order, type erasure, collisions, and module syntax manually. It recreates a
linker badly and provides weaker failure detection.

### Use an unmodified generic bundle as the runtime artefact

Generic bundlers emit modules or closure wrappers, may transform the metadata
export, and do not append the ODW top-level return. A generic configuration
alone does not prove the loader contract.

### Frame a flat esbuild bundle with ODW-specific checks

This option keeps ordinary TypeScript modules as the source of truth while a
small compiler produces the exact ODW shape. The compiler can reject every
known loader hazard before it writes output. It introduces generated-source
discipline and build dependencies, but those costs are bounded and testable.

| Topic | Monolith | Runtime split | Text concatenation | Framed esbuild bundle |
| --- | --- | --- | --- | --- |
| ODW compatibility | Native | Boundary-dependent | Fragile | Checked before write |
| Direct module tests | Poor | Partial | Partial | Strong |
| Type safety | Poor | Mixed | Mixed | Strong |
| Installed artefact | Present | Multiple files | Present | Present and committed |
| Build complexity | None | Runtime complexity | Custom linker logic | Small compiler |

_Table 1: Comparison of decomposition approaches._

## Decision outcome / proposed direction

Adopt an ODW-specific compiler modelled on df12-build.

The source of truth moves to `src/workflows/dakar-review/`. The compiler writes
`workflows/dakar-review.js` from three pieces in order:

1. `meta.js`, concatenated verbatim.
2. A flat esbuild ESM bundle rooted at `main.ts`, with tree shaking disabled.
3. A generated `return await workflowMain()` footer.

`main.ts` is the sole composition root and the sole module that calls injected
ODW primitives. It imports subsystem functions and passes immutable
configuration into each call. No subsystem imports `main.ts` or reads
run-scoped globals indirectly. Factories are reserved for a dependency that is
genuinely bound once; the default interface is a pure function with explicit
parameters.

The initial module tree is:

```plaintext
src/workflows/dakar-review/
├── meta.js
├── main.ts
├── odw-globals.d.ts
├── types.ts
├── schemas.ts
├── config.ts
├── model-routing.ts
├── shell.ts
├── task-graph.ts
├── prompts.ts
└── candidates.ts
```

`shell.ts` remains the single quoting authority because repository paths,
configuration paths, refs, and candidate paths cross into agent-proposed shell
commands. `config.ts` returns raw configuration and does not construct shell
fragments. `prompts.ts` receives the resolved policy path rather than capturing
the initial `auto` placeholder. `candidates.ts` must validate changed-file
membership and traversal safety before `prompts.ts` constructs a verifier
command.

The development toolchain remains npm. The implementation adds exact
development dependencies esbuild 0.28.1 and TypeScript 6.0.3 and commits the
resulting `package-lock.json`. Module tests remain ordinary Node tests and use
Node 24.12 or later, where built-in erasable TypeScript stripping is stable.
This is a contributor baseline only; the decision does not change the
installed CLI's runtime requirement.

The compiler is Dakar-specific. Generalizing it into a shared package is not
part of this decision.

## Goals and non-goals

- Goals:
  - create typed and testable workflow component boundaries;
  - preserve the complete user-facing and runtime contract;
  - make loader compatibility and generated-source freshness deterministic
    gates;
  - replace source-slicing helper tests with direct module tests.
- Non-goals:
  - change review behaviour, routing policy, schemas, prompts, or output;
  - change the CLI or review-history format;
  - introduce child workflows;
  - extract a reusable compiler framework;
  - add Bun, a behaviour-driven test framework, or formal verification solely
    for this refactor.

## Migration plan

1. Strengthen characterization tests for current dry-run, CLI, planning,
   candidate, prompt-safety, and record-recovery behaviour.
2. Add TypeScript configuration, ambient ODW declarations, compiler tests,
   and freshness enforcement.
3. Move the workflow mechanically behind the compiler before extracting
   behavioural modules.
4. Extract schemas, types, configuration, model routing, task planning,
   candidate processing, and prompts in small behaviour-preserving steps.
5. Keep `main.ts` as orchestration and rebuild the committed artefact after
   every extraction.
6. Validate deterministic builds, the ODW dry run, the CLI surface, one
   isolated live review, the XDG history record, and the subsequent
   already-reviewed skip.

The ExecPlan at `docs/execplans/compile-dakar-review-workflow.md` defines the
test-first sequence, tolerances, and recovery procedure.

## Known risks and limitations

- esbuild may rename internal top-level declarations. Those names are not a
  runtime interface because source tests import modules directly; only the
  exact `workflowMain` entry remains load-bearing.
- Cycles or CommonJS interop may introduce closure wrappers. The compiler
  rejects known wrapper forms, and contributors must keep the graph acyclic ESM.
- Tree-shaking control does not make an unreachable file reachable. The build
  compares esbuild's metafile inputs with an explicit runtime-module manifest,
  and each new runtime module must be authored, declared, and wired in the same
  change.
- esbuild normalizes quotes and removes comments. Tests that care about source
  wording must read the source module, not the generated artefact.
- A stale committed artefact could make source tests green while installed
  behaviour remains old. `workflow-freshness` compiles to a temporary output
  and compares content with the working-tree artefact. Continuous Integration
  (CI) separately rebuilds and rejects a Git diff from committed source.
- A compiler failure must not truncate the last good artefact. Normal builds
  write a same-directory temporary file and replace the output atomically;
  check-only builds never write it.
- Node executes erasable TypeScript without type-checking and ignores
  `tsconfig.json`. TypeScript compilation remains a separate mandatory gate;
  Node's built-in type stripping is only a module-test execution mechanism.
- `Date.now()` currently participates in review identifier construction. The
  mechanical decomposition must preserve it unless a separate compatibility
  finding proves that ODW rejects it; this decision does not hide a behaviour
  change inside source movement.

## Architectural rationale

Compilation creates a boundary between maintainable source and constrained
runtime syntax without pretending the runtime understands modules. The
generated artefact remains visible and reviewable, while the compiler and
freshness gate make the transformation reproducible. Explicit parameters keep
dependencies visible and one-way. Direct module tests cover pure behaviour;
artefact tests cover the loader-shaped product. Each layer tests the contract
it actually owns.

## References

- [df12-build compilation mechanism](https://github.com/leynos/df12-build/blob/main/docs/odw-compilation-and-compile-time-testing.md)
- [df12-build workflow compiler](https://github.com/leynos/df12-build/blob/main/scripts/build-workflow.mjs)
- [Open Dynamic Workflows](https://github.com/xz1220/open-dynamic-workflows)
- [esbuild API](https://esbuild.github.io/api/)
- [Node.js TypeScript support](https://nodejs.org/api/typescript.html)
- [TypeScript `erasableSyntaxOnly`](https://www.typescriptlang.org/tsconfig/erasableSyntaxOnly.html)
- [TypeScript `allowImportingTsExtensions`](https://www.typescriptlang.org/tsconfig/allowImportingTsExtensions.html)
- [TypeScript `verbatimModuleSyntax`](https://www.typescriptlang.org/tsconfig/verbatimModuleSyntax.html)
