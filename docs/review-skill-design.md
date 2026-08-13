# Review skill design

Status: Living design Audience: Editors maintaining
[`skills/dakar-review/SKILL.md`](../skills/dakar-review/SKILL.md) Date:
2026-08-13 Companion documents: [`docs/users-guide.md`](users-guide.md) and
[`docs/dakar-review-design.md`](dakar-review-design.md)

## 1. Purpose

The `dakar-review` skill teaches an agent how to run effective, correctly
budgeted Dakar reviews. This document records how the skill was validated:
which live estate pull requests were reviewed, the exact commits pinned and
tagged for replay, the flags used, and the observed outcomes. It also captures
design guidance a future editor needs before changing the skill.

## 2. Evaluation fixtures

Five open pull requests from the `github.com/leynos/*` estate were selected as
fixtures on 2026-08-13, spanning toolchains (Rust, Python, TypeScript, and
docs-only) and diff sizes from one file to eighty-two. Every fixture's exact
base (merge base with `main`) and head commits are pinned in
[`scripts/live-corpus.json`](../scripts/live-corpus.json) under `skill-*` tier
labels, and tagged on each remote repository so the commits stay reachable
after branches rebase or merge:

- `refs/tags/dakar-eval/pr-<number>-base` — the merge base reviewed against.
- `refs/tags/dakar-eval/pr-<number>-head` — the head commit reviewed.

| Tier               | Fixture                 | Files | Base commit | Head commit |
| ------------------ | ----------------------- | ----- | ----------- | ----------- |
| skill-docs-tiny    | `leynos/mdtablefix#413` | 1     | `cbf7cb07`  | `cb89fdd4`  |
| skill-small        | `leynos/rstest-bdd#627` | 1     | `1e08dcbf`  | `9553d001`  |
| skill-medium       | `leynos/df12-www#74`    | 7     | `867d63e6`  | `fff441f7`  |
| skill-upper-medium | `leynos/gauss#124`      | 14    | `d1bf6ce7`  | `0ea0cf8a`  |
| skill-large        | `leynos/concordat#110`  | 82    | `fcf22696`  | `8e0ece98`  |

_Table: evaluation fixtures. Full 40-character commit identifiers are pinned in
`scripts/live-corpus.json`; the remote tags point at the same objects._

Full commit identifiers:

- `leynos/mdtablefix#413`: base
  `cbf7cb0705f84ba2564dfa1e51341fcadac9b6b7`, head
  `cb89fdd4afd536f59af308f81ddea00efe4a61a8`.
- `leynos/rstest-bdd#627`: base
  `1e08dcbf97f24697a38b26744aeb5d9d2214c27e`, head
  `9553d00130d48c4ac38a9190218cafb36366a926`.
- `leynos/df12-www#74`: base
  `867d63e6d0896d3a16c0de2a7a749594e3eec467`, head
  `fff441f730d65643c54863b30c167a01734cd208`.
- `leynos/gauss#124`: base
  `d1bf6ce7ece9df3f60c720071c5b9ac3f569c57c`, head
  `0ea0cf8a8586856b02456b4687905c4b911aaff3`.
- `leynos/concordat#110`: base
  `fcf22696f127606da9ef5cdab9cabdea9849f37c`, head
  `8e0ece98a3778d93eb90acf0c97beb04608a799c`.

## 3. Recorded evaluation runs

All runs were executed on 2026-08-13 through
[`scripts/live-review-harness.mjs`](../scripts/live-review-harness.mjs) with
`pi` 0.84.1, ODW 0.4.0, pricing table 2026-07-18, and the user-level
`~/.config/dakar/config.yaml` policy. The first four fixtures ran with
`--budget-gbp 0.15` and otherwise default limits; the large fixture ran with
`--budget-gbp 0.3 --max-luna-calls 8 --transaction-max-files 10`.

| Fixture          | Flags               | Verdict | Accepted | Discarded | Reported USD |
| ---------------- | ------------------- | ------- | -------- | --------- | ------------ |
| `mdtablefix#413` | `--budget-gbp 0.15` | pass    | 0        | 0         | 0.0079       |
| `rstest-bdd#627` | `--budget-gbp 0.15` | pass    | 0        | 0         | 0.0120       |
| `df12-www#74`    | `--budget-gbp 0.15` | pass    | 0        | 0         | 0.0517       |
| `gauss#124`      | `--budget-gbp 0.15` | pass    | 0        | 1         | 0.0843       |
| `concordat#110`  | see below           | pass    | 0        | 0         | 0.1766       |

_Table: recorded evaluation outcomes. Reported USD is the priced sum of the
adapter's reported token usage, not the admitted worst case._

The `concordat#110` run used
`--budget-gbp 0.3 --max-luna-calls 8 --transaction-max-files 10`. Its eight
finder packs covered 67 of the 82 changed files; the remaining 15 appear in
`metrics.truncatedFiles`, so the run completed with `recordWithheld` and was
deliberately not recorded to review history (see §4.5). Packs group files by
task kind (source, tests, config, docs), so coverage can truncate below the
arithmetic `maxLunaFlexCalls x transactionMaxFiles` maximum.

To replay a fixture:

```bash
node scripts/live-review-harness.mjs \
  --repo leynos/gauss --pr 124 \
  --work /tmp/dakar-eval/work --out /tmp/dakar-eval/out \
  --dakar-args " --budget-gbp 0.15"
```

The harness clones the repository, fetches and verifies the pinned base and
head SHAs against the corpus manifest, checks the head out detached, isolates
review history under the output directory, and injects the API key from
`~/dakar-api-key.txt` into the child environment only.

## 4. Findings that shaped the skill

### 4.1 The default budget refuses every finder pack

At pricing table 2026-07-18 the default `budgetGbp` of 0.1 converts to USD
0.127. Admission reserves the audit's single-attempt worst case (USD 0.1141)
first, leaving USD 0.0129 — less than one finder pack's worst case (USD
0.0142). Every pack is refused and the workflow correctly fails with a "zero
coverage" error rather than recording a hollow pass. The initial evaluation
attempt demonstrated this on all five fixtures. The skill therefore instructs
agents to always pass an explicit budget, with `--budget-gbp 0.15` as the
working floor. If default token bounds or pricing change, revisit the skill's
budget arithmetic.

### 4.2 The harness rejects `--dakar-args` values starting with dashes

`parseCliArgs` in the harness treats any option value beginning with `--` as a
missing value. Passing extra CLI flags through `--dakar-args` requires a
leading space in the quoted value, for example
`--dakar-args " --budget-gbp 0.15"`. The skill documents the workaround; a
future harness change could remove the restriction, at which point the skill
should drop the note.

### 4.3 Low-reasoning finders are conservative on clean pull requests

Across the four smaller fixtures the Luna low-reasoning finders produced a
single candidate in total (a `typos.local.toml` ignore-pattern concern on
`gauss#124`), which the Terra audit discarded with a reasoned `not_applicable`
disposition. Each finder returned a substantive `noFindingsReason`, so silence
reflected judgement rather than parsing failure. Editors seeking higher recall
on suspect branches should recommend `--luna-reasoning medium`, accepting the
higher per-pack cost.

### 4.4 Reported spend can exceed the admitted estimate on large runs

On `concordat#110` the priced reported usage (USD 0.1766) exceeded the admitted
worst-case ledger total (USD 0.1040). This matches the user guide's note that
the default `adapterOverheadTokens` of 13,000 undermodels the cache that `pi`'s
agentic loop writes on first, uncached calls; raising
`--adapter-overhead-tokens` towards 28,000 gives more honest admission
estimates on large or cold-cache runs. The hard budget bounds admission
estimates, not the provider's eventual bill, so operators watching real spend
should read `reportedUsd` from the harness summary rather than the ledger.

### 4.5 Recording is withheld on partial coverage

A successful review with truncated files, refused packs, or downgraded packs is
deliberately not recorded to review history. The skill therefore tells agents
to check `metrics.truncatedFiles`, `admissionRefusals`, and `lunaDowngrades`
after every run, and to scale `--max-luna-calls`, `--transaction-max-files`,
and the budget together on large diffs.

## 5. Design guidance for future editors

- The skill lives at `skills/dakar-review/SKILL.md` with YAML frontmatter
  (`name`, trigger-rich `description`). Keep the description aligned with the
  triggers agents actually express: run a review, tune a budget, replay an
  evaluation, interpret output.
- The skill paraphrases [`docs/users-guide.md`](users-guide.md); the guide is
  authoritative. When the CLI contract changes (flags, stages, output fields),
  update the guide first and re-derive the skill's guidance from it.
- The budget arithmetic in the skill (§4.1 above) is coupled to the pricing
  table version and default token bounds in
  [`src/workflows/dakar-review/pricing.ts`](../src/workflows/dakar-review/pricing.ts).
  Re-check the figures whenever either changes.
- Fixture entries in `scripts/live-corpus.json` must never be edited in
  place: they pin what was actually reviewed. Add new entries (and new remote
  tags) instead, and record new runs in §3.
- The `dakar-eval/*` tags on the fixture repositories are lightweight tags on
  otherwise unreferenced commits. Do not delete them; replay depends on the
  objects staying fetchable.
- Live replays spend real provider budget. Keep trial state isolated (the
  harness does this automatically) and never place the API key on a command
  line or in a committed file.
