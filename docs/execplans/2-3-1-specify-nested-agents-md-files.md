# 2.3.1 Specify instruction discovery and precedence for nested `AGENTS.md` files

This ExecPlan (execution plan) is a living document. The sections `Constraints`,
`Tolerances`, `Risks`, `Progress`, `Surprises & discoveries`, `Decision log`,
`Outcomes & retrospective`, `Conformance basis`, and `Verification plan` must
be kept up to date as work proceeds.

Status: DRAFT (design review applied; awaiting user approval; see "Approval
questions")

Branch: `2-3-1-specify-nested-agents-md-files`

Roadmap item: `2.3.1` in `docs/roadmap.md`.

## Purpose / big picture

Dakar is a code-review tool. Its command-line interface (CLI), `dakar-review`,
prepares an unreviewed commit range on the host and then runs an Open Dynamic
Workflows (ODW) workflow in which language-model agents ("finders") propose
findings and one "audit" agent accepts or rejects them. Repository-local
instructions for coding agents live in Markdown files named `AGENTS.md`. Today
Dakar reads only the repository-root `AGENTS.md`, from the trusted review base
commit (by default `origin/main`), truncates it to 24,000 characters, and
passes it to every prompt. Large repositories, especially monorepos, put further
`AGENTS.md` files in subdirectories, for example `packages/api/AGENTS.md`, and
expect them to govern only the files beneath them. Dakar ignores them.

Roadmap item 2.3.1 asks for a specification: "the design defines which
instruction files apply to each changed path and how conflicts are reported."
Roadmap item 2.3.2 ("Prototype task-level instruction packs") will later feed
the selected text into finder and audit prompts and report diagnostics in the
review result. This plan reads "conflicts" in two senses and the design states
that reading in its first paragraph: semantic disagreement between instruction
texts, which a fixed precedence order resolves; and structural anomalies (a
symbolic link named `AGENTS.md`, an oversized file, an instruction file changed
by the reviewed change, a file moved between instruction scopes), which produce
diagnostics with stable codes.

This plan delivers:

1. An accepted design: a new architecture decision record (ADR),
   `docs/adrs/adr-0004-scope-nested-agents-instructions.md`, and revisions to
   `docs/dakar-review-design.md` §§2, 3, 4, 6, 11, and 12.
2. An executable specification: a pure resolver shared by the CLI now and the
   workflow in 2.3.2. Its kernel (segment-wise ancestry and budget selection)
   is proved for all inputs with LemmaScript and Dafny; its policy layer is
   covered by table tests and `fast-check` properties.
3. A Git adapter that discovers instruction files by ancestry from the trusted
   base commit, never from the working tree or the reviewed head.
4. Two user-visible trust fixes that the design depends on: the root
   `AGENTS.md` is loaded through the new adapter (a committed symbolic link is
   skipped instead of its target path being read as text, an oversized file is
   truncated instead of crashing the CLI, and a `--repo-root` inside a
   subdirectory still finds the repository-root file); and the pi agent
   adapters stop loading `AGENTS.md` and `CLAUDE.md` from the agent's working
   copy, which today lets a pull request instruct its own reviewer.

A small example. Given this tree at the trusted base:

```plaintext
AGENTS.md
packages/api/AGENTS.md
packages/api/src/AGENTS.md
packages/web/agents.md
```

and a change to `packages/api/src/routes.ts`, `packages/api-client/index.ts`,
and `packages/web/app.tsx`, the design says:

- `packages/api/src/routes.ts` has the instruction chain `AGENTS.md`,
  `packages/api/AGENTS.md`, `packages/api/src/AGENTS.md` (root first, nearest
  last); the nearest file wins any conflict.
- `packages/api-client/index.ts` has the chain `AGENTS.md` only, because
  ancestry is compared segment by segment and `packages/api` is not an ancestor
  of `packages/api-client`.
- `packages/web/app.tsx` has the chain `AGENTS.md` only, and a
  `name-case-variant` diagnostic reports that `packages/web/agents.md` is not
  an instruction file, because the name match is exact and case-sensitive.

After this change, a developer can observe that result directly with the new
integration test `tests/instruction-discovery.test.mjs`, which builds that
repository and asserts the report returned by
`discoverInstructionScope(reader, { baseRef, headRef, changedPaths })`. A user
observes the two trust fixes through the CLI. The design names the review
result JSON (beside the existing `ignoredPolicyKeys`) and SARIF tool
notifications as the user-facing reporting surface that 2.3.2 implements.

Preserved behaviour: the `agentInstructions` workflow argument keeps its shape
(`{ source, content, truncated }`), source label (`<sha>:AGENTS.md`),
24,000-code-unit truncation, and error prefixes; Git failures while loading
trusted instructions still fail the run closed; stdout remains reserved for the
final JSON or Markdown result; `workflows/dakar-review.js` is unchanged.
Deliberately changed behaviour: the symbolic-link, oversized-file, subdirectory
`--repo-root`, and pi context-file cases above.

## Approval questions

These need an explicit answer when approving the plan. The plan proceeds with
the stated default if the user approves without comment.

1. Test runner (decision D2). The request names `bun:test`; the repository
   runs every suite with `node --test`, and `make test` and CI would never run a
   `bun:test` file. Default: use `node:test` with `fast-check`.
2. Reporting surface (decision D1). The panel recommended deferring the stderr
   scope report drafted earlier, because 2.3.2 will report in the result JSON
   and a stderr event would become a provisional contract. Default: no new
   stderr event in 2.3.1; the root diagnostics print one human-readable warning
   line each. Alternative: reinstate a provisional stderr `instruction_scope`
   event (adds about 250 code and 70 documentation lines).
3. pi context files (decision D10). Default: add `--no-context-files` to every
   pi Flex adapter in `odw.config.json`. This changes live agent behaviour:
   agents stop seeing the working copy's `AGENTS.md`, `CLAUDE.md`, and global
   context files, and see only what Dakar puts in the prompt.
4. Proof tooling location (decision D9). `lemmascript@0.6.10` transitively
   installs cloud-provider SDKs (through `lemmascript-claimcheck` and
   `claimcheck`). Default: an isolated `proofs/` package with its own exact
   pins and lockfile, installed only by `make proofs` and the CI proof job,
   instead of a root `devDependency`.
5. Roadmap follow-ups (decision D12). Default: add three follow-up tasks to
   `docs/roadmap.md` (NUL-delimited changed paths, single resolution of the
   trusted base, and excluding instruction files from context warm-up), and
   make the last a prerequisite of 2.3.2.

## Constraints

- Implementation begins only after the user explicitly approves this plan.
- Do not change prompt text, the `agentInstructions` argument shape,
  `workflowArgsSchema`, the workflow result shape, SARIF output, or
  `workflows/dakar-review.js`. Feeding nested instructions to agents and
  reporting diagnostics in the result belong to 2.3.2.
- Keep stdout reserved for the final JSON or Markdown result (`AGENTS.md`
  repository rule). Warnings go to stderr.
- Read instruction text only from the trusted instruction commit: the
  resolved `--base` ref (default `origin/main`), as `readAgentInstructions()` in
  `bin/dakar-review.mjs` does today. Never read instruction text from the
  working tree, the reviewed head, or `prepared.reviewBase` (which, once review
  history exists, is a commit the change author wrote). ADR 0004 records this
  as a rule that must not be unified away.
- Git failures (cannot resolve the base, cannot list, cannot read, timeout,
  buffer overflow) fail closed with the existing error prefixes
  `cannot resolve trusted review base <ref>`, `cannot inspect <sha>:AGENTS.md`,
  and `cannot read <sha>:AGENTS.md`. Only per-entry content anomalies degrade
  to diagnostics.
- The kernel and policy modules are pure: no `node:` imports, no file system,
  no Git, no clock, no randomness (`Date.now()`, `Math.random()`, and
  argument-less `new Date()` are forbidden by `AGENTS.md`). They live in
  `src/workflows/dakar-review/` because the CLI (which already imports
  `pricing.ts` and `retry.ts` from there) and, in 2.3.2, the workflow consume
  them. Use erasable TypeScript, explicit `.ts` sibling imports, and acyclic ES
  modules.
- Git access lives only in the adapter `scripts/instruction-discovery.mjs`.
  Domain modules never import from `scripts/` or `bin/`.
- The adapter imports the TypeScript policy module, so it must be bundled into
  `bin/dakar-review.bundle.mjs`. Do **not** add it to `EXTERNAL_MODULES` in
  `scripts/build-cli.mjs`: the scripts listed there (`review-config.mjs` among
  them) stay outside the bundle and import no `.ts` file, and the installed CLI
  cannot load TypeScript from `node_modules` (see the module comment in
  `scripts/build-cli.mjs`). Follow `scripts/context-warmup.mjs`, which is
  bundled.
- Every new JavaScript or TypeScript module starts with a `/** … @module */`
  block and documents every export, because `make docs-check` runs TypeDoc with
  zero-warning validation. Do not use `@file` headers.
- `bin/dakar-review.bundle.mjs` is generated by `make workflow-build`; never
  edit it by hand; commit it regenerated with any change to a module it bundles.
  `typos.toml` is generated; exceptions go in `typos.local.toml`.
- Pin every tool exactly (`AGENTS.md`). The shipped CLI and workflow gain no
  runtime dependency. The only new dependency is `lemmascript`, exact-pinned in
  the isolated `proofs/package.json` (approval question 4). Dafny 4.11.0 is an
  external prover pinned by version and SHA-256 in CI.
- Keep Biome cognitive complexity below 10 in `bin/dakar-review.mjs`, and keep
  Oxlint (Unicorn and deslop profiles in `oxlint.config.mjs`) free of findings
  and suppressions.
- Prose, comments, and commit messages use en-GB Oxford spelling and follow
  `docs/documentation-style-guide.md`.
- Do not edit completed ExecPlans in `docs/execplans/`.
- Run `make check-fmt`, `make typecheck`, `make lint`, `make test`, and
  `make workflow-check` sequentially after every milestone, plus `make proofs`
  from `EP-M2` onwards; commit only when every gate passes.

## Tolerances (exception triggers)

Comparison base: `379128f` (the `main` commit this branch starts from).
Counting command, run from the repository root:

```bash
git diff --numstat 379128f -- . \
  ':(exclude)docs/execplans/2-3-1-specify-nested-agents-md-files.md' \
  ':(exclude)bin/dakar-review.bundle.mjs' \
  ':(exclude)proofs/package-lock.json' \
  ':(exclude)typos.toml' \
  ':(exclude)src/workflows/dakar-review/*.dfy.gen'
```

Every limit measures net lines (additions minus deletions), and every category
is enforced independently. This ExecPlan file is excluded from every count.
Generated artefacts are excluded from line counts as listed and are governed
instead by their own tooling: the CLI bundle and `typos.toml` by repository
build targets, `*.dfy.gen` by `lsc`, and `proofs/package-lock.json` by the
dependency tolerance.

Classification by purpose: code is TypeScript and JavaScript under `src/`,
`scripts/`, `bin/dakar-review.mjs`, and `tests/`, handwritten Dafny (`*.dfy`),
and Makefile recipe lines; configuration is `package.json` files,
`odw.config.json`, `.github/workflows/*.yml`, `typos.local.toml`, `.gitignore`,
and Makefile variable and `.PHONY` lines; documentation is every other Markdown
file.

- Files: if more than 32 non-ExecPlan files change (generated files
  included), stop and escalate. Estimate: 14 new and 16 modified.
- Code: if code exceeds 2,500 net lines, stop and escalate. Estimate: kernel
  150, policy 320, adapter 300, CLI wiring 40, kernel tests 200, policy tests
  300, property tests 320, adapter integration tests 380, CLI and bundle test
  changes 100, Dafny helper lemmas 180; total 2,290. The contingency covers the
  proof, the main unknown, which also has its own probe (`EP-M0`).
- Configuration: if configuration exceeds 110 net lines, stop and escalate.
  Estimate: `proofs/package.json` 15, Makefile 14, CI proof job 50,
  `odw.config.json` 10, `typos.local.toml` 6, `.gitignore` 2.
- Documentation: if documentation exceeds 750 net lines, stop and escalate.
  Estimate: ADR 0004 270, design document 170, users' guide 50, developers'
  guide 130, skill guide 6, contents index 8, roadmap 30, repository layout 10,
  README 6.
- Dependencies: if `proofs/package-lock.json` resolves more than 400
  packages, if the root `package-lock.json` changes at all, or if any other
  dependency is needed, stop and escalate.
- Interface: if a change to the workflow argument schema, prompts, stdout
  result shape, SARIF output, or a new CLI flag appears necessary, stop and
  escalate.
- Architecture: if the resolver cannot stay pure, or the trusted-commit rule
  must change, stop and escalate.
- Proof: if the `EP-M0` probe shows that LemmaScript cannot model the kernel,
  or a proof obligation in `EP-M2` remains open after three focused attempts,
  stop and escalate. Never weaken a postcondition or add `//@ assume`.
- Iterations: if a focused test or gate still fails after three fix attempts,
  stop and escalate.
- Time: if a milestone takes more than four hours of active work, stop and
  escalate.
- Ambiguity: if implementation exposes two valid readings that change
  applicability or precedence, stop and present the options.

Historical evidence: none of the five completed plans in `docs/execplans/`
records a budget increase in its decision log or revision notes. The closest
comparable plan, `docs/execplans/api-key-support.md`, set "roughly 25 files or
2,500 lines" across all categories;
`docs/execplans/divide-and-conquer-workflow.md` set five files and 350
production lines. Neither separated categories, so the estimates above are
built bottom-up. The design review found that the first draft's 26-file limit
was already below its own named scope; this revision removes the stderr report
milestone and recounts.

## Risks

- Risk: LemmaScript is a technology preview. Version 0.6.10 is the latest at
  planning time, while the house skill documents 0.5.22. It may not translate
  the kernel, or a seeded fault may fail translation instead of verification,
  which would make a negative control pass for the wrong reason. Severity:
  medium. Likelihood: medium. Mitigation: the `EP-M0` probe; the kernel uses
  only arrays, integers, and `while` loops; every seeded fault's failure output
  must name the violated postcondition; the proof tolerance forces escalation.
- Risk: the proof tool's dependency tree (cloud SDKs through
  `lemmascript-claimcheck`) is large and security-sensitive. Severity: medium.
  Likelihood: certain. Mitigation: the isolated `proofs/` package, installed
  only for proof runs with `npm ci --ignore-scripts`; the dependency tolerance.
- Risk: Dafny is installed on the development host (`~/.local/bin/dafny`,
  4.11.0) but not in CI, and proofs outside `make check` can drift. Severity:
  medium. Likelihood: high. Mitigation: a dedicated CI job (added in `EP-M2`,
  not at the end) downloads the pinned release archive, checks its SHA-256, runs
  `make proofs`, and checks that regenerated `.dfy.gen` files match the
  committed ones; `make check` runs `make proofs` when `dafny --version`
  reports 4.11.0 and otherwise prints a skip notice.
- Risk: changed paths come from `git diff --name-only` without `-z`
  (`scripts/review-state.mjs::changedFiles()`), so with Git's default
  `core.quotePath` every non-ASCII path arrives C-quoted (for example
  `"src/caf\303\251.ts"`) and cannot match a nested scope. Severity: medium.
  Likelihood: medium for non-English repositories. Mitigation: the policy
  reports such paths as `path-unresolvable` and gives them the root chain only;
  the adapter's own range queries use `-z`; a follow-up roadmap task fixes
  `changedFiles()` (approval question 5).
- Risk: `--base` is resolved twice (here and in `review-state.mjs`), and a
  local branch or tag literally named `origin/main` shadows the remote-tracking
  ref. Severity: low. Likelihood: low. Mitigation: unchanged from today;
  recorded in ADR 0004 known limitations and a roadmap follow-up.
- Risk: context warm-up indexes the working-tree `AGENTS.md` and changed
  Markdown (`scripts/context-warmup.mjs`), so an added `AGENTS.md` can still
  reach agents through CodeGraph retrieval. Severity: medium. Likelihood:
  medium once 2.3.2 lands. Mitigation: out of scope for 2.3.1; recorded as a
  prerequisite follow-up for 2.3.2.
- Risk: adding `--no-context-files` to the pi adapters removes context the
  agents currently see, which could change review quality. Severity: low.
  Likelihood: low; the trusted root text is already in every prompt.
  Mitigation: approval question 3; the users' guide explains the change.

## Progress

- [x] (2026-11-17T14:04Z) Branch renamed; repository reconnaissance (two
  Wyvern scouts) and prior-art research completed.
- [x] (2026-11-17T14:10Z) Initial draft written and committed.
- [x] (2026-11-17T14:16Z) Community-of-experts design review (three panellists
  covering six lenses) completed; verdict "proceed with conditions".
- [x] (2026-11-17T14:40Z) Review findings applied in this revision.
- [ ] Plan approved by the user (with answers to the approval questions).
- [ ] `EP-M0` feasibility probes (prototype).
- [ ] `EP-M1` design recorded: ADR 0004 and design document.
- [ ] `EP-M2` proved kernel, isolated proof package, CI proof job.
- [ ] `EP-M3` pure instruction-scope policy.
- [ ] `EP-M4` trusted Git discovery adapter, root loading, pi context fix.
- [ ] `EP-M5` documentation and roadmap closure.

## Surprises & discoveries

- Observation: root `AGENTS.md` is read from the resolved `--base` commit, not
  the working tree or reviewed head. Evidence:
  `bin/dakar-review.mjs::readAgentInstructions()` runs
  `git ls-tree -z <commit> -- AGENTS.md` then `git show <commit>:AGENTS.md`;
  `tests/cli.test.mjs` "CLI reads AGENTS.md from the resolved commit when the
  named ref moves". Impact: nested discovery adopts the same trust rule.
- Observation: the pi agent runtime loads `AGENTS.md` and `CLAUDE.md` by
  default. Evidence: `pi --help` on the host lists
  `--no-context-files, -nc  Disable AGENTS.md and CLAUDE.md discovery and
  loading`;
  the pi adapters in `odw.config.json` run
  `pi -p --no-session --provider openai-flex --model … --thinking …` without
  it, and ODW runs agents in a copy of the reviewed working tree. Impact: the
  head's (untrusted) instructions already reach agents, bypassing the trusted
  base. Fixed in `EP-M4` (decision D10).
- Observation: `readAgentInstructions()` ignores the tree entry mode, so a
  committed symbolic link named `AGENTS.md` has its target path read as
  instruction text; it uses `spawnSync`'s default 1 MiB `maxBuffer`; and with a
  `--repo-root` inside a subdirectory, `ls-tree -- AGENTS.md` looks in that
  subdirectory while `show <sha>:AGENTS.md` reads the repository root.
  Evidence: code reading; confirmed by red tests in `EP-M4`.
- Observation: the trusted gate configuration is read from
  `prepared.reviewBase` (`bin/dakar-review.mjs::readTrustedGateConfig()`),
  which may be a previously reviewed head written by the change author. Impact:
  out of scope; a separate security follow-up is recommended in the final
  report to the user.
- Observation: `lemmascript@0.6.10` depends on `ts-morph` and
  `lemmascript-claimcheck`, which pulls in `claimcheck` and cloud-provider
  SDKs. Evidence: `npm view` during the design review. Impact: decision D9.
- Observation: the repository's runner is `node:test`; no suite uses
  `bun:test`. Impact: decision D2.
- Observation: `docs/execplans/compile-dakar-review-workflow.md` (decision
  dated 2026-07-14) declined to adopt df12-build's "Bun, BDD, LemmaScript, or
  Dafny test stack". Impact: this plan reverses that for one kernel, at the
  user's explicit request for exhaustive proofs of contractual logic; ADR 0004
  and D9 record the reversal and its narrow scope.
- Observation: `git ls-tree <sha> -- dir/` lists one directory
  non-recursively, `git --literal-pathspecs` treats `[` and `*` in directory
  names literally, and `git cat-file --batch` returns
  `<oid> <type> <size>\n<bytes>\n` per object. Evidence: planning probe on a
  scratch repository (see `Artefacts and notes`). Impact: ancestry discovery
  needs no recursive listing.
- Observation: `scripts/build-workflow.mjs` checks `RUNTIME_MODULES` against
  esbuild's metafile, not a directory listing, so a module `main.ts` does not
  import does not break the workflow build. Impact: no manifest change until
  2.3.2.

## Decision log

- D1. Decision: deliver 2.3.1 as an accepted design, a proved and tested pure
  resolver, a Git adapter exercised by integration tests, and the root and pi
  trust fixes. Defer prompt integration, the result-JSON and SARIF reporting
  surface, and any new stderr event to 2.3.2. Rationale: the success criterion
  is a design definition; the design review (Wafflecat, Dinolump) showed that a
  stderr report would become a provisional contract that 2.3.2 replaces, while
  the result JSON is where agents read. Rejected alternative: a stderr
  `instruction_scope` event now (approval question 2). Date/Author: 2026-11-17,
  planning agent after design review.
- D2. Decision: tests use `node:test`, `node:assert/strict`, and `fast-check`
  4.9.0, not `bun:test`. Rationale: `make test` runs `node --test`; every
  existing suite uses `node:test`; a `bun:test` suite would not run in the
  gate. The behavioural intent of the request is met with the repository's
  runner (approval question 1). Date/Author: 2026-11-17, planning agent;
  endorsed by the design review.
- D3. Decision: an instruction file is a regular Git blob (mode `100644` or
  `100755`) whose final path segment is exactly `AGENTS.md`. Other spellings of
  the name (`agents.md`, `Agents.md`) are reported, not loaded.
  `AGENTS.override.md`, `CLAUDE.md`, and `.cursorrules` are out of scope.
  Rationale: today's root rule, the `agents.md` convention, and Codex; exact
  case avoids platform-dependent matching. Date/Author: 2026-11-17.
- D4. Decision: a file in directory `d` applies to path `p` exactly when `d`
  is the root or a segment-wise prefix of `p`'s parent directory. The chain is
  ordered root first, nearest last. A deleted path keeps the chain of its old
  location. A renamed path is governed by its destination chain; when the
  source chain differs, the policy emits `path-scope-changed` and 2.3.2 must
  show both chains for that path. Paths inside submodules resolve only to
  ancestors outside the submodule. An `AGENTS.md` that is itself changed is
  reviewed under its own trusted-base chain. Rationale: shared rule of
  `agents.md`, Codex, Claude Code, and CodeRabbit; the rename rule closes the
  "move code out of a strict scope" escape found in the pre-mortem.
  Date/Author: 2026-11-17, revised after design review.
- D5. Decision: precedence, highest first: (1) Dakar workflow schema, output,
  and safety rules; (2) review policy from an operator-chosen configuration
  (`source` `explicit` or `user` in `scripts/review-config.mjs`) or from the
  repository's own CodeRabbit file (`source` `repository`); (3) the nearest
  applicable `AGENTS.md`, then each farther ancestor, ending with the root; (4)
  review policy from Dakar's bundled example configuration (`source`
  `example`). Non-conflicting guidance from every level accumulates. Rationale:
  operator and repository review policy is chosen for reviewing; the bundled
  df12 house example must not override a repository's own `AGENTS.md` (finding
  F7). Date/Author: 2026-11-17, revised after design review.
- D6. Decision: Dakar does not detect semantic disagreement between texts
  deterministically. Precedence resolves it inside prompts (2.3.2). Structural
  conflicts produce diagnostics with stable `area-condition` codes (see
  `Interfaces and dependencies`), each mapped to the SARIF rule id
  `dakar/instruction/<code>`. Rationale: judgement belongs in the audited model
  lane (ADR 0002). Date/Author: 2026-11-17.
- D7. Decision: discovery is by ancestry, not by full-tree listing: the
  adapter collects the ancestor directories of the changed paths (and rename
  sources), lists each non-recursively with one batched
  `git --literal-pathspecs ls-tree -z --full-tree <sha> -- <dir>/ …` call, and
  reads accepted blobs through one `git cat-file --batch` process by object id.
  There is no global file-count cap: every applicable file is loaded. Per-file
  bounds: blobs over 4 MiB are not read (`entry-too-large`); text is truncated
  to 24,000 UTF-16 code units (`content-truncated`). Rationale: a global
  "shallowest 64" cap silently drops the deep files monorepos need (pre-mortem
  scenario 1); `ls-tree -r -l` scales with repository size and forces blob
  fetches in partial clones (scenario 2). Date/Author: 2026-11-17, revised
  after design review.
- D8. Decision: an `AGENTS.md` (any letter case) added, modified, deleted, or
  renamed by the reviewed change keeps its trusted-base version (or absence)
  and yields `range-instruction-changed` (warning). The adapter computes this
  itself with `git diff --no-renames --name-only -z <mergeBase> <head>`, where
  `mergeBase` is the merge base of the trusted commit and the head, so earlier
  reviewed increments and rename sources are included. Rationale: the change is
  reviewed as code and cannot instruct its own reviewer; findings F5 and F4
  showed that `prepared.changedFiles` misses both cases. Date/Author:
  2026-11-17, revised after design review.
- D9. Decision: prove the kernel (segment prefix, applicable indices, and
  budget selection) with LemmaScript and Dafny; cover the policy with table and
  `fast-check` tests and an independent oracle; cover Git behaviour with
  integration tests. Install LemmaScript in an isolated `proofs/` package. This
  narrowly reverses the 2026-07-14 decision not to adopt the Dafny stack,
  because the user requires exhaustive proof of contractual logic. Date/Author:
  2026-11-17, revised after design review.
- D10. Decision: add `--no-context-files` to every pi Flex adapter command in
  `odw.config.json` and guard it in `tests/adapter-config.test.mjs`. Rationale:
  without it the trust rule is fiction, because pi loads the working copy's
  `AGENTS.md` and `CLAUDE.md` (approval question 3). Date/Author: 2026-11-17,
  from design review finding F5 and host evidence.
- D11. Decision: split applicability from budgeting. The 2.3.1 report carries
  files and per-path chains only; budget selection is a separate kernel function
  `selectWithinBudget(lengths, ranking, budget)` that keeps the longest prefix
  of a priority ranking that fits and stops at the first file that does not.
  For one chain ranked nearest first, the kept set is a contiguous run of the
  nearest files. ADR 0004 specifies the 2.3.2 pack rule: rank files by
  nearest-first position across the pack's chains, and require that the
  governing file of every path in a pack survives, otherwise split the pack or
  fail. The workflow argument transport (one JSON argv string, limited by Linux
  to 128 KiB per argument) bounds total instruction text; ADR 0004 requires
  2.3.2 to derive its budget from that limit or move the text to an arguments
  file. Rationale: findings F2, F3, F9; greedy skipping could revive a rule a
  nearer file had overridden. Date/Author: 2026-11-17.
- D12. Decision: record three follow-ups in `docs/roadmap.md` with
  `mapsplice` in `EP-M5`: NUL-delimited changed paths in `review-state.mjs`;
  resolve `--base` once to a fully qualified ref and SHA shared with
  `prepare()`; exclude instruction files from context warm-up (prerequisite of
  2.3.2). Rationale: each is a real gap found here whose fix changes a shared
  contract outside this item (approval question 5). Date/Author: 2026-11-17.
- D13. Decision: ADR 0004 is written in `EP-M1`, after plan approval, with
  status `Accepted` and the approval date. Rationale: removes the draft's
  contradiction between "Proposed until approval" and approval preceding
  `EP-M1`. Date/Author: 2026-11-17.

## Outcomes & retrospective

Not started. Record outcomes at each milestone and reconcile ADR 0004, the
design document, and both guides before marking the plan `COMPLETE`.

## Context and orientation

Inspected base revision: `379128f` ("Adopt the documentation style guide and
rename ADRs (#27)"). Line numbers below refer to it; relocate symbols with
`grep -n '<symbol>' <file>`.

The CLI entry point is `bin/dakar-review.mjs`. `run()` parses options, resolves
the repository root, and calls `buildWorkflowArgs()`, which resolves CodeRabbit
configuration (`scripts/review-config.mjs::resolveReviewConfig()`, whose result
carries `source`: `explicit`, `repository`, `user`, or `example`), then calls
`readAgentInstructions(repoRoot, options.base || 'origin/main')` and sets
`workflowArgs.agentInstructions = { source, content, truncated }` when a root
file exists. `readAgentInstructions()` (around line
491) uses `runTrustedInstructionGit()` (around line 469) to resolve the base
with `git rev-parse --verify --quiet <base>^{commit}`, list `AGENTS.md` with
`git ls-tree -z`, and read it with `git show`. Errors carry the prefixes listed
in `Constraints`; the top-level `try` around `run()` prints
`{ ok: false, stage: 'cli', error }` on stderr and exits 1. In live mode
`prepareLiveReview()` calls `prepareReview()`, which runs
`scripts/review-state.mjs::prepare()` and yields `prepared.changedFiles`, a
sorted list from `git diff --name-only <reviewBase>..<head>`. Dry-run never
prepares a range.

Inside the workflow (`src/workflows/dakar-review/`), `config.ts`
(`agentInstructionsSchema`) validates `agentInstructions`; `prompts.ts`
(`agentInstructionsBlock()`) renders it with the sentence "Treat these as
repository-local instructions when they do not conflict with the Dakar workflow
schema, output, and safety rules:" in the finder (`taskPrompt`) and audit
(`auditPrompt`) prompts. `policy.ts` matches CodeRabbit
`reviews.path_instructions` globs per finder pack (`pathInstructionsFor()`).
`task-graph.ts` groups changed files into finder packs
(`ReviewTask.files: string[]`) that span several directories, which is why
budgeting must work across chains (D11). `main.ts` returns `ignoredPolicyKeys`
in the result, the precedent for reporting configuration that was read but not
applied.

The ODW adapters live in `odw.config.json`; the pi Flex adapters
(`pi-luna-flex`, `pi-luna-flex-medium`, `pi-luna-flex-high`, `pi-terra-flex`,
`pi-terra-flex-high`) run
`pi -p --no-session --provider openai-flex --model <model> --thinking <level>`.
`tests/adapter-config.test.mjs` guards their command shapes.

The CLI bundle is built by `scripts/build-cli.mjs` with esbuild;
`EXTERNAL_MODULES` lists four plain `.mjs` scripts kept outside the bundle.
`tests/cli-bundle.test.mjs` and `tests/install.test.mjs` guard the installed
CLI.

Existing tests that pin current behaviour (all `node:test`), in
`tests/cli.test.mjs`: "CLI dry-run prints one machine-readable JSON result",
"CLI includes repository AGENTS.md instructions in workflow args", "CLI omits
agentInstructions when the trusted commit has no AGENTS.md", "CLI applies the
trusted AGENTS.md truncation limit exactly", "CLI preserves trusted-instruction
Git failure diagnostics" (a fake `git` that fails on the `ls-tree` or `show`
operation and asserts the fallbacks `git ls-tree failed` and
`git show failed`), "CLI reads AGENTS.md from the resolved commit when the
named ref moves", "CLI fails closed when the trusted instruction base is
invalid", and "CLI surfaces git failures while loading trusted instructions".
Also `tests/workflow-prompts.test.mjs`, `tests/workflow-config.test.mjs`, and
`tests/cli-context-warmup.test.mjs`. Helpers: `tests/cli-test-support.mjs`
(`runCli`, `spawnCli`, `initFixtureRepo`, `writeFakeOdw`,
`setUpAgentInstructionRepo`, `writePreparedEchoOdw`). Property-test precedent:
`tests/review-state.property.test.mjs`.

Tooling: Node 22.23.4; TypeScript 6.0.3 (`tsconfig.json`: strict,
`noUncheckedIndexedAccess`, `erasableSyntaxOnly`, `verbatimModuleSyntax`);
Biome 1.9.4; Oxlint 1.82.0; TypeDoc 0.28.20; markdownlint-cli2 0.23.2;
`mdtablefix` (run by `make fmt` and checked by `make check-fmt`); `nixie`;
`typos-config-builder`. Dafny 4.11.0 is on the host at `~/.local/bin/dafny`.
Gates: `make check-fmt`, `make typecheck` (includes `node --check`, `tsc`, and
an ODW dry run, so `odw` must be on `PATH`), `make lint`, `make test`,
`make workflow-check`; `make check` runs all of them.

Prior art (Firecrawl, 2026-11-17): the `agents.md` specification (nearest file
wins; explicit user prompts override); OpenAI Codex (root-to-directory
concatenation, nearer files override, 32 KiB combined cap,
`AGENTS.override.md`); Claude Code (nested files load on demand; nearer files
take precedence; `paths` front matter for rules); CodeRabbit code guidelines
(auto-discovered `AGENTS.md` applies to its directory subtree; unusable sources
are listed with reasons without blocking the review).

Skills and documents to load before implementation: `execplans`;
`hexagonal-architecture` (pure kernel and policy; Git behind the adapter; ports
as plain objects of functions, not classes); `typescript-router`, then
`typescript-data-and-state` and `typescript-testing`; `fast-check`;
`lemmascript`; `codegraph-mcp` (callers of `readAgentInstructions` and
`buildWorkflowArgs`); `odw-authoring` (only to confirm the workflow artefact is
untouched); `mapsplice` (roadmap edits); `en-gb-oxendict-style`. Read
`docs/dakar-review-design.md` §§3, 4, 6, 9, 11, and 12;
`docs/developers-guide.md` §§1, 2, 3, and 6; the users' guide sections "How
much of the CodeRabbit format is honoured" and "Context tools";
`docs/review-skill-design.md`;
`docs/complexity-antipatterns-and-refactoring-strategies.md` §§3 and 5 (use
small classifiers and a lookup table rather than a "bumpy road" of
conditionals); and `docs/documentation-style-guide.md` (ADR format, captions,
screen-reader sentences for Mermaid).

## Conformance basis

Upstream artefacts inspected at `379128f`: `docs/roadmap.md` §2.3 (task 2.3.1,
requiring the completed 2.2.1); `docs/dakar-review-design.md` §§6, 9, 11, and
12; ADR 0002 (deterministic host work first; judgement only in model lanes);
ADR 0001 (typed modules, one composition root); the repository `AGENTS.md`. No
terms-of-reference document exists for Dakar; none is invented here.

Requirements:

- `REQ-applicability`: for every changed path, the design and code define the
  exact ordered set of instruction files that apply.
- `REQ-precedence`: one total precedence order covers Dakar rules, review
  policy by source, and every applicable instruction file.
- `REQ-conflict-reporting`: every structural anomaly yields exactly one
  diagnostic with a stable code and SARIF rule id; reporting never blocks the
  review except for Git failures.
- `REQ-trust`: instruction text that Dakar or its agent runtime uses comes only
  from the trusted instruction commit.
- `REQ-bounds`: per-file bounds are explicit; budget selection keeps a
  contiguous nearest-first run.
- `REQ-compat`: root-only workflow arguments, stdout, and the workflow
  artefact are unchanged apart from the deliberate trust fixes.

Gaps against the baseline: `GAP-nested` (nested files ignored), `GAP-symlink`
(symbolic link read as text), `GAP-buffer` (1 MiB buffer), `GAP-subdir`
(subdirectory `--repo-root` inspects the wrong path), `GAP-pi-context` (pi
loads untrusted context files).

Trace links:

```plaintext
roadmap 2.3.1 -> REQ-applicability -> ADR-0004 decision -> EP-M2, EP-M3
  -> tests/instruction-scope-kernel.test.mjs, make proofs
roadmap 2.3.1 -> REQ-precedence -> ADR-0004 precedence, design §6 -> EP-M1
roadmap 2.3.1 -> REQ-conflict-reporting -> ADR-0004 diagnostics -> EP-M3, EP-M4
  -> tests/instruction-scope.test.mjs, tests/instruction-discovery.test.mjs
REQ-trust, GAP-symlink, GAP-buffer, GAP-subdir -> EP-M4
  -> tests/instruction-discovery.test.mjs, tests/cli.test.mjs
REQ-trust, GAP-pi-context -> D10 -> EP-M4 -> tests/adapter-config.test.mjs
REQ-bounds -> D7, D11 -> EP-M2 (selection proof), EP-M3, EP-M4
REQ-compat -> EP-M4 -> existing tests/cli.test.mjs cases, make workflow-check
```

## Verification plan

### Abstract model

A repository-relative path is a sequence of segments `s₁/…/sₙ/f`, each
non-empty and neither `.` nor `..`. Its parent directory is `P(p) = ⟨s₁,…,sₙ⟩`
(empty for a root-level file). A catalogue `C` is a finite list of instruction
files with pairwise distinct directories `dir(e)` (the empty sequence for the
root).

- `isPrefix(d, q)` holds when `|d| ≤ |q|` and `d[i] = q[i]` for every
  `i < |d|`.
- `chain(C, p)` is the list of indices `i` with `isPrefix(dir(Cᵢ), P(p))`,
  ordered by `|dir(Cᵢ)|` ascending.
- `select(L, R, B)`, for lengths `L`, a ranking `R` (a list of distinct
  indices into `L`), and budget `B ≥ 0`, returns the longest prefix `R[0..k)`
  with `Σ L[R[j]] ≤ B` for `j < k`.

Malformed paths (absolute, C-quoted, containing empty, `.`, or `..` segments,
or backslashes) are rejected by the policy layer before the kernel runs; they
receive the root chain only and are counted under `path-unresolvable`.

### Invariants and lemmas

- `INV-sound` (`REQ-applicability`): every index in `chain(C, p)` refers to an
  entry whose directory is a prefix of `P(p)`.
- `INV-complete` (`REQ-applicability`): every entry whose directory is a
  prefix of `P(p)` appears in `chain(C, p)`.
- `INV-order` (`REQ-precedence`): directory depths along `chain(C, p)` are
  strictly increasing, so there are no duplicates and the last index is the
  nearest ancestor.
- `INV-segment`: `isPrefix` compares whole segments; `⟨packages, api⟩` is not
  a prefix of `⟨packages, api-client⟩`.
- `INV-root`: if the root entry exists, it is first in every chain.
- `INV-locality`: adding an entry at `d` changes `chain(C, p)` only when
  `isPrefix(d, P(p))`, and then inserts exactly that entry.
- `INV-select-fit` (`REQ-bounds`): the selected lengths sum to at most `B`.
- `INV-select-prefix` (`REQ-bounds`): the result is a prefix of `R`, so for a
  nearest-first ranking of one chain the kept files are a contiguous nearest
  run and no farther file is kept while a nearer one is dropped.
- `INV-select-maximal`: if the result is shorter than `R`, adding the next
  ranked length would exceed `B`.
- `INV-trust` (`REQ-trust`): instruction text equals the blob at the trusted
  commit; working-tree and head edits never change it; pi agents receive no
  context file from their working copy.
- `INV-diagnostic` (`REQ-conflict-reporting`): each skipped, ignored,
  truncated, changed-in-range, scope-changed, or unresolvable item yields
  exactly one diagnostic (or one count for `path-unresolvable`), and
  diagnostics are sorted by `(code, path)`.
- `INV-determinism`: the policy result is identical under any permutation of
  the tree entries and the changed paths.
- `INV-fail-closed`: every Git failure during trusted instruction loading
  ends the run with exit status 1 and a `stage: "cli"` error carrying the
  existing prefixes; no Git failure becomes a diagnostic.
- `INV-compat` (`REQ-compat`): for a repository whose only instruction file is
  a regular root `AGENTS.md` and whose `--repo-root` is the top level, the
  workflow arguments are byte-identical to the baseline.
- `L-chain-filter`: the loop in `applicableIndices` equals the depth-sorted
  filter of `isPrefix`; it connects the implementation to `INV-sound`,
  `INV-complete`, and `INV-order`.
- `L-select-spec`: the loop in `selectWithinBudget` equals the recursive
  specification of `select`; it connects the implementation to the selection
  invariants.

### Axioms (trusted, not verified here)

- `AXIOM-git-tree`: `git ls-tree -z` prints
  `<mode> SP <type> SP <oid> TAB <path> NUL` per entry with `/`-separated paths
  free of empty, `.`, and `..` segments, and a tree holds at most one entry per
  name. With `--literal-pathspecs`, `--full-tree`, and a `dir/` pathspec it
  lists that directory's entries non-recursively. Boundary: the adapter parser;
  exercised by integration tests on real repositories.
- `AXIOM-git-batch`: `git cat-file --batch` answers each object id with
  `<oid> SP <type> SP <size> LF <bytes> LF`, or `<oid> SP missing LF`.
  Boundary: the adapter.
- `AXIOM-git-diff`: `git diff --no-renames --name-only -z A B` lists every path
  whose blob differs between trees `A` and `B`, including both sides of a
  rename. Boundary: the adapter's range query.
- `AXIOM-pi-flag`: `pi --no-context-files` disables `AGENTS.md` and `CLAUDE.md`
  discovery and loading (documented in `pi --help`). Boundary:
  `odw.config.json`; Dakar cannot run a live canary in tests without spending
  on a model call, so the command shape is guarded instead.
- `AXIOM-lemmascript-model`: LemmaScript translates the kernel's fragment
  faithfully (arrays as sequences, `number` as mathematical integers).
  Mitigated by `fast-check` running the same shipped functions.
- `AXIOM-dafny`: Dafny 4.11.0 and its bundled Z3 are sound.
- `AXIOM-js-length`: `String.prototype.length` counts UTF-16 code units and
  `slice(0, n)` keeps the first `n`. Boundary: per-file truncation.

### Methods per obligation

- Obligation: `INV-sound`, `INV-complete`, `INV-order`, `INV-root`,
  `INV-segment`, `L-chain-filter`. Method: formal proof (LemmaScript to Dafny),
  a table test, and a `fast-check` property against an independent oracle.
  Rationale: this is the contract 2.3.1 exists to define, it holds for all
  inputs, and it fits the LemmaScript fragment. The proof's real value over
  testing is the universally quantified segment-boundary guarantee. Domain: all
  segment sequences; catalogues with distinct directories. Artefact:
  `src/workflows/dakar-review/instruction-scope-kernel.ts` with `//@ verify`
  annotations; `src/workflows/dakar-review/instruction-scope-kernel.dfy`
  (helper lemmas only); `tests/instruction-scope-kernel.test.mjs`. Evidence:
  `make proofs` reports zero errors; before the helper lemmas exist it reports
  the open postconditions by name. Discharge: verification succeeds with no
  `//@ assume`, no `{:axiom}`, and a `.dfy` diff over `.dfy.gen` that only adds
  lines; the CI freshness check finds no difference between regenerated and
  committed `.dfy.gen` files. Non-vacuity: the witnesses `⟨⟩`, `⟨packages⟩`, and
  `⟨packages, api⟩` satisfy the distinctness precondition, and each produces a
  non-empty chain for `packages/api/src/routes.ts`. Seeded fault A replaces the
  element-wise comparison with a comparison of joined strings
  (`prefix.join('/')` against the start of `path.join('/')`); fault B compares
  lengths with `<` instead of `≤`. `EP-M0` first confirms that each fault
  translates; then `make proofs` must fail naming `INV-segment` or
  `INV-complete`, and the property test must shrink to a counterexample such as
  `packages/api` against `packages/api-client/x.ts` (fault A) or the root file
  at depth zero (fault B). Revert with `git checkout --` on the kernel and
  restore the `.dfy.gen` file.
- Obligation: `INV-select-fit`, `INV-select-prefix`, `INV-select-maximal`,
  `L-select-spec`. Method: formal proof and a `fast-check` property comparing
  with an oracle that computes running prefix sums directly. Domain: length
  arrays of 0 to 64 natural numbers, rankings that are permutations of index
  subsets, budgets 0 to 200,000. Artefact: the same kernel and proof files;
  `tests/instruction-scope.property.test.mjs`. Non-vacuity: `fc.statistics`
  must report cases with nothing dropped, some dropped, and everything dropped,
  each above 10%; seeded fault C (skip a non-fitting file and continue, the
  draft's greedy rule) must fail `INV-select-prefix` with a named postcondition
  and a shrunk counterexample such as lengths `[1, 5, 23, 24]`, ranking
  `[3, 2, 1, 0]`, budget 48.
- Obligation: `INV-locality`, `INV-determinism`, `INV-diagnostic`,
  malformed-path handling, rename scope changes. Method: `fast-check`
  properties over generated trees and change sets, with an oracle in the test
  file that recomputes chains by brute-force string splitting and does not
  import the kernel. Domain: trees up to six levels and 40 directories over the
  segment alphabet `a`, `b`, `ab`, `a-b`, `A` (so near-miss siblings and case
  variants occur often), and up to 60 changed paths, renames, and malformed
  paths. Artefact: `tests/instruction-scope.property.test.mjs` and the table
  tests in `tests/instruction-scope.test.mjs`. Non-vacuity: classification
  thresholds checked in the test (at least 10% of runs with a chain of length
  three or more, at least 10% with a near-miss sibling, at least 5% with a
  rename across scopes); seeded fault D (do not sort diagnostics) must fail
  determinism.
- Obligation: `INV-trust`, `INV-fail-closed`, `GAP-symlink`, `GAP-buffer`,
  `GAP-subdir`, D7 discovery, D8 range changes. Method: integration tests on
  real temporary Git repositories, plus the existing fake-`git`
  failure-injection pattern. Artefact: `tests/instruction-discovery.test.mjs`
  and `tests/cli.test.mjs`. Non-vacuity: the trust test commits different text
  at base and head and edits the working tree, then asserts the base text, so
  it fails if the adapter reads `HEAD` or the file system; the range test
  renames `packages/api/AGENTS.md` and asserts a diagnostic for the source
  path, so it fails if renames are detected.
- Obligation: `INV-trust` for the agent runtime (`GAP-pi-context`).
  Method: a configuration guard test (live canary excluded by `AXIOM-pi-flag`).
  Artefact: `tests/adapter-config.test.mjs` asserts every adapter whose command
  starts with `pi` contains `--no-context-files`. Non-vacuity: the test fails
  on the current `odw.config.json`.
- Obligation: `INV-compat`.
  Method: the existing CLI suites, unchanged except the deliberate edits named
  in `EP-M4`, plus `make workflow-check` proving the workflow artefact is
  unchanged.

### Formal verification decision

A formal proof is proportionate for the kernel: applicability and budget
selection are the contract this item defines, they are pure computations over
sequences and integers, and an error would silently give a reviewer the wrong
instructions in every run. LemmaScript keeps the proof attached to the shipped
TypeScript. Model checking adds nothing, because there is no concurrency or
protocol state. The proof does not cover path parsing, Git parsing, or
diagnostic assembly; property tests, integration tests, and the axioms above
cover those. Recorded as D9.

### Suggested BDD features

The repository has no BDD runner and this plan adds none. These proposed
scenarios are implemented as named `node:test` cases in
`tests/instruction-discovery.test.mjs` (`EP-M4`), which drive the adapter and
policy against real repositories, and the symbolic-link scenario is also a CLI
case in `tests/cli.test.mjs`.

```gherkin
Feature: Nested AGENTS.md instruction scope
  Scenario: Nested instructions apply beneath their directory
    Given a trusted base with AGENTS.md and packages/api/AGENTS.md
    And a change to packages/api/src/routes.ts
    When the instruction scope is discovered
    Then the chain for that path is AGENTS.md, packages/api/AGENTS.md

  Scenario: Sibling directories with a shared prefix do not inherit
    Given a trusted base with packages/api/AGENTS.md
    And a change to packages/api-client/index.ts
    Then the chain for that path is AGENTS.md only

  Scenario: An instruction file changed by the review is not obeyed
    Given packages/api/AGENTS.md differs between the trusted base and the head
    When the instruction scope is discovered
    Then the applied text is the trusted-base version
    And a range-instruction-changed warning names packages/api/AGENTS.md

  Scenario: Moving code out of a scope is reported
    Given a trusted base with packages/crypto/AGENTS.md
    And a change that renames packages/crypto/sign.ts to crypto-v2/sign.ts
    Then a path-scope-changed warning names crypto-v2/sign.ts

  Scenario: A symbolic link named AGENTS.md is skipped
    Given the trusted base commits AGENTS.md as a symbolic link
    When dakar-review runs
    Then the workflow arguments contain no agentInstructions
    And stderr warns that AGENTS.md was skipped as a symbolic link
```

Links: scenarios 1 and 2 trace to `REQ-applicability`; 3 to `REQ-trust` and D8;
4 to D4; 5 to `GAP-symlink`. All belong to `EP-M4`.

## Plan of work

### `EP-M0` feasibility probes (prototype)

Three questions, each answered in a scratch directory outside the repository
(for example `/tmp/dakar-probe-<name>`), deleted afterwards. Nothing but plan
updates is committed.

1. LemmaScript. Create a scratch `proofs/`-style package with
   `"lemmascript": "0.6.10"` and run `npm install --ignore-scripts`; record the
   number of resolved packages (`npm ls --all --parseable | wc -l`). Write a
   60-line `probe.ts` containing `isSegmentPrefix`, `applicableIndices`, and
   `selectWithinBudget` annotated as in `Interfaces and dependencies`, and run
   `npx lsc check --backend=dafny probe.ts`. Then apply seeded faults A, B, and
   C one at a time and confirm each fails with a named postcondition, not a
   translation error. Go: all three verify and all faults fail as intended.
   No-go: escalate with the transcript and the alternatives (a Dafny model
   beside the code plus a `fast-check` conformance test, or proof of
   `isSegmentPrefix` only).
2. Git. Re-run the planning probe (see `Artefacts and notes`) with an
   additional SHA-256 repository (`git init --object-format=sha256`) and a
   directory name containing a space and non-ASCII letters, confirming the `-z`
   parse and `cat-file --batch` framing.
3. Dafny in CI. Record the release archive URL for Dafny 4.11.0 on
   `ubuntu-latest` (x64) and its SHA-256, computed after download.

### `EP-M1` design recorded

Assigned: all requirements at the design level; decisions D1 and D3 to D13.

Create `docs/adrs/adr-0004-scope-nested-agents-instructions.md` with the heading
`# Architectural decision record (ADR) 0004: Scope nested AGENTS.md
instructions by directory ancestry`,
status `Accepted` with the approval date (D13), and sections Context and
problem statement (opening with the two-sense reading of "conflicts"), Decision
drivers, Options considered (root only; nearest file only; root-to-nearest
chain with nearest-wins precedence, chosen; glob-scoped instruction rules;
desugaring into `path_instructions`, the review panel's strongest alternative,
rejected for 2.3.1 because it merges 2.3.1 with 2.3.2 and makes precedence
implicit), Decision outcome (D3 to D8, D10, D11, the diagnostic table with
codes, severities, SARIF rule ids, and user actions, and a Mermaid flowchart
with a screen-reader sentence and caption), Consequences (the 2.3.2 contract:
result-JSON reporting beside `ignoredPolicyKeys`, SARIF
`toolExecutionNotifications`, pack budgeting, the argument-transport ceiling),
Known risks and limitations (the double `--base` resolution, quoted changed
paths, warm-up divergence, gate configuration read from `prepared.reviewBase`,
the reversal of the 2026-07-14 Dafny decision), and References.

In `docs/dakar-review-design.md`: update §2's goal to mention nested discovery;
add the terms "instruction file", "instruction chain", "governing instruction
file", "trusted instruction commit", and "instruction diagnostic" to §3; add an
"Load trusted instructions" step to the §4 flowchart and prose; replace §6's
final paragraph with a subsection "Instruction discovery and precedence" that
summarizes ADR 0004; add Git-failure and per-file-anomaly behaviour to §11; and
add `INV-sound`, `INV-segment`, `INV-select-prefix`, `INV-trust`, and
`INV-fail-closed` in prose to §12. Add ADR 0004 to the design document's front
matter and to `docs/contents.md`, and add this plan to the "Execution plans"
list there.

Validation: `make fmt` then all gates. Commit: "Record the nested AGENTS.md
scoping design (ADR 0004)".

### `EP-M2` proved kernel and proof tooling

Assigned: `INV-sound`, `INV-complete`, `INV-order`, `INV-root`, `INV-segment`,
`INV-select-*`, `L-chain-filter`, `L-select-spec`; D9, D11.

Red: add `tests/instruction-scope-kernel.test.mjs` with table tests (root only;
`packages` and `packages/api`; the near-miss `packages/api` against
`packages/api-client`; equal-depth siblings; empty catalogue; a budget exactly
equal to a length; zero budget; an empty ranking). Run
`node --test tests/instruction-scope-kernel.test.mjs`; it must fail with
"Cannot find module".

Green: add `src/workflows/dakar-review/instruction-scope-kernel.ts` with the
three functions over `readonly string[]`, `readonly (readonly string[])[]`, and
`readonly number[]`, using `while` loops with `//@ invariant` and
`//@ decreases`, and `//@ ensures` clauses that state the invariants. Create
`proofs/package.json` (`"private": true`, `"lemmascript": "<EP-M0 version>"`)
and its lockfile with `npm install --ignore-scripts --prefix proofs`; add
`proofs/node_modules/` to `.gitignore` if the existing `node_modules/` rule
does not already cover it. Add `LemmaScript-files.txt` (one line naming the
kernel; this is the list `lsc`-based checks read). Add Makefile targets:

```make
proofs: proofs/node_modules
	@cd proofs && npx lsc check --backend=dafny ../src/workflows/dakar-review/instruction-scope-kernel.ts

proofs/node_modules: proofs/package-lock.json
	@npm ci --ignore-scripts --prefix proofs
```

and make `check` call a `proofs-if-available` target that runs `proofs` when
`dafny --version` starts with `4.11.0` and otherwise prints
`proofs skipped: Dafny 4.11.0 not found`. Generate artefacts with
`npx lsc gen --backend=dafny` (once only; later always `lsc regen`, which
three-way merges and keeps proof work). `lsc gen` writes two files beside the
source: `instruction-scope-kernel.dfy.gen`, which is always regenerated and
never edited, and `instruction-scope-kernel.dfy`, which is the source of truth
where helper lemmas go and which may only add lines to the `.gen` file. Write
helper lemmas until `make proofs` passes. Add the budget-selection properties to
`tests/instruction-scope.property.test.mjs`.

Add a `proofs` job to `.github/workflows/ci.yml`: check out, set up Node,
download the Dafny 4.11.0 archive recorded in `EP-M0`, verify its SHA-256, put
it on `PATH`, run `make proofs`, then regenerate `.dfy.gen` into a temporary
copy and fail if it differs from the committed file.

Refactor: keep functions small and lint-clean; run seeded faults A, B, and C
and record each rejection in `Artefacts and notes`; revert them.

Validation: all gates plus `make proofs`. Commit: "Add the proved
instruction-scope kernel".

### `EP-M3` pure instruction-scope policy

Assigned: `REQ-precedence` (ordering only), `REQ-conflict-reporting`,
`INV-locality`, `INV-determinism`, `INV-diagnostic`, D3, D4, D6, D8 (policy
side).

Red: add `tests/instruction-scope.test.mjs` with named cases for every
diagnostic code, malformed paths, the `Purpose / big picture` example, renames
across scopes, a deleted path, a changed instruction file, per-file truncation
at exactly 24,000 and 24,001 code units, and invalid UTF-8 replacement; extend
the property suite with locality, determinism, and diagnostic properties.
Expect "Cannot find module".

Green: add `src/workflows/dakar-review/instruction-scope.ts` exporting the
types and functions in `Interfaces and dependencies`. Split and validate paths;
classify tree entries with a lookup table from (name match, mode) to outcome;
build the catalogue; compute chains through the kernel; group paths by
identical chain; emit diagnostics sorted by code then path with code-unit
comparison (never `localeCompare`); and freeze the result.

Validation: all gates plus `make proofs`. Commit: "Add the instruction-scope
policy and diagnostics".

### `EP-M4` trusted Git discovery, root loading, and pi context fix

Assigned: `REQ-trust`, `INV-fail-closed`, `GAP-symlink`, `GAP-buffer`,
`GAP-subdir`, `GAP-pi-context`, D7, D8 (adapter side), D10, `INV-compat`.

Red:

1. Add `tests/instruction-discovery.test.mjs`, building temporary
   repositories with `initFixtureRepo`, covering the five BDD scenarios plus:
   an executable `AGENTS.md` (accepted); a tree entry named `AGENTS.md` that is
   a directory; a root file over 1 MiB and one over 4 MiB; a directory name with
   `[`, a space, and non-ASCII letters; a SHA-256 repository; a `--repo-root`
   subdirectory; and Git failures in each of `rev-parse`, `ls-tree`,
   `cat-file`, and `diff`, each of which must throw with the expected prefix.
2. In `tests/cli.test.mjs`, add red cases for the symbolic-link root and the
   oversized root, and update "CLI preserves trusted-instruction Git failure
   diagnostics" so its fake `git` injects failures in `ls-tree` and `cat-file`
   (asserting the fallbacks `git ls-tree failed` and `git cat-file failed` and
   the unchanged prefixes); this is a deliberate test change because the read
   command changes.
3. In `tests/adapter-config.test.mjs`, assert that every pi adapter command
   contains `--no-context-files`.
4. In `tests/cli-bundle.test.mjs`, assert that the generated bundle contains
   no import of a `.ts` file.

Green: add `scripts/instruction-discovery.mjs` with
`createGitReader(repoRoot, { timeoutMs })` (the driven adapter, a plain object
of functions using `spawnSync` with explicit `maxBuffer` values, `timeout`,
`-z`, `--literal-pathspecs`, and `--full-tree`),
`loadRootInstructions(reader, baseRef)`, and
`discoverInstructionScope(reader, { baseRef, headRef, changedPaths })`. Replace
the body of `readAgentInstructions()` with a call to `loadRootInstructions()`,
keep its return shape, and print one stderr warning line per root diagnostic,
for example
`dakar-review: AGENTS.md at <sha> is a symbolic link; repository instructions
skipped`.
Add the new script to `NODE_MODULES` in the Makefile; do not add it to
`EXTERNAL_MODULES`. Add `--no-context-files` to the five pi adapters in
`odw.config.json`. Rebuild with `make workflow-build`.

Validation: all gates plus `make proofs`; every pre-existing
`tests/cli.test.mjs` case passes unchanged except the failure-injection test
edited above. Commit in two parts: "Discover AGENTS.md files from the trusted
base" and "Stop pi agents loading untrusted context files".

### `EP-M5` documentation and roadmap closure

Update `docs/users-guide.md`: under "How much of the CodeRabbit format is
honoured", explain that the root `AGENTS.md` comes from the trusted base, that
symbolic links and oversized files are now skipped or truncated with a stderr
warning, that agents no longer load working-copy context files, and that nested
files are specified (link to ADR 0004) but not yet applied to prompts. Update
`docs/developers-guide.md`: §3 module ownership (kernel, policy, adapter, and
the bundling rule), how to add a diagnostic code (ADR table, policy table,
users' guide, tests in one commit), and the proof workflow (`proofs/`,
`make proofs`, `lsc regen`, the `.dfy` additions-only rule, the CI freshness
check); §1 local validation including Dafny 4.11.0. Update
`skills/dakar-review/SKILL.md` (one sentence), `docs/repository-layout.md`
(`proofs/` and the new modules), and `README.md` if the stale-claim search
finds it. Mark 2.3.1 done in `docs/roadmap.md`, note under 2.3.2 that it
consumes `InstructionScopeReport` and must satisfy ADR 0004's consequences, and
add the three D12 follow-ups with `mapsplice`. Search for stale claims,
excluding `docs/execplans/`, and correct each:

```bash
grep -rn 'root .AGENTS.md\|root AGENTS.md\|reviewed repository.s AGENTS' \
  docs README.md skills --exclude-dir=execplans
```

Validation: `make fmt`, all gates, and `make proofs`; reconcile
`Outcomes & retrospective`. Commit: "Document nested AGENTS.md scope and close
2.3.1".

## Milestones and plateaus

- `EP-M0`: probe verdicts recorded; repository unchanged except this plan.
  Recovery: delete the scratch directories.
- `EP-M1`: the design is the accepted source of truth; no behaviour change.
  Recovery: revert the commit.
- `EP-M2`: the kernel is proved, tested, and checked in CI, but nothing calls
  it. Conformance: pure; root `package-lock.json` untouched; no workflow
  manifest change. Recovery: revert; delete `proofs/node_modules`.
- `EP-M3`: the policy produces complete reports from in-memory input.
  Conformance: diagnostics match the ADR table exactly. Recovery: revert.
- `EP-M4`: the CLI loads root instructions through the adapter; the deliberate
  trust fixes are tested; the pi adapters no longer load context files.
  Conformance: trust rule unchanged; stdout and arguments unchanged for a
  regular root file at the top level; bundle has no `.ts` imports. Recovery:
  revert the two commits and run `make workflow-build`.
- `EP-M5`: documentation, roadmap, and CI match behaviour.
- Compatibility decision for every milestone: none. The modules are new and
  internal and the CLI is pre-1.0 (`package.json` version 0.1.0); no
  compatibility layer is introduced.

## Concrete steps

Working directory: the repository root. Enable `pipefail` before piping gates
through `tee` so failures propagate.

```bash
set -o pipefail
BRANCH=$(git branch --show-current)
make check-fmt 2>&1 | tee "/tmp/check-fmt-dakar-$BRANCH.out"
make typecheck 2>&1 | tee "/tmp/typecheck-dakar-$BRANCH.out"
make lint 2>&1 | tee "/tmp/lint-dakar-$BRANCH.out"
make test 2>&1 | tee "/tmp/test-dakar-$BRANCH.out"
make workflow-check 2>&1 | tee "/tmp/workflow-check-dakar-$BRANCH.out"
make proofs 2>&1 | tee "/tmp/proofs-dakar-$BRANCH.out"   # from EP-M2
```

Focused commands:

```plaintext
EP-M2 red:   node --test tests/instruction-scope-kernel.test.mjs -> fails: Cannot find module
EP-M2 green: node --test tests/instruction-scope-kernel.test.mjs -> pass
EP-M2 green: make proofs -> Dafny reports the kernel verified with 0 errors
EP-M3 red:   node --test tests/instruction-scope.test.mjs -> fails: Cannot find module
EP-M3 green: node --test tests/instruction-scope.test.mjs tests/instruction-scope.property.test.mjs -> pass
EP-M4 red:   node --test tests/instruction-discovery.test.mjs -> fails: Cannot find module
EP-M4 red:   node --test tests/cli.test.mjs -> symlink and oversized cases fail
EP-M4 red:   node --test tests/adapter-config.test.mjs -> fails: --no-context-files missing
EP-M4 green: node --test tests/instruction-discovery.test.mjs tests/cli.test.mjs tests/adapter-config.test.mjs -> pass
```

Known baseline needs: `make typecheck` requires `odw` on `PATH`;
`make spelling` fetches the pinned `typos-config-builder`. If either is
unavailable, record the exact error here and do not waive the gate.

## Validation and acceptance

- `tests/instruction-discovery.test.mjs` builds the `Purpose / big picture`
  repository and asserts the three chains and the `name-case-variant`
  diagnostic exactly.
- With a root `AGENTS.md` committed as a symbolic link at the base, the CLI's
  captured workflow arguments contain no `agentInstructions`, stderr carries
  the warning line, and stdout parses as one JSON value.
- With a regular root `AGENTS.md`, the captured workflow arguments are
  byte-identical to the baseline.
- Every pi adapter command in `odw.config.json` contains `--no-context-files`.
- `make proofs` verifies the kernel with zero errors locally and in CI, and
  seeded faults A to D are each rejected for the named reason.
- `make check-fmt`, `make typecheck`, `make lint`, `make test`, and
  `make workflow-check` pass after every milestone, and
  `workflows/dakar-review.js` is byte-identical to the base.

## Idempotence and recovery

Every gate and test is re-runnable. Temporary repositories live under
`os.tmpdir()` and are removed in `t.after()` hooks, as existing CLI tests do.
Use `lsc regen`, never `lsc gen`, once a `.dfy` exists; if a regeneration
conflicts, restore the `.dfy` from Git and rerun. `make workflow-build`
regenerates the CLI bundle deterministically. Each milestone ends in a commit,
so `git revert` followed by `make workflow-build` restores an earlier plateau.

## Artefacts and notes

Reconnaissance (2026-11-17, base `379128f`):

```plaintext
bin/dakar-review.mjs: readAgentInstructions(repoRoot, baseRef) reads <sha>:AGENTS.md
  via git ls-tree and git show, and caps it at 24,000 code units
scripts/review-state.mjs: changedFiles() = git diff --name-only base..head, sorted (no -z)
odw.config.json: pi adapters run pi -p --no-session --provider openai-flex ... (no --no-context-files)
pi --help: --no-context-files, -nc  Disable AGENTS.md and CLAUDE.md discovery and loading
dafny --version -> 4.11.0+fcb2042d6d043a2634f0854338c08feeaaaf4ae2
npm view lemmascript version -> 0.6.10 (dependencies: ts-morph ^25.0.0, lemmascript-claimcheck ^0.2.0)
```

Git probe (scratch repository, 2026-11-17):

```plaintext
$ git --literal-pathspecs ls-tree -z HEAD -- packages/api/ 'we[ir]d/' packages/
120000 blob 47dc3e3…  packages/AGENTS.md
040000 tree 955e2ce…  packages/api-client
100644 blob af7b368…  packages/api/AGENTS.md
040000 tree 00ec51e…  packages/api/src
100644 blob 0dad6d9…  we[ir]d/AGENTS.md
$ git ls-tree HEAD AGENTS.md | awk '{print $3}' | git cat-file --batch
c317064… blob 10
AGENTS.md
```

Design review (2026-11-17): three panellists (Pandalump and Telefono; Doggylump
and Buzzy Bee; Wafflecat and Dinolump) returned "proceed with conditions".
Accepted findings and where they landed: bundling the adapter (Constraints,
`EP-M4`); splitting budget from applicability and stopping at the first misfit
(D11); ancestry discovery without a global cap (D7); merge-base and no-rename
range detection (D8); review-policy ranking by source (D5); `area-condition`
codes with SARIF ids (D6); fail-closed Git errors (Constraints,
`INV-fail-closed`); the isolated proof package and CI job (D9, `EP-M2`); the pi
context-file gap (D10); scope-change on renames (D4); deferring the stderr
report (D1); follow-ups (D12). Pre-mortem scenarios recorded: silent loss of a
deep monorepo instruction file (mitigated by D7 and D11); review jobs hanging
on partial clones (mitigated by D7 and timeouts); moving code out of a strict
scope to escape instructions (mitigated by D4, D8, and D10). Strongest
alternative: desugar nested files into `path_instructions` and report in the
result JSON; its reporting channel is adopted as the 2.3.2 target, its matching
approach is rejected (ADR 0004 options).

Probe, red and green, and seeded-fault transcripts are added here as milestones
complete.

## Interfaces and dependencies

Kernel, `src/workflows/dakar-review/instruction-scope-kernel.ts` (pure, proved,
no imports):

```typescript
/** True when `prefix` equals the first `prefix.length` segments of `path`. */
export function isSegmentPrefix(prefix: readonly string[], path: readonly string[]): boolean

/**
 * Indices of `directories` that are segment prefixes of `parent`, in ascending
 * directory depth. Requires pairwise distinct directories.
 */
export function applicableIndices(
  directories: readonly (readonly string[])[],
  parent: readonly string[],
): number[]

/**
 * The longest prefix of `ranking` whose lengths fit within `budget`; stops at
 * the first ranked index that does not fit.
 */
export function selectWithinBudget(
  lengths: readonly number[],
  ranking: readonly number[],
  budget: number,
): number[]
```

Policy, `src/workflows/dakar-review/instruction-scope.ts` (pure; imports only
the kernel):

```typescript
export const INSTRUCTION_FILE_NAME = 'AGENTS.md'
export const MAX_INSTRUCTION_CHARS = 24_000
export const MAX_INSTRUCTION_BLOB_BYTES = 4 * 1024 * 1024

export type InstructionDiagnosticCode =
  | 'name-case-variant'          // note: e.g. agents.md; not loaded
  | 'entry-symlink'              // warning: symbolic link skipped
  | 'entry-not-blob'             // warning: directory or submodule named AGENTS.md
  | 'entry-too-large'            // warning: blob over 4 MiB not read
  | 'content-truncated'          // note: over 24,000 code units
  | 'content-invalid-utf8'       // warning: decoded with replacement characters
  | 'range-instruction-changed'  // warning: trusted version applied
  | 'path-scope-changed'         // warning: rename between different chains
  | 'path-unresolvable'          // warning: counted, root chain only

export interface InstructionDiagnostic {
  readonly code: InstructionDiagnosticCode
  readonly severity: 'note' | 'warning'
  readonly ruleId: string        // `dakar/instruction/${code}`
  readonly path?: string         // repository-relative; absent for counts
  readonly count?: number        // for path-unresolvable
}

/** Directory scope now; a glob scope is reserved for future sources. */
export type InstructionScope = { readonly kind: 'directory'; readonly segments: readonly string[] }

export interface TreeEntry {
  readonly path: string
  readonly mode: string
  readonly type: string
  readonly objectId: string
}
export interface InstructionFile {
  readonly path: string
  readonly scope: InstructionScope
  readonly objectId: string
  readonly content: string       // at most MAX_INSTRUCTION_CHARS code units
  readonly truncated: boolean
}
export interface ChangeSet {
  readonly paths: readonly string[]                        // rename-free change set
  readonly renames: readonly { readonly from: string; readonly to: string }[]
  readonly instructionChanges: readonly string[]           // any-case AGENTS.md paths changed since the merge base
}
export interface InstructionScopeReport {
  readonly trustedCommit: string
  readonly files: readonly InstructionFile[]               // sorted by depth, then path
  readonly chains: readonly { readonly fileIndices: readonly number[]; readonly paths: readonly string[] }[]
  readonly diagnostics: readonly InstructionDiagnostic[]   // sorted by code, then path
}

/** Ancestor directories (root as '') to list, plus malformed-path counts. */
export function instructionDirectories(changes: ChangeSet): {
  readonly directories: readonly string[]
  readonly unresolvable: number
}
/** Classify listed tree entries into blobs to read and diagnostics. */
export function classifyTreeEntries(entries: readonly TreeEntry[]): {
  readonly accepted: readonly TreeEntry[]
  readonly diagnostics: readonly InstructionDiagnostic[]
}
/** Resolve chains for every changed path from the loaded files. */
export function resolveInstructionScope(
  trustedCommit: string,
  files: readonly InstructionFile[],
  changes: ChangeSet,
  diagnostics: readonly InstructionDiagnostic[],
): InstructionScopeReport
```

Names may change during implementation if TypeDoc or lint rules require it; any
change to a diagnostic code is mirrored in ADR 0004 and the users' guide in the
same commit.

Adapter, `scripts/instruction-discovery.mjs` (host; Node built-ins only;
bundled into the CLI): `createGitReader(repoRoot, { timeoutMs })` returns an
object with `topLevel()`, `resolveCommit(ref)`,
`listDirectories(commit, directories)`, `readBlobs(objectIds, maxBytes)`,
`mergeBase(a, b)`, and `changedPaths(a, b)`;
`loadRootInstructions(reader, baseRef)` returns `{ instructions, diagnostics }`
where `instructions` has today's `{ source, content, truncated }` shape or is
`undefined`; and
`discoverInstructionScope(reader, { baseRef, headRef, changedPaths })` returns
an `InstructionScopeReport`. Tests substitute an in-memory reader for
application-level cases and use real repositories for adapter cases.

Dependencies: `lemmascript` (exact version from `EP-M0`) in
`proofs/package.json` only. No runtime dependency is added; the root
`package.json` and `package-lock.json` are unchanged. Dafny 4.11.0 is a host
and CI tool pinned by version and SHA-256.

## Revision note

- 2026-11-17: initial draft from reconnaissance and prior-art research.
- 2026-11-17: applied the community-of-experts design review. Changes: stderr
  scope report deferred to 2.3.2 (D1); ancestry discovery without a global cap
  (D7); range detection from the merge base without rename detection (D8);
  rename scope-change diagnostic (D4); review-policy precedence by
  configuration source (D5); budget split from applicability with
  stop-at-first-misfit selection (D11); `area-condition` diagnostic codes with
  SARIF rule ids (D6); fail-closed Git errors; adapter bundling rule; isolated
  `proofs/` package and an early CI proof job (D9); pi `--no-context-files`
  (D10); roadmap follow-ups (D12); ADR status timing (D13); recomputed
  tolerances; approval questions added. Milestones renumbered: `EP-M5` is now
  documentation and closure. Remaining work is unchanged in kind and awaits
  approval.
