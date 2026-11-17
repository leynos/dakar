# 2.3.1 Specify instruction discovery and precedence for nested `AGENTS.md` files

This ExecPlan (execution plan) is a living document. The sections
`Constraints`, `Tolerances`, `Risks`, `Progress`, `Surprises & discoveries`,
`Decision log`, `Outcomes & retrospective`, `Conformance basis`, and
`Verification plan` must be kept up to date as work proceeds.

Status: DRAFT (awaiting design review and user approval)

Branch: `2-3-1-specify-nested-agents-md-files`

Roadmap item: `2.3.1` in `docs/roadmap.md`.

## Purpose / big picture

Dakar is a code-review tool. Its command-line interface (CLI),
`dakar-review`, prepares an unreviewed commit range on the host and then runs
an Open Dynamic Workflows (ODW) workflow in which language-model agents
("finders") propose findings and one "audit" agent accepts or rejects them.
Repository-local instructions for coding agents live in Markdown files named
`AGENTS.md`. Today Dakar reads only the repository-root `AGENTS.md`, from the
trusted review base commit (by default `origin/main`), truncates it to 24,000
characters, and passes it to every prompt. Large repositories, especially
monorepos, put further `AGENTS.md` files in subdirectories, for example
`packages/api/AGENTS.md`, and expect those to govern only the files beneath
them. Dakar ignores them.

Roadmap item 2.3.1 asks for a specification, not yet a prompt change: "the
design defines which instruction files apply to each changed path and how
conflicts are reported." Roadmap item 2.3.2 ("Prototype task-level
instruction packs") will later feed the selected instruction text into finder
and audit prompts. This plan therefore delivers four things:

1. A written, accepted design: a new architecture decision record (ADR),
   `docs/adrs/adr-0004-scope-nested-agents-instructions.md`, and a rewritten
   `docs/dakar-review-design.md` §6 that define discovery, applicability,
   precedence, bounds, and diagnostic reporting.
2. An executable specification of that design: a pure, side-effect-free
   resolver module shared by the CLI now and by the workflow in 2.3.2, proved
   correct for its core rules with LemmaScript and Dafny and covered by unit
   and `fast-check` property tests.
3. A discovery adapter that reads every `AGENTS.md` from the trusted base
   commit using Git, never the working tree, and turns anomalies into
   diagnostics instead of crashes.
4. An observable report. After this change a user with a nested layout can
   run the CLI and see on standard error (stderr) which instruction files were
   discovered, which apply to which group of changed paths, and which were
   skipped, truncated, or changed in the reviewed range, without any change to
   standard output (stdout), the workflow arguments, or the prompts.

A small example. Given this tree at the trusted base:

```plaintext
AGENTS.md
packages/api/AGENTS.md
packages/api/src/AGENTS.md
packages/web/agents.md
```

and a review range that changes `packages/api/src/routes.ts`,
`packages/api-client/index.ts`, and `packages/web/app.tsx`, the design says:

- `packages/api/src/routes.ts` is governed by the chain `AGENTS.md`, then
  `packages/api/AGENTS.md`, then `packages/api/src/AGENTS.md` (root first,
  nearest last; the nearest wins any conflict).
- `packages/api-client/index.ts` is governed by `AGENTS.md` only: directory
  ancestry is compared segment by segment, so `packages/api` is not an
  ancestor of `packages/api-client`.
- `packages/web/app.tsx` is governed by `AGENTS.md` only, and a
  `case-variant-ignored` diagnostic reports that `packages/web/agents.md` is
  not an instruction file because the name match is exact and case-sensitive.

Today the same run prints nothing about instruction scope. After the change,
stderr carries one line such as:

```plaintext
dakar-review: instructions {"event":"instruction_scope","type":"summary","trustedCommit":"<sha>","discovered":3,"applied":3,"groups":[{"chain":["AGENTS.md","packages/api/AGENTS.md","packages/api/src/AGENTS.md"],"changedPathCount":1},{"chain":["AGENTS.md"],"changedPathCount":2}],"diagnostics":[{"code":"case-variant-ignored","path":"packages/web/agents.md"}]}
```

Preserved behaviour: the root `AGENTS.md` continues to reach prompts through
the existing `agentInstructions` workflow argument with the same source label,
24,000-character truncation, and failure messages; stdout remains reserved for
the final JSON or Markdown result; the generated workflow
`workflows/dakar-review.js` is unchanged. Deliberately changed behaviour: an
oversized root `AGENTS.md` that today crashes the CLI with a Node `ENOBUFS`
buffer error (if confirmed in `EP-M4`) is instead truncated and reported, and
a committed symbolic link named `AGENTS.md`, whose link target text is today
read as instructions, is instead skipped with a diagnostic.

## Constraints

- Implementation begins only after the user explicitly approves this plan.
- Do not change prompt text, the `agentInstructions` workflow argument shape,
  `workflowArgsSchema`, the workflow result shape, SARIF output, or
  `workflows/dakar-review.js`. Feeding nested instructions to agents is
  roadmap item 2.3.2.
- Keep stdout reserved for the final JSON or Markdown result. All instruction
  scope reporting goes to stderr (`AGENTS.md` repository rule).
- Read instruction files only from the trusted instruction commit (the
  resolved `--base` ref, default `origin/main`, exactly as
  `readAgentInstructions()` in `bin/dakar-review.mjs` does today). Never read
  instruction text from the working tree or the reviewed head: a pull request
  must not be able to instruct its own reviewer.
- The resolver kernel and policy modules are pure: no `node:` imports, no
  file system, no Git, no clock, no randomness, no `Date.now()`,
  `Math.random()`, or argument-less `new Date()`. They live under
  `src/workflows/dakar-review/` because both the CLI (which already imports
  `pricing.ts` and `retry.ts` from there) and, in 2.3.2, the workflow consume
  them. They must use erasable TypeScript syntax and explicit `.ts` sibling
  imports, and must be acyclic ES modules.
- Git and file access live only in the host adapter
  `scripts/instruction-discovery.mjs`. Domain modules must not import from
  `scripts/` or `bin/`.
- Every new JavaScript or TypeScript module starts with a `/** … @module */`
  block, and every exported declaration has a JSDoc block, because
  `make docs-check` runs TypeDoc with zero-warning validation.
- `bin/dakar-review.bundle.mjs` is generated by `make workflow-build`
  (`npm run cli:build`); never edit it by hand. Commit it regenerated whenever
  `bin/dakar-review.mjs` or a module it bundles changes, because
  `make workflow-check` rejects a stale bundle.
- `typos.toml` is generated; repository spelling exceptions go in
  `typos.local.toml` as narrow patterns.
- Pin every new tool exactly in `package.json` (`AGENTS.md`). The shipped
  workflow keeps no new runtime dependency. The only authorized new
  dependency is `lemmascript` as an exact-pinned development dependency
  (requested by the user for the proof); Dafny is an external prover binary
  pinned in CI and in the Makefile documentation.
- Keep `biome lint` cognitive complexity below 10 for `bin/dakar-review.mjs`
  (`biome.json`); keep new functions small enough that Oxlint's Unicorn and
  deslop profiles (`oxlint.config.mjs`) pass without suppressions.
- Prose, comments, and commit messages use en-GB Oxford spelling and follow
  `docs/documentation-style-guide.md` (sentence-case headings, 80-column prose
  wrap, labelled code fences, captioned tables and diagrams).
- Completed ExecPlans under `docs/execplans/` are historical; do not edit
  them.
- Run `make check-fmt`, `make typecheck`, `make lint`, and `make test` (and,
  from `EP-M2`, `make proofs`) sequentially after each milestone, and commit
  only when every gate passes.

## Tolerances (exception triggers)

Comparison base: `379128f` (the `main` commit this branch starts from).
Counting command, run from the repository root after each milestone:

```bash
git diff --numstat 379128f -- . \
  ':(exclude)docs/execplans/2-3-1-specify-nested-agents-md-files.md' \
  ':(exclude)bin/dakar-review.bundle.mjs' \
  ':(exclude)package-lock.json' \
  ':(exclude)typos.toml' \
  ':(exclude)src/workflows/dakar-review/*.dfy.gen'
```

Every limit below measures net lines (additions minus deletions) per
category, and every category is enforced independently. This ExecPlan file is
excluded from every count. Generated artefacts are excluded as listed above
and governed by their own rules: `bin/dakar-review.bundle.mjs` and
`typos.toml` are regenerated by repository tooling, `*.dfy.gen` files are
regenerated by `lsc`, and `package-lock.json` is limited by the dependency
tolerance instead.

Classification by purpose: code is TypeScript and JavaScript under `src/`,
`scripts/`, `bin/dakar-review.mjs`, and `tests/`, plus hand-maintained Dafny
proof files (`*.dfy`) and Makefile recipe lines; configuration is
`package.json`, `.github/workflows/*.yml`, `LemmaScript-files.txt`,
`typos.local.toml`, and Makefile variable or `.PHONY` lines; documentation is
every other Markdown file.

- Files: if implementation changes more than 26 non-ExecPlan files, counting
  generated files, stop and escalate.
- Code: if code exceeds 2,100 net lines, stop and escalate. Estimate: kernel
  module 140, policy module 260, discovery adapter 230, CLI wiring 70, unit
  and table tests 420, property tests 260, adapter integration tests 280,
  CLI end-to-end tests 180, Dafny proof additions 160, total 2,000; the
  contingency is small because the proof file is the main unknown and has its
  own probe (`EP-M0`).
- Configuration: if configuration exceeds 70 net lines, stop and escalate.
  Estimate: `package.json` 4, Makefile variables 4, CI proof step 25,
  `LemmaScript-files.txt` 2, `typos.local.toml` up to 6.
- Documentation: if documentation exceeds 650 net lines, stop and escalate.
  Estimate: ADR 0004 230, design §§3 and 6 140, users' guide 70, developers'
  guide 100, skill guide 10, contents index 6, roadmap 2, repository layout 6.
- Dependencies: if `lemmascript` at the pinned version adds more than 40
  packages to `package-lock.json`, or any other dependency is needed, stop and
  escalate.
- Interface: if any change to the workflow argument schema, prompt text,
  stdout result shape, or a new CLI flag appears necessary, stop and escalate;
  those belong to 2.3.2 or need approval.
- Architecture: if the resolver cannot stay pure, or the trusted-commit read
  rule must change, stop and escalate.
- Proof: if the `EP-M0` probe shows that the pinned LemmaScript release
  cannot model the kernel, or a proof obligation in `EP-M2` remains open after
  three focused attempts, stop and escalate rather than weakening the
  specification or adding `//@ assume`.
- Iterations: if a focused test or gate still fails after three attempts at
  a fix, stop and escalate.
- Time: if any milestone takes more than four hours of active work, stop and
  escalate.
- Ambiguity: if the design review or implementation exposes two valid
  readings that materially change applicability or precedence, stop and
  present the options.

Historical evidence: none of the five completed plans in `docs/execplans/`
records a budget increase in its decision log or revision notes. The closest
comparable, `docs/execplans/api-key-support.md`, set "roughly 25 files or
2,500 lines" across all categories; `docs/execplans/divide-and-conquer-workflow.md`
set five files and 350 production lines and finished without recorded
growth. Those plans did not separate categories, so they cannot calibrate the
documentation budget; the documentation estimate above is therefore built
bottom-up from the sections that must change.

## Risks

- Risk: the pinned LemmaScript release (a technology preview; `npm view`
  shows 0.6.10 as the latest at planning time, while the house skill was
  written against 0.5.22) may not translate nested loops over `string[][]`
  or may need `//@` annotations the codebase's linters reject.
  Severity: medium. Likelihood: medium. Mitigation: the `EP-M0` probe runs
  first on a scratch copy; the kernel is written over plain arrays and
  integers to stay inside the documented fragment; the proof tolerance
  forces escalation instead of a vacuous proof.
- Risk: `lemmascript` depends on `ts-morph`, which bundles its own
  TypeScript compiler, so the lockfile may grow substantially.
  Severity: low. Likelihood: medium. Mitigation: the dependency tolerance
  caps the package count; the fallback, if exceeded, is an exact-pinned
  `npx --package=lemmascript@<version>` invocation in the Makefile, which
  needs user approval because it departs from the `package.json` pinning
  rule.
- Risk: Dafny is installed on the development host
  (`~/.local/bin/dafny`, version 4.11.0) but not in CI.
  Severity: medium. Likelihood: high. Mitigation: `EP-M6` adds a pinned CI
  step; `make proofs` is a separate target so `make check` stays runnable on
  hosts without Dafny, and the plan records that local proof runs need
  Dafny 4.11.0.
- Risk: changed paths come from `git diff --name-only` without `-z` in
  `scripts/review-state.mjs::changedFiles()`, so Git C-quotes paths with
  unusual bytes (for example `"src/caf\303\251.ts"`). Quoted paths would not
  match any ancestor directory except the root.
  Severity: medium. Likelihood: low. Mitigation: the resolver treats a path
  that begins with a double quote, contains an empty, `.`, or `..` segment,
  or is absolute as malformed and reports `unresolvable-path` (root chain
  only). Fixing the quoting in `review-state.mjs` changes a shared contract
  that also feeds `path_instructions` matching, so it is recorded in
  `Surprises & discoveries` as a follow-up rather than done here.
- Risk: the trusted instruction commit (`--base`) differs from the trusted
  gate-configuration commit (`prepared.reviewBase`, which may be the last
  reviewed head). Severity: low. Likelihood: certain (existing behaviour).
  Mitigation: keep the existing `--base` rule for all instruction files so
  root and nested files always come from one commit; record the divergence
  in ADR 0004 as a known limitation.
- Risk: the review panel may prefer to defer all CLI wiring to 2.3.2 or to
  move reporting into the workflow result. Severity: low. Likelihood: medium.
  Mitigation: the design review explicitly tests that choice; milestones
  `EP-M1` to `EP-M4` stand on their own if `EP-M5` is dropped.
- Risk: very wide repositories may contain thousands of tracked files;
  `git ls-tree -r` lists all of them. Severity: low. Likelihood: low.
  Mitigation: run `git ls-tree` with a raised `maxBuffer` (64 MiB) and a
  streaming-free parse; if listing fails, emit an `instruction-discovery`
  failure diagnostic and continue with the root-only behaviour, never
  failing the review for nested discovery.

## Progress

- [x] (2026-11-17T14:04Z) Branch renamed, repository reconnaissance (two
  Wyvern scouts), and prior-art research completed.
- [x] (2026-11-17) Initial draft written.
- [ ] Community-of-experts design review completed and findings applied.
- [ ] Plan approved by the user.
- [ ] `EP-M0` LemmaScript feasibility probe (prototype).
- [ ] `EP-M1` design recorded: ADR 0004 and design §§3 and 6.
- [ ] `EP-M2` ancestry and budget kernel with proof and tests.
- [ ] `EP-M3` instruction-scope policy with diagnostics and property tests.
- [ ] `EP-M4` trusted Git discovery adapter; root loading unified on it.
- [ ] `EP-M5` CLI stderr scope report with end-to-end tests.
- [ ] `EP-M6` documentation, CI proof step, roadmap closure.

## Surprises & discoveries

- Observation: root `AGENTS.md` is read from the resolved `--base` commit,
  not the working tree or reviewed head.
  Evidence: `bin/dakar-review.mjs::readAgentInstructions()` runs
  `git ls-tree -z <commit> -- AGENTS.md` then `git show <commit>:AGENTS.md`;
  `tests/cli.test.mjs` "CLI reads AGENTS.md from the resolved commit when the
  named ref moves". Impact: nested discovery adopts the same trust rule, and
  several documents that say "the reviewed repository's `AGENTS.md`" need
  precise wording.
- Observation: `readAgentInstructions()` does not inspect the tree entry
  mode, so a committed symbolic link named `AGENTS.md` would have its target
  path read as instruction text; it also uses `spawnSync` with the default
  1 MiB `maxBuffer`, so a larger file probably fails with `ENOBUFS` before
  truncation. Evidence: code reading only; both are unverified and are
  confirmed with red tests in `EP-M4`. Impact: the shared adapter fixes both.
- Observation: context warm-up indexes `AGENTS.md` from the working tree
  (`scripts/context-warmup.mjs`, candidate list `['AGENTS.md', 'README.md',
  ...]`), while prompts use the trusted base. Impact: out of scope here;
  recorded in ADR 0004 as a known divergence for 2.3.2 to reconcile.
- Observation: changed paths are produced without `-z`
  (`scripts/review-state.mjs::changedFiles()`), so Git may C-quote unusual
  paths. Impact: see `Risks`; propose a follow-up roadmap task.
- Observation: the repository's test runner is Node's built-in `node:test`
  (`npm test` is `node --test`; every suite imports `node:test`). No suite
  uses `bun:test`. Impact: see decision D2.
- Observation: `scripts/build-workflow.mjs` enforces its runtime-module
  manifest against esbuild's metafile, not against a directory listing, so a
  pure module in `src/workflows/dakar-review/` that `main.ts` does not import
  does not break the workflow build. Impact: the new modules need no
  manifest entry until 2.3.2 imports them.

## Decision log

- D1. Decision: deliver 2.3.1 as an accepted design plus an executable,
  proved specification and a stderr-only observable report; defer prompt
  integration, workflow arguments, and SARIF notifications to 2.3.2.
  Rationale: the roadmap success criterion is a design definition; shipping
  the resolver now lets 2.3.2 build on proved behaviour, and stderr reporting
  lets users validate nested layouts without changing any machine contract.
  The rejected alternative, wiring nested text into prompts now, would
  pre-empt 2.3.2's packing experiment and its cost evaluation.
  Date/Author: 2026-11-17, planning agent (subject to design review).
- D2. Decision: write tests with `node:test`, `node:assert/strict`, and
  `fast-check` 4.9.0, not `bun:test`. Rationale: the request mentions
  `bun:test`, but `make test` runs `node --test` and every existing suite uses
  `node:test`; a `bun:test` suite would not run under `make test` or CI's
  `make check`, and would add a second runner. The behavioural intent
  (unit, behavioural, and end-to-end tests run by the gate) is met with the
  repository's runner. The user may overrule this at approval time.
  Date/Author: 2026-11-17, planning agent.
- D3. Decision: an instruction file is a regular Git blob (mode `100644` or
  `100755`) whose final path segment is exactly `AGENTS.md`, read from the
  trusted instruction commit. Rationale: matches today's root rule, the
  `agents.md` convention, and Codex; exact case avoids platform-dependent
  matching on case-insensitive file systems. `AGENTS.override.md`,
  `CLAUDE.md`, and `.cursorrules` are out of scope; case variants of
  `AGENTS.md` are reported, not loaded.
  Date/Author: 2026-11-17, planning agent.
- D4. Decision: an instruction file in directory `d` applies to a changed
  path `p` exactly when `d` is the root or a segment-wise prefix of `p`'s
  parent directory. The applicable files form a chain ordered from the root
  to the nearest directory. Rationale: this is the shared rule of the
  `agents.md` specification ("the closest one takes precedence"), Codex
  (root-to-current concatenation), Claude Code (nested files load for files
  in their directory), and CodeRabbit (a guideline applies to its directory
  and subdirectories). Segment-wise comparison prevents `packages/api` from
  matching `packages/api-client`.
  Date/Author: 2026-11-17, planning agent.
- D5. Decision: precedence, highest first, is (1) Dakar workflow schema,
  output, and safety rules; (2) the resolved CodeRabbit review policy,
  including `reviews.path_instructions`; (3) the nearest applicable
  `AGENTS.md`; then each farther ancestor in turn, ending with the root.
  Non-conflicting guidance from every level accumulates. Rationale: (1)
  preserves the 2.2.1 rule; (2) the review policy is configuration chosen
  explicitly for reviewing, whereas `AGENTS.md` addresses coding agents in
  general; (3) nearest-wins is the common prior-art rule.
  Date/Author: 2026-11-17, planning agent (the ranking of (2) above (3) is a
  named question for the design review).
- D6. Decision: Dakar does not try to detect semantic disagreement between
  instruction texts deterministically. "Conflicts" are reported in two
  classes: deterministic structural diagnostics with stable codes (see
  `Interfaces and dependencies`), reported now on stderr; and semantic
  conflicts, which precedence resolves inside prompts and which 2.3.2 may
  surface through model output. Rationale: prose conflict detection needs
  judgement, which belongs to the audited model lane, not to deterministic
  host code (ADR 0002).
  Date/Author: 2026-11-17, planning agent.
- D7. Decision: bounds are a per-file cap of 24,000 UTF-16 code units
  (unchanged), a discovery cap of 64 instruction files (shallowest first,
  then by code-unit path order), and a per-chain budget of 48,000 code units
  allocated nearest first, skipping any file that does not fit the remaining
  budget. Rationale: the nearest file wins conflicts, so it is the most
  important to keep whole; because one file is at most half the budget, the
  nearest two files always survive.
  Date/Author: 2026-11-17, planning agent.
- D8. Decision: an instruction file added, modified, deleted, or renamed in
  the review range keeps its trusted-base version (or absence) and yields an
  `instruction-changed-in-range` diagnostic. Rationale: the change is
  reviewed as code; it cannot instruct its own reviewer.
  Date/Author: 2026-11-17, planning agent.
- D9. Decision: formal proof with LemmaScript and Dafny covers the pure
  kernel (ancestry selection, ordering, and budget allocation); `fast-check`
  properties with an independent oracle cover the policy layer that uses
  string splitting, sorting, and maps outside the LemmaScript fragment; Git
  parsing is covered by integration tests against real fixture repositories.
  Rationale: see `Formal verification decision`.
  Date/Author: 2026-11-17, planning agent.

## Outcomes & retrospective

Not started. Record outcomes at each milestone and reconcile the ADR, design
document, users' guide, and developers' guide before marking the plan
`COMPLETE`.

## Context and orientation

Inspected base revision: `379128f` ("Adopt the documentation style guide and
rename ADRs (#27)"). Line numbers below refer to that revision; relocate
symbols with `grep -n '<symbol>' <file>`.

The CLI entry point is `bin/dakar-review.mjs`. `run()` parses options,
resolves the repository root, and calls `buildWorkflowArgs()`, which resolves
CodeRabbit configuration (`scripts/review-config.mjs::resolveReviewConfig()`),
calls `readAgentInstructions(repoRoot, options.base || 'origin/main')`, and
adds `workflowArgs.agentInstructions = { source, content, truncated }` when a
root file exists. `readAgentInstructions()` (around line 491) uses
`runTrustedInstructionGit()` (around line 469) to resolve the base with
`git rev-parse --verify --quiet <base>^{commit}`, list `AGENTS.md` with
`git ls-tree -z`, and read it with `git show`. Errors are thrown with the
prefixes `cannot resolve trusted review base`, `cannot inspect
<sha>:AGENTS.md`, and `cannot read <sha>:AGENTS.md`; the top-level `try` in
`run()` turns them into `{ ok: false, stage: 'cli', error }` on stderr with
exit status 1. In live mode (`options.dryRun` unset) `prepareLiveReview()`
calls `prepareReview()`, which runs `scripts/review-state.mjs::prepare()`
and yields `workflowArgs.prepared.changedFiles`, a sorted array of
repository-relative paths from `git diff --name-only <reviewBase>..<head>`.
Dry-run never prepares a range, so it has no changed paths.

Inside the workflow (`src/workflows/dakar-review/`), `config.ts`
(`agentInstructionsSchema`) validates `agentInstructions`, `main.ts` passes
it into `promptContext`, and `prompts.ts::agentInstructionsBlock()` renders
it with the precedence sentence "Treat these as repository-local
instructions when they do not conflict with the Dakar workflow schema,
output, and safety rules:". `policy.ts` already matches CodeRabbit
`reviews.path_instructions` globs per finder pack (`pathInstructionsFor()`,
`policyPathMatches()`); that is the precedent for path-scoped policy in
deterministic workflow code. `task-graph.ts` groups changed files into
finder packs (`ReviewTask.files: string[]`) that can span several
directories, which is why 2.3.2 will need a set of chains per pack.

Stderr diagnostics follow the pattern in `scripts/context-warmup.mjs`:
an injected `report` function writes
`dakar-review: <prefix> <JSON event>\n`, where the event object has an
`event` name and a `type`. The new report follows that pattern.

Existing tests that pin current behaviour (all `node:test`):
`tests/cli.test.mjs` ("CLI dry-run prints one machine-readable JSON result",
"CLI includes repository AGENTS.md instructions in workflow args", "CLI omits
agentInstructions when the trusted commit has no AGENTS.md", "CLI applies the
trusted AGENTS.md truncation limit exactly", "CLI preserves
trusted-instruction Git failure diagnostics", "CLI reads AGENTS.md from the
resolved commit when the named ref moves", "CLI fails closed when the trusted
instruction base is invalid", "CLI surfaces git failures while loading
trusted instructions"), `tests/workflow-prompts.test.mjs`,
`tests/workflow-config.test.mjs`, and `tests/cli-context-warmup.test.mjs`.
Reusable helpers: `tests/cli-test-support.mjs` (`runCli`, `spawnCli`,
`initFixtureRepo`, `writeFakeOdw`, `setUpAgentInstructionRepo`,
`writePreparedEchoOdw`, `setUpCaptureRepo`) and
`tests/helpers/run-workflow.mjs`. Property-test precedent:
`tests/review-state.property.test.mjs` and
`tests/workflow-properties.test.mjs` (`fast-check` 4.9.0).

Tooling: Node 22.23.4 on the host; TypeScript 6.0.3 (`tsconfig.json` is
strict with `noUncheckedIndexedAccess`, `erasableSyntaxOnly`,
`verbatimModuleSyntax`); Biome 1.9.4 for cognitive complexity; Oxlint 1.82.0
with Unicorn and deslop profiles; TypeDoc 0.28.20; markdownlint-cli2 0.23.2;
`nixie` for Mermaid; `typos-config-builder` for spelling. Dafny 4.11.0 is
installed on the host at `~/.local/bin/dafny`; LemmaScript is not yet a
dependency. Gates: `make check-fmt`, `make typecheck` (which includes
`node --check`, `tsc`, and an ODW dry run, so the `odw` CLI must be on
`PATH`), `make lint` (Biome, Oxlint, markdownlint after spelling, nixie,
docs-check), `make test` (`node --test`), and `make workflow-check`.
`make check` runs all of them.

Prior art consulted (via Firecrawl, 2026-11-17): the `agents.md`
specification (nearest file wins; explicit user prompts override); OpenAI
Codex (one file per directory from project root to the working directory,
concatenated root first so nearer files override; 32 KiB combined cap;
empty files skipped; `AGENTS.override.md`); Claude Code (nested files load
on demand for files in their directories; nearer files take precedence;
`paths` front-matter rules); CodeRabbit code guidelines (auto-discovered
`AGENTS.md` applies to its directory and subdirectories; unusable sources are
listed with reasons in the review summary without blocking the review).

Skills and documents to load before implementation: `execplans` (this
format), `odw-authoring` (workflow dialect; needed only to confirm the
workflow artefact stays unchanged), `typescript-router` then
`typescript-data-and-state` and `typescript-testing`, `fast-check`,
`lemmascript`, `hexagonal-architecture` (keep the kernel and policy pure,
with Git behind the adapter), `codegraph-mcp` (callers of
`readAgentInstructions` and `buildWorkflowArgs`), and
`en-gb-oxendict-style`. Read `docs/dakar-review-design.md` §§3, 6, 9, and 12;
`docs/developers-guide.md` §§2, 3, and 6;
`docs/users-guide.md` (sections "How much of the CodeRabbit format is
honoured" and "Context tools"); `docs/review-skill-design.md`;
`docs/complexity-antipatterns-and-refactoring-strategies.md` §§3 and 5 (keep
discovery free of the "bumpy road" pattern by using small classifiers and a
dispatcher table for diagnostics); and `docs/documentation-style-guide.md`
for ADR format.

## Conformance basis

Upstream artefacts inspected at `379128f`:

- `docs/roadmap.md` §2.3, task 2.3.1 (requires 2.2.1, complete).
- `docs/dakar-review-design.md` §6 (repository policy and `AGENTS.md`), §9
  (usefulness to agents), §11 (failure modes), §12 (verification targets).
- ADR 0002 (`docs/adrs/adr-0002-deterministic-tiered-review-cost.md`):
  deterministic host work before ODW; judgement only in model lanes.
- ADR 0001: workflow compiled from typed modules; pure modules and one
  composition root.
- `AGENTS.md` (repository): stdout contract, documentation duties, gates.
- No terms-of-reference document exists for Dakar; none is invented here.

Requirements derived for this plan:

- `REQ-applicability`: for every changed path, the design and code define
  the exact ordered set of instruction files that apply.
- `REQ-precedence`: the design states one total precedence order covering
  Dakar rules, review policy, and every applicable instruction file.
- `REQ-conflict-reporting`: every deterministic anomaly in discovery or
  application produces exactly one diagnostic with a stable code, reported
  without failing the review.
- `REQ-trust`: instruction text comes only from the trusted instruction
  commit.
- `REQ-bounds`: discovery and per-chain text are bounded, with nearest-first
  retention.
- `REQ-compat`: root-only behaviour, stdout, workflow arguments, and the
  workflow artefact are unchanged.

Gaps against the baseline: `GAP-nested` (nested files ignored),
`GAP-symlink` (symlink entry read as text), `GAP-buffer` (likely `ENOBUFS`
on large files), `GAP-visibility` (no report of which instructions apply).

Trace links:

```plaintext
roadmap 2.3.1 -> REQ-applicability -> ADR-0004 §Decision -> EP-M2, EP-M3 -> tests/instruction-scope-kernel.test.mjs, proofs (make proofs)
roadmap 2.3.1 -> REQ-precedence -> ADR-0004 §Precedence, design §6 -> EP-M1 -> docs review; EP-M3 chain order tests
roadmap 2.3.1 -> REQ-conflict-reporting -> ADR-0004 §Diagnostics -> EP-M3, EP-M5 -> tests/instruction-scope.property.test.mjs, tests/cli-instruction-scope.test.mjs
design §6 trust rule -> REQ-trust, GAP-symlink, GAP-buffer -> EP-M4 -> tests/instruction-discovery.test.mjs
REQ-bounds -> ADR-0004 §Bounds -> EP-M2 (allocation proof), EP-M4 (discovery cap)
REQ-compat -> AGENTS.md stdout rule, ADR 0001 -> EP-M4, EP-M5 -> existing tests/cli.test.mjs suites unchanged, make workflow-check
GAP-visibility -> EP-M5 -> tests/cli-instruction-scope.test.mjs
```

## Verification plan

### Abstract model

A repository-relative path is a non-empty sequence of segments
`s₁/…/sₙ/f`, each segment non-empty and neither `.` nor `..`. Its parent
directory is the segment sequence `P(p) = ⟨s₁,…,sₙ⟩` (empty for a root-level
file). A catalogue `C` is a finite set of instruction entries; each entry `e`
has a directory `dir(e)` (a segment sequence, `⟨⟩` for the root) and a text
length `len(e)` (a natural number after the per-file cap). By the Git axiom
below, no two entries share a directory.

- `isPrefix(d, q)` holds when `|d| ≤ |q|` and `d[i] = q[i]` for every
  `i < |d|`.
- `chain(C, p)` is the sequence of entries `e ∈ C` with
  `isPrefix(dir(e), P(p))`, sorted by `|dir(e)|` ascending.
- `governing(C, p)` is the last element of `chain(C, p)` when non-empty.
- `allocate(L, B)`, for chain lengths `L = ⟨l₀,…,lₖ⟩` in root-to-nearest
  order and budget `B`, walks indices from `k` down to `0` keeping index `i`
  when `lᵢ ≤ remaining` and subtracting `lᵢ`; it returns the kept indices in
  ascending order.

Malformed paths (absolute, C-quoted, empty or dot segments) are rejected by
the policy layer before the kernel is called and receive only the root entry
plus an `unresolvable-path` diagnostic.

### Invariants and lemmas

- `INV-sound` (`REQ-applicability`): every entry in `chain(C, p)` satisfies
  `isPrefix(dir(e), P(p))`.
- `INV-complete` (`REQ-applicability`): every `e ∈ C` with
  `isPrefix(dir(e), P(p))` appears in `chain(C, p)`.
- `INV-order` (`REQ-precedence`): directory depths in `chain(C, p)` are
  strictly increasing, so the chain has no duplicates and its last element
  is the nearest ancestor.
- `INV-segment` (`REQ-applicability`): `isPrefix` compares whole segments;
  `⟨packages, api⟩` is not a prefix of `⟨packages, api-client⟩`.
- `INV-root` (`REQ-applicability`): if the root entry exists, it is the first
  element of every chain.
- `INV-locality`: adding an entry at directory `d` changes `chain(C, p)` only
  for paths with `isPrefix(d, P(p))`, and for those it inserts exactly that
  entry.
- `INV-budget` (`REQ-bounds`): the kept lengths sum to at most `B`.
- `INV-budget-nearest` (`REQ-bounds`): an index is dropped only if, at its
  turn, its length exceeded the remaining budget; consequently, when every
  `lᵢ ≤ B/2`, the two nearest entries are always kept.
- `INV-budget-order`: kept indices are a strictly increasing subsequence of
  the chain indices, preserving root-to-nearest rendering order.
- `INV-trust` (`REQ-trust`): instruction text equals the blob at the trusted
  commit; working-tree and reviewed-head edits never change it.
- `INV-diagnostic` (`REQ-conflict-reporting`): each skipped, ignored,
  truncated, budget-dropped, changed-in-range, or unresolvable item yields
  exactly one diagnostic with its code and repository-relative path, and
  diagnostics are sorted by `(code, path)`.
- `INV-determinism`: the policy result is identical under any permutation of
  the catalogue entries and of the changed paths.
- `INV-compat` (`REQ-compat`): for a repository whose only instruction file
  is the root `AGENTS.md`, the workflow arguments are byte-identical to the
  baseline.
- `L-chain-from-filter`: `chain` equals the depth-sorted filter of `C` by
  `isPrefix`; this connects the loop implementation to `INV-sound`,
  `INV-complete`, and `INV-order`.
- `L-allocate-spec`: the loop implementation of `allocate` equals the
  recursive specification above; this connects it to the budget invariants.

### Axioms (trusted, not verified here)

- `AXIOM-git-tree`: `git ls-tree -r -z -l <commit>` prints one record per
  blob as `<mode> SP <type> SP <object> SP+ <size> TAB <path> NUL`, with
  `/`-separated paths, no empty, `.`, or `..` segments, and at most one entry
  per name in a directory (Git's tree format and `fsck` rules). Boundary:
  `scripts/instruction-discovery.mjs` parser; exercised by integration tests
  against real repositories.
- `AXIOM-git-blob`: `git cat-file blob <object>` returns the exact blob
  bytes. Boundary: discovery adapter.
- `AXIOM-lemmascript-model`: LemmaScript at the pinned version translates the
  kernel's supported fragment faithfully (arrays as sequences, `number` as
  mathematical integers). Boundary: kernel module; mitigated by
  `fast-check` running the same functions at runtime.
- `AXIOM-dafny`: Dafny 4.11.0 and Z3 are sound. Boundary: `make proofs`.
- `AXIOM-js-length`: `String.prototype.length` counts UTF-16 code units, and
  `slice(0, n)` keeps the first `n` code units. Boundary: per-file cap.

### Methods per obligation

- Obligation: `INV-sound`, `INV-complete`, `INV-order`, `INV-root`,
  `INV-segment`, `L-chain-from-filter`.
  Method: formal proof (LemmaScript to Dafny) plus a table test and a
  `fast-check` property against an independent oracle.
  Rationale: these are the contractual core of 2.3.1; they must hold for all
  inputs, and they sit inside the LemmaScript fragment.
  Domain: all segment sequences and catalogues of distinct directories.
  Artefact: `src/workflows/dakar-review/instruction-scope-kernel.ts`
  (`//@ verify` annotations), `src/workflows/dakar-review/instruction-scope-kernel.dfy`
  (helper lemmas only), `tests/instruction-scope-kernel.test.mjs`.
  Evidence: `make proofs` reports every obligation verified with zero
  errors; before helper lemmas are written it reports open postconditions.
  The table test fails red with "Cannot find module" before the module
  exists. Discharge: Dafny verification succeeds with no `assume`, no
  `{:axiom}` other than those LemmaScript emits for declared externs (there
  should be none), and the `.dfy` diff over `.dfy.gen` is additions only.
  Non-vacuity: the proof's preconditions (distinct directories) are
  satisfied by the table witnesses `⟨⟩`, `⟨packages⟩`, `⟨packages, api⟩`;
  a seeded fault that replaces the segment comparison with a string-prefix
  test on joined paths, and a second that uses `<` instead of `≤` on
  lengths, must each make `make proofs` fail on the soundness or
  completeness postcondition and make the property test fail with a
  shrunk counterexample such as `packages/api` against
  `packages/api-client/x.ts`. Revert each fault with `git checkout --`
  on the kernel file and delete any regenerated `.dfy.gen` difference.
- Obligation: `INV-budget`, `INV-budget-nearest`, `INV-budget-order`,
  `L-allocate-spec`.
  Method: formal proof plus a `fast-check` property comparing against an
  independent oracle that enumerates the specification directly.
  Rationale: allocation decides which instructions survive; it is
  contractual and integer-only.
  Domain: arrays of natural numbers of length 0 to 64, budgets 0 to
  200,000.
  Artefact: same kernel module and proof file;
  `tests/instruction-scope.property.test.mjs`.
  Evidence: as above. Non-vacuity: `fc.statistics` classification must show
  generated cases with no drops, some drops, and all dropped; a seeded fault
  that allocates root first must fail `INV-budget-nearest`.
- Obligation: `INV-locality`, `INV-determinism`, `INV-diagnostic`.
  Method: `fast-check` properties over generated trees and changed-path
  sets, with an oracle that recomputes chains by brute-force string
  splitting written independently in the test file.
  Rationale: these involve splitting, sorting, and maps outside the
  LemmaScript fragment.
  Domain: trees of up to 6 levels and 40 directories drawn from a small
  segment alphabet (`a`, `b`, `ab`, `a-b`) so that prefix-collision cases
  occur often; changed paths up to 60.
  Artefact: `tests/instruction-scope.property.test.mjs`.
  Evidence: `node --test tests/instruction-scope.property.test.mjs` passes
  with recorded seeds; failures print the seed and path for replay.
  Non-vacuity: classify and require (via `fc.statistics` thresholds checked
  in the test) at least 10% of runs with a nested chain of length at least 3
  and at least 10% containing a near-miss sibling such as `a` and `ab`; a
  seeded fault that forgets to sort diagnostics must fail determinism.
- Obligation: `INV-trust`, `GAP-symlink`, `GAP-buffer`, discovery cap.
  Method: integration tests against real temporary Git repositories.
  Rationale: the behaviour depends on Git's real output (`AXIOM-git-tree`).
  Artefact: `tests/instruction-discovery.test.mjs`.
  Evidence: red first for symlink and oversized cases against the old root
  reader (the oversized test documents whether `ENOBUFS` actually occurred);
  green after the adapter lands. Non-vacuity: the trust test commits
  different text at base and head and edits the working tree, then asserts
  the base text; the test fails if the adapter reads `HEAD`.
- Obligation: `INV-compat`, `GAP-visibility`, stdout contract.
  Method: CLI end-to-end tests with the fake ODW helper.
  Artefact: existing `tests/cli.test.mjs` suites unchanged, new
  `tests/cli-instruction-scope.test.mjs`.
  Evidence: existing suites pass without modification; new suites assert
  stdout parses as one JSON value and stderr contains exactly one
  `instruction_scope` summary event.

### Formal verification decision

A formal proof is proportionate for the kernel because applicability and
retention are the contract this roadmap item exists to define, they are pure
integer and sequence computations, and an error would silently give the wrong
instructions to a reviewer. LemmaScript keeps the proof attached to the
shipped TypeScript rather than to a parallel model. Model checking adds
nothing here: there is no concurrency or protocol state. The proof does not
cover string normalization, Git parsing, or stderr formatting; those are
covered by property and integration tests and the axioms above. Recorded as
D9.

### Suggested BDD features

The repository has no BDD runner and this plan does not add one. The
following proposed scenarios are exercised by named `node:test` cases in
`tests/cli-instruction-scope.test.mjs` (`EP-M5`) and
`tests/instruction-scope.test.mjs` (`EP-M3`); the feature text lives only in
this plan.

```gherkin
Feature: Nested AGENTS.md instruction scope
  Scenario: Nested instructions apply to files beneath their directory
    Given a trusted base with AGENTS.md and packages/api/AGENTS.md
    And a review range that changes packages/api/src/routes.ts
    When dakar-review prepares the review
    Then stderr reports the chain AGENTS.md, packages/api/AGENTS.md for one changed path
    And stdout contains exactly one JSON result

  Scenario: Sibling directories with a shared prefix do not inherit
    Given a trusted base with packages/api/AGENTS.md
    And a review range that changes packages/api-client/index.ts
    Then the reported chain for that path is AGENTS.md only

  Scenario: An instruction file changed in the range is not obeyed
    Given packages/api/AGENTS.md differs between the base and the reviewed head
    When dakar-review prepares the review
    Then stderr reports instruction-changed-in-range for packages/api/AGENTS.md
    And the applied text is the base version

  Scenario: A symbolic link named AGENTS.md is skipped
    Given the trusted base commits AGENTS.md as a symbolic link
    When dakar-review runs
    Then stderr reports instruction-symlink-skipped for AGENTS.md
    And the workflow arguments contain no agentInstructions

  Scenario: Case variants are reported, not loaded
    Given the trusted base contains packages/web/agents.md
    Then stderr reports case-variant-ignored for packages/web/agents.md
```

Links: scenarios 1 and 2 trace to `REQ-applicability` and `EP-M5`; 3 to
`REQ-trust` and `EP-M4`/`EP-M5`; 4 to `GAP-symlink` and `EP-M4`; 5 to
`REQ-conflict-reporting` and `EP-M3`.

## Plan of work

### `EP-M0` LemmaScript feasibility probe (prototype)

Question: can the pinned LemmaScript release, with Dafny 4.11.0, verify a
nested loop over `string[][]` with a segment-prefix predicate and a
nearest-first allocation loop, written in a style that also passes this
repository's `tsc`, Oxlint, and TypeDoc gates? Work in a scratch directory
outside the repository (for example `/tmp/dakar-lsc-probe`), copying
`tsconfig.json`. Write a 40-line `probe.ts` with `isPrefix` and `allocate`
annotated as in `Interfaces and dependencies`, then run
`npx --yes --package=lemmascript@<version> -- lsc check --backend=dafny probe.ts`.
Choose `<version>` as the latest release that passes; start with 0.6.10.
Go: both functions verify (adding helper lemmas in `probe.dfy` is allowed).
No-go: the tool rejects the fragment; then escalate with the error text and
the alternatives (a Dafny model maintained beside the code with a
`fast-check` conformance test, or dropping the proof). Record the transcript
in `Artefacts and notes`; delete the scratch directory afterwards. Nothing
is committed in this milestone except plan updates.

### `EP-M1` design recorded

Assigned: `REQ-applicability`, `REQ-precedence`, `REQ-conflict-reporting`,
`REQ-trust`, `REQ-bounds`; decisions D1 and D3 to D8.

Create `docs/adrs/adr-0004-scope-nested-agents-instructions.md` in the
house ADR format (`# Architectural decision record (ADR) 0004: Scope nested
AGENTS.md instructions by directory ancestry`; sections Status, Date,
Context and problem statement, Decision drivers, Options considered,
Decision outcome, Consequences, Known risks and limitations, References).
Options considered: root only (status quo); nearest file only (no
inheritance); full root-to-nearest chain with nearest-wins precedence
(chosen); glob-scoped front matter as in Claude Code rules (rejected for v1:
new syntax, no portability). The decision outcome states D3 to D8 normatively
with the diagnostic code table, and a Mermaid flowchart (with a screen-reader
sentence and caption) of discovery, scoping, and reporting. Status is
`Proposed` until the user approves this plan, then `Accepted`.

Rewrite `docs/dakar-review-design.md` §6's final paragraph into a subsection
"Instruction discovery and precedence" that summarizes the ADR rules, keeps
the root rule, and names the 2.3.1 reporting surface (stderr) and the 2.3.2
consumer. Add the terms "instruction file", "instruction chain",
"governing instruction file", "trusted instruction commit", and "instruction
diagnostic" to §3. Add the invariants `INV-sound`, `INV-complete`,
`INV-order`, `INV-trust`, and `INV-budget-nearest` to §12 in prose. Update
§2's goal "Use CodeRabbit YAML and root `AGENTS.md`" to mention nested
discovery. Add the ADR to `docs/contents.md` and to the design document's
front matter.

Validation: `make check-fmt`, `make lint` (spelling, markdownlint, nixie,
docs-check), `make typecheck`, `make test`, all passing; no code changes.
Commit: "Record the nested AGENTS.md scoping design (ADR 0004)".

### `EP-M2` ancestry and budget kernel with proof

Assigned: `INV-sound`, `INV-complete`, `INV-order`, `INV-root`,
`INV-segment`, `INV-budget*`, `L-chain-from-filter`, `L-allocate-spec`;
decision D9.

Red: add `tests/instruction-scope-kernel.test.mjs` with table tests for
`isSegmentPrefix`, `applicableIndices`, and `allocateNearestFirst`
(witnesses: root only; `packages` and `packages/api`; the near-miss
`packages/api` against `packages/api-client`; equal depth siblings; empty
catalogue; budget exactly equal to a length; zero budget). Run
`node --test tests/instruction-scope-kernel.test.mjs`; expect failure because
the module does not exist.

Green: add `src/workflows/dakar-review/instruction-scope-kernel.ts` with the
three functions over `readonly (readonly string[])[]`, `readonly string[]`,
and `readonly number[]`, using `while` loops with `//@ invariant` and
`//@ decreases` annotations and `//@ ensures` postconditions expressing the
invariants. Add `lemmascript` at the exact version chosen in `EP-M0` to
`devDependencies`, run `npm install`, add `LemmaScript-files.txt` listing the
kernel, and add a Makefile target:

```make
proofs:
	@npx lsc check --backend=dafny src/workflows/dakar-review/instruction-scope-kernel.ts
```

(add `proofs` to `.PHONY`; keep it out of `check` so hosts without Dafny can
still run the main gate). Run `npx lsc gen --backend=dafny …`, commit the
generated `.dfy.gen`, and add helper lemmas only in the `.dfy`. Run
`make proofs` until verified. Add property tests for the budget obligations
in `tests/instruction-scope.property.test.mjs` with an independent oracle.

Refactor: keep each function under Biome's complexity threshold and free of
Oxlint findings; confirm the `.dfy` diff over `.dfy.gen` is additions only;
run the seeded faults in the verification plan and record their rejection.

Validation: `make check-fmt`, `make typecheck`, `make lint`, `make test`,
`make proofs`. Commit: "Add the proved instruction-scope kernel".

### `EP-M3` instruction-scope policy

Assigned: `REQ-precedence`, `REQ-conflict-reporting`, `INV-locality`,
`INV-determinism`, `INV-diagnostic`, malformed-path handling.

Red: add `tests/instruction-scope.test.mjs` with named cases for each
diagnostic code, malformed paths, the example in `Purpose / big picture`,
changed-in-range handling, the discovery cap ordering, and per-file
truncation; extend `tests/instruction-scope.property.test.mjs` with the
locality, determinism, and diagnostic properties. Expect "Cannot find
module".

Green: add `src/workflows/dakar-review/instruction-scope.ts` exporting the
types and functions in `Interfaces and dependencies`. It splits paths into
segments, validates them, builds a catalogue from discovered entries
(applying the per-file cap and the discovery cap, and classifying skipped
entries), calls the kernel for each changed path, groups paths that share an
identical chain, applies the chain budget per group, and returns a frozen
`InstructionScopeReport` with diagnostics sorted by code then path. Use a
lookup table from diagnostic code to severity rather than a branching
ladder. Sort with code-unit comparison, never `localeCompare`.

Refactor and validate as before, including `make proofs`. Commit: "Add the
instruction-scope policy and diagnostics".

### `EP-M4` trusted Git discovery adapter

Assigned: `REQ-trust`, `GAP-symlink`, `GAP-buffer`, `INV-compat`.

Red: add `tests/instruction-discovery.test.mjs` that builds temporary Git
repositories (reuse `initFixtureRepo` from `tests/cli-test-support.mjs`)
covering: nested files; a symbolic link named `AGENTS.md` at the root and
nested; an executable `AGENTS.md` (mode `100755`, accepted); a case variant;
a root file larger than 1 MiB; base-versus-head-versus-working-tree trust;
more than 64 instruction files; a missing base ref; a path containing a
space and a non-ASCII character. Add one red case to `tests/cli.test.mjs`
only for the symlink and oversized root behaviour, because those
deliberately change.

Green: add `scripts/instruction-discovery.mjs` with
`createGitTreeReader(repoRoot)` (the driven adapter: `resolveCommit`,
`listInstructionCandidates`, `readBlob`, using `spawnSync` with explicit
`maxBuffer` values and `-z` output) and
`discoverInstructionCatalogue(reader, baseRef, options)` (the application
service that resolves the commit, lists candidates with
`git ls-tree -r -z -l --full-tree <commit>`, reads accepted blobs, and calls
the policy's catalogue builder). Replace the body of
`readAgentInstructions()` in `bin/dakar-review.mjs` with a call that takes
the root entry from the catalogue, preserving its error prefixes and the
`{ source, content, truncated }` shape. Add the new script to `NODE_MODULES`
in the Makefile and to `EXTERNAL_MODULES` in `scripts/build-cli.mjs` only if
the existing scripts pattern requires it (follow how
`scripts/review-config.mjs` is treated); rebuild the bundle with
`make workflow-build`.

Validation: all existing `tests/cli.test.mjs` cases pass unchanged except
the two deliberately changed behaviours; full gates and `make proofs`.
Commit: "Discover AGENTS.md files from the trusted base".

### `EP-M5` CLI stderr scope report

Assigned: `GAP-visibility`, `REQ-conflict-reporting`, BDD scenarios.

Red: add `tests/cli-instruction-scope.test.mjs` implementing the five
scenarios, using a fake ODW that echoes prepared arguments, asserting the
stderr `instruction_scope` event shape, that stdout is one JSON value, and
that `receivedArgs` is byte-identical to a root-only baseline. Expect no
event on stderr.

Green: in `bin/dakar-review.mjs`, keep the discovered catalogue from
`buildWorkflowArgs()` (dry-run and live), emit a `type: "catalogue"` event
listing discovered files and catalogue diagnostics (dry-run has no range),
and in `prepareLiveReview()` after preparation call the policy with
`prepared.changedFiles` and the instruction files touched in the range, then
emit the `type: "summary"` event described in `Purpose / big picture`.
Use an injected `report` function as `scripts/context-warmup.mjs` does.
List instruction-file paths, but report changed paths only as counts per
group. Cap `groups` at 50 entries and record the overflow count. Keep
`run()` and `prepareLiveReview()` under the Biome complexity limit by
extracting a small `reportInstructionScope()` helper. Rebuild the bundle.

Validation: full gates and `make proofs`. Commit: "Report nested AGENTS.md
scope on stderr".

### `EP-M6` documentation, CI, and closure

Update `docs/users-guide.md` (new subsection "Nested `AGENTS.md` files"
under "How much of the CodeRabbit format is honoured": discovery rule,
precedence, bounds, the stderr report and every diagnostic code with the
action a user should take, and the explicit statement that prompts still use
only the root file until 2.3.2); `docs/developers-guide.md` §3 (module
ownership: kernel, policy, adapter; the proof workflow with `make proofs`,
`lsc regen`, and the additions-only rule; how to add a diagnostic code) and
§1 (local validation now includes `make proofs` with Dafny 4.11.0);
`skills/dakar-review/SKILL.md` configuration section (one sentence);
`docs/repository-layout.md` (new files); and `docs/roadmap.md` (mark 2.3.1
done, and add under 2.3.2 a note that it consumes
`InstructionScopeReport`). Add a CI step to `.github/workflows/ci.yml` that
installs Dafny 4.11.0 from the pinned GitHub release archive and runs
`make proofs` after `npm ci`. Search for stale claims with
`grep -rn "root \`AGENTS.md\`\|root AGENTS.md" docs README.md skills`
(excluding `docs/execplans/`) and correct each. Mark ADR 0004 `Accepted`.

Validation: full gates and `make proofs`; reconcile `Outcomes &
retrospective`. Commit: "Document nested AGENTS.md scope and close 2.3.1".

## Milestones and plateaus

- `EP-M0`: probe verdict recorded; repository unchanged except this plan.
  Recovery: delete the scratch directory. Compatibility: none.
- `EP-M1`: the design is the accepted source of truth; no behaviour change.
  Conformance: requirements stated; no interface change. Recovery: revert
  the commit. Remaining: implementation.
- `EP-M2`: the kernel exists, is proved, and is tested, but nothing calls
  it. Conformance: pure module, no imports outside the module; no workflow
  manifest change. Recovery: revert; `npm ci` restores the lockfile.
  Remaining: policy, adapter, report.
- `EP-M3`: the policy produces complete reports from in-memory catalogues.
  Conformance: pure; diagnostics match ADR 0004's table exactly.
  Recovery: revert.
- `EP-M4`: the CLI reads root instructions through the shared adapter; two
  deliberate behaviour changes (symlink skip, oversized truncation) are
  tested. Conformance: trust rule unchanged; stdout and workflow arguments
  unchanged for regular root files. Recovery: revert this commit and
  rebuild the bundle.
- `EP-M5`: users see instruction scope on stderr. Conformance: stdout,
  arguments, and workflow artefact unchanged. Recovery: revert and rebuild
  the bundle; earlier plateaus remain valid.
- `EP-M6`: documentation and CI match behaviour; roadmap updated.
- Compatibility decision for every milestone: none. The modules are new and
  internal; the CLI is pre-1.0 (`package.json` version 0.1.0); no
  compatibility layer is introduced.

## Concrete steps

Working directory: the repository root. Use `set -o pipefail` in the shell
before every piped gate so failures propagate through `tee`.

```bash
set -o pipefail
BRANCH=$(git branch --show-current)
make check-fmt 2>&1 | tee /tmp/check-fmt-dakar-$BRANCH.out
make typecheck 2>&1 | tee /tmp/typecheck-dakar-$BRANCH.out
make lint 2>&1 | tee /tmp/lint-dakar-$BRANCH.out
make test 2>&1 | tee /tmp/test-dakar-$BRANCH.out
make workflow-check 2>&1 | tee /tmp/workflow-check-dakar-$BRANCH.out
make proofs 2>&1 | tee /tmp/proofs-dakar-$BRANCH.out   # from EP-M2
```

Focused commands by milestone:

```plaintext
EP-M2 red:   node --test tests/instruction-scope-kernel.test.mjs -> fails: Cannot find module '../src/workflows/dakar-review/instruction-scope-kernel.ts'
EP-M2 green: node --test tests/instruction-scope-kernel.test.mjs -> all pass; make proofs -> "verified, 0 errors"
EP-M3 red:   node --test tests/instruction-scope.test.mjs -> fails: Cannot find module
EP-M3 green: node --test tests/instruction-scope.test.mjs tests/instruction-scope.property.test.mjs -> all pass
EP-M4 red:   node --test tests/instruction-discovery.test.mjs -> fails: Cannot find module; symlink case in tests/cli.test.mjs fails (link target read as text)
EP-M4 green: node --test tests/instruction-discovery.test.mjs tests/cli.test.mjs -> all pass
EP-M5 red:   node --test tests/cli-instruction-scope.test.mjs -> fails: no instruction_scope event on stderr
EP-M5 green: same command -> all pass
```

Known baseline: `make typecheck` needs the `odw` CLI on `PATH` for its dry
run; `make spelling` needs network access to fetch the pinned
`typos-config-builder`. If either is unavailable, record it here with the
exact error and do not waive the gate.

## Validation and acceptance

Acceptance is behavioural:

- In a fixture repository with the example tree from `Purpose / big
  picture`, a live CLI run against a fake ODW prints exactly one
  `instruction_scope` summary event on stderr with the two groups and the
  `case-variant-ignored` diagnostic shown there, and stdout parses as one
  JSON value.
- In a repository with only a root `AGENTS.md`, the workflow arguments
  captured by the fake ODW are byte-identical to those captured before this
  change (the existing `tests/cli.test.mjs` suites pass unmodified).
- `make proofs` verifies the kernel with zero errors, and each seeded fault
  in the verification plan is rejected.
- `make check-fmt`, `make typecheck`, `make lint`, `make test`, and
  `make workflow-check` pass after every milestone.

Quality criteria: all tests pass; every obligation in the verification plan
is discharged by its named artefact; no lint or type suppressions are added;
the workflow artefact is byte-identical to the base.

## Idempotence and recovery

Every gate and test is re-runnable. Temporary Git repositories are created
under `os.tmpdir()` and removed with `t.after()` cleanup, as existing CLI
tests do. `lsc regen` (never `gen` over an existing `.dfy`) preserves proof
work; if a regeneration conflicts, restore the `.dfy` from Git and rerun.
`make workflow-build` regenerates the CLI bundle deterministically. Each
milestone is one commit, so `git revert <commit>` followed by
`make workflow-build` and `npm ci` restores any earlier plateau.

## Artefacts and notes

Reconnaissance (2026-11-17, base `379128f`):

```plaintext
bin/dakar-review.mjs: readAgentInstructions(repoRoot, baseRef) reads <sha>:AGENTS.md via git ls-tree/show, caps 24,000 code units
scripts/review-state.mjs: changedFiles() = git diff --name-only base..head | sort (no -z)
src/workflows/dakar-review/prompts.ts: agentInstructionsBlock() precedence sentence used by taskPrompt and auditPrompt
scripts/build-workflow.mjs: RUNTIME_MODULES manifest checked against esbuild metafile inputs
dafny --version -> 4.11.0+fcb2042d6d043a2634f0854338c08feeaaaf4ae2
npm view lemmascript version -> 0.6.10 (dependencies: ts-morph ^25.0.0, lemmascript-claimcheck ^0.2.0)
```

Probe, red/green, and seeded-fault transcripts are added here as milestones
complete.

## Interfaces and dependencies

Kernel, `src/workflows/dakar-review/instruction-scope-kernel.ts` (pure,
proved; no imports):

```typescript
/** True when `prefix` equals the first `prefix.length` segments of `path`. */
export function isSegmentPrefix(prefix: readonly string[], path: readonly string[]): boolean

/**
 * Indices of `directories` that are segment prefixes of `parent`, ordered by
 * ascending directory depth. Requires distinct directories.
 */
export function applicableIndices(
  directories: readonly (readonly string[])[],
  parent: readonly string[],
): number[]

/**
 * Indices kept when allocating `budget` to `lengths` (root-to-nearest order),
 * walking nearest first and skipping entries that do not fit; returned in
 * ascending order.
 */
export function allocateNearestFirst(lengths: readonly number[], budget: number): number[]
```

Policy, `src/workflows/dakar-review/instruction-scope.ts` (pure; imports only
the kernel):

```typescript
export const INSTRUCTION_FILE_NAME = 'AGENTS.md'
export const MAX_INSTRUCTION_FILE_CHARS = 24_000
export const MAX_INSTRUCTION_FILES = 64
export const MAX_CHAIN_CHARS = 48_000

export type InstructionDiagnosticCode =
  | 'case-variant-ignored'
  | 'instruction-symlink-skipped'
  | 'instruction-not-regular-file'
  | 'instruction-file-too-large'
  | 'instruction-truncated'
  | 'discovery-limit-exceeded'
  | 'chain-budget-exceeded'
  | 'instruction-changed-in-range'
  | 'unresolvable-path'
  | 'instruction-discovery-failed'

export interface InstructionDiagnostic {
  readonly code: InstructionDiagnosticCode
  readonly severity: 'note' | 'warning'
  readonly path: string // repository-relative; '' for whole-catalogue diagnostics
  readonly detail?: string
}

export interface TreeCandidate { readonly path: string; readonly mode: string; readonly size: number }
export interface InstructionFile {
  readonly path: string            // e.g. 'packages/api/AGENTS.md'
  readonly directory: readonly string[]
  readonly content: string         // capped at MAX_INSTRUCTION_FILE_CHARS
  readonly truncated: boolean
}
export interface InstructionCatalogue {
  readonly trustedCommit: string
  readonly files: readonly InstructionFile[]   // sorted by depth, then path
  readonly diagnostics: readonly InstructionDiagnostic[]
}
export interface InstructionChainGroup {
  readonly chain: readonly string[]           // instruction file paths, root first
  readonly keptChain: readonly string[]        // after the chain budget
  readonly changedPaths: readonly string[]
}
export interface InstructionScopeReport {
  readonly trustedCommit: string
  readonly groups: readonly InstructionChainGroup[]
  readonly diagnostics: readonly InstructionDiagnostic[]
}

/** Classify tree candidates into instruction files to read and diagnostics. */
export function selectInstructionCandidates(candidates: readonly TreeCandidate[]): {
  readonly accepted: readonly TreeCandidate[]
  readonly diagnostics: readonly InstructionDiagnostic[]
}
/** Build a capped catalogue from accepted files and their decoded text. */
export function buildInstructionCatalogue(
  trustedCommit: string,
  texts: readonly { readonly path: string; readonly content: string }[],
  diagnostics: readonly InstructionDiagnostic[],
): InstructionCatalogue
/** Resolve the chain for every changed path and report diagnostics. */
export function resolveInstructionScope(
  catalogue: InstructionCatalogue,
  changedPaths: readonly string[],
): InstructionScopeReport
```

Final names may be adjusted during implementation if TypeDoc or lint rules
require it; any change to the diagnostic codes must be mirrored in ADR 0004
and the users' guide in the same commit.

Adapter, `scripts/instruction-discovery.mjs` (host; Node built-ins only):
`createGitTreeReader(repoRoot)` returns
`{ resolveCommit(ref), listCandidates(commit), readBlob(commit, path, maxBytes) }`;
`discoverInstructionCatalogue(reader, baseRef)` returns an
`InstructionCatalogue`. Ports are plain objects of functions, not classes;
tests substitute an in-memory reader for application-level cases and use
real repositories for adapter cases. Severity table: `warning` for
`instruction-symlink-skipped`, `instruction-not-regular-file`,
`instruction-file-too-large`, `discovery-limit-exceeded`,
`chain-budget-exceeded`, `instruction-discovery-failed`; `note` for the
rest.

Dependencies: `lemmascript` (exact version from `EP-M0`, development only).
No runtime dependency is added; `zod` and `js-yaml` are unchanged. Dafny
4.11.0 is a host and CI tool.

## Revision note

- 2026-11-17: initial draft from reconnaissance and prior-art research;
  awaiting the community-of-experts design review and user approval.
