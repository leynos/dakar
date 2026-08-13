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

The first corpus turned out to be clean at every head — useful for validating
the pass path, but silent on the findings path. A second, finding-oriented
corpus was therefore added on the same day. Its heads are deliberately not the
pull requests' current heads: each pins an early, pre-review-fix commit (the
initial implementation round, before "address review" commits landed), because
current heads have already absorbed reviewer feedback. CodeRabbit's inline
comments on those same rounds provide benchmark data (§4.4).

| Tier                    | Fixture                       | Files | Base commit | Head commit |
| ----------------------- | ----------------------------- | ----- | ----------- | ----------- |
| skill-findings-small    | `leynos/netsuke#545`          | 1     | `76456df1`  | `d9f5dce7`  |
| skill-findings-medium   | `leynos/ortho-config#419`     | 12    | `9fba1ed0`  | `b55f4b22`  |
| skill-findings-medium-2 | `leynos/repovec-appliance#78` | 18    | `dc9c97b9`  | `2032b9d3`  |
| skill-findings-large    | `leynos/cuprum#271`           | 17    | `7f6ec929`  | `a87b3a83`  |

_Table: finding-oriented fixtures pinned at pre-review-fix commits._

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
- `leynos/netsuke#545`: base
  `76456df19ff418081e3bac9970d93e6196babdd7`, head
  `d9f5dce7bc591436b7c3578c4a25dbbac07e927b`.
- `leynos/ortho-config#419`: base
  `9fba1ed061bbfaeecaa1fb0ea81881e55fbac474`, head
  `b55f4b22be7860c3ef7886fe1014fc4bbf7a23b9`.
- `leynos/repovec-appliance#78`: base
  `dc9c97b96b6f640a7d03a99d0903154200c711a0`, head
  `2032b9d313562225d2295bb88508f352ebc2331a`.
- `leynos/cuprum#271`: base
  `7f6ec929e3bf068130c81d26346060d04d94aeec`, head
  `a87b3a83a85c8a1081af994f320823fc0041c436`.

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
deliberately not recorded to review history (see §4.6). Packs group files by
task kind (source, tests, config, docs), so coverage can truncate below the
arithmetic `maxLunaFlexCalls x transactionMaxFiles` maximum.

To replay a fixture:

```bash
node scripts/live-review-harness.mjs \
  --repo leynos/gauss --pr 124 \
  --work /tmp/dakar-eval/work --out /tmp/dakar-eval/out \
  --dakar-args "--budget-gbp 0.15"
```

The recorded runs quoted the `--dakar-args` value with a leading space to work
around a parser restriction that has since been fixed (see §4.2); both forms
parse identically now.

The harness clones the repository, fetches and verifies the pinned base and
head SHAs against the corpus manifest, checks the head out detached, isolates
review history under the output directory, and injects the API key from
`~/dakar-api-key.txt` into the child environment only.

### 3.1 Finding-oriented runs

The four finding-oriented fixtures ran on 2026-08-13 after the default-budget
fix landed, so all ran at the GBP 0.15 default with no extra flags except where
noted. Three of four delivered accepted findings at default (low) Luna
reasoning; the fourth delivered on a medium-reasoning re-run.

| Fixture                | Flags                     | Verdict           | Accepted | Reported USD |
| ---------------------- | ------------------------- | ----------------- | -------- | ------------ |
| `netsuke#545` (low)    | defaults                  | changes-requested | 0        | 0.0120       |
| `netsuke#545` (medium) | `--luna-reasoning medium` | changes-requested | 1        | 0.0483       |
| `ortho-config#419`     | defaults                  | changes-requested | 2        | 0.0856       |
| `repovec-appliance#78` | defaults                  | changes-requested | 1        | 0.0904       |
| `cuprum#271`           | defaults                  | changes-requested | 2        | 0.1667       |

_Table: finding-oriented run outcomes. The `repovec-appliance#78` run truncated
2 of 18 files through kind-grouped packing, so its recording was withheld; the
others recorded with full coverage._

Accepted findings, in brief:

- `netsuke#545` (medium): the `AlreadyExists` branch in
  `test_support/src/manifest.rs` converts a directory-creation race into
  `Ok(())`, returning a directory as though it were a usable manifest file.
- `ortho-config#419`: two ExecPlan self-contradictions (a constraint that
  omits the `display_name` mutation the implementation performs, and a stale
  draft-only approval gate contradicting the recorded approval).
- `repovec-appliance#78`: a test reimplements `parse_mode` instead of calling
  the production parser, so the claimed octal-normalization coverage cannot
  fail when the production parser regresses.
- `cuprum#271`: the tracing adapter drops `timeout_s` and `timeout_mode` when
  copying timeout event attributes into span events, and an expanded test
  module exceeds the 400-line policy.

### 3.2 Re-evaluation with context tools, high reasoning, and the repricing

The finding corpus was re-run on 2026-08-13 after three workflow changes landed
together: the 2026-08-13 pricing table (Luna Flex at a fifth of the prior
rates, Terra Flex at four fifths), high-reasoning defaults for both lanes, and
finder access to the CodeGraph and DeepWiki context tools through the `mcp` CLI
with a host-side CodeGraph warmup. All four fixtures ran at pure defaults from
fresh state roots.

| Fixture                | v1 accepted     | v2 accepted | v2 reported USD |
| ---------------------- | --------------- | ----------- | --------------- |
| `netsuke#545`          | 0 (1 at medium) | 1           | 0.0363          |
| `ortho-config#419`     | 2               | 5           | 0.0520          |
| `repovec-appliance#78` | 1               | 6           | 0.1860          |
| `cuprum#271`           | 2               | 6           | 0.1812          |

_Table: v1 (low reasoning, 2026-07-18 pricing, no context tools) versus v2
(high reasoning, 2026-08-13 pricing, context tools) accepted findings._

Observations:

- Recall rose on every fixture. `netsuke#545` now accepts the manifest race
  at CodeRabbit's exact anchor without an escalation flag. `ortho-config#419`
  reaches CodeRabbit's source territory (`cargo/mod.rs:110` against their
  `mod.rs:115`) and adds a test-hardening finding. `repovec-appliance#78`
  yields a high-severity parser validation gap plus two further parser defects
  on a pull request CodeRabbit never reviewed. `cuprum#271` overlaps
  CodeRabbit's `events.py` anchors with a medium compatibility finding.
- Cost per finding fell sharply: the two smaller fixtures cost less at high
  reasoning under the new rates than at low reasoning under the old rates. The
  two larger fixtures reported around USD 0.18 each, dominated by
  high-reasoning output tokens across four packs plus the audit.
- The audit discarded nothing across the four runs; at high reasoning both
  the finders and the audit converged on the same accepted sets.

## 4. Findings that shaped the skill

### 4.1 The default budget refuses every finder pack

At pricing table 2026-07-18 the default `budgetGbp` of 0.1 converts to USD
0.127. Admission reserves the audit's single-attempt worst case (USD 0.1141)
first, leaving USD 0.0129 — less than one finder pack's worst case (USD
0.0142). Every pack is refused and the workflow correctly fails with a "zero
coverage" error rather than recording a hollow pass. The initial evaluation
attempt demonstrated this on all five fixtures.

Resolved: the default `budgetGbp` was raised to 0.15 (USD 0.1905) on the
`issues-identified-during-skill-creation` branch, with a dated amendment to ADR
002 recording the arithmetic. The recorded evaluation runs passed
`--budget-gbp 0.15` explicitly because they predate the new default; replays at
default settings now admit the same coverage. If default token bounds or
pricing change, revisit the skill's budget arithmetic.

### 4.2 The harness rejects `--dakar-args` values starting with dashes

`parseCliArgs` in the harness treated any option value beginning with `--` as a
missing value, so extra CLI flags could only pass through `--dakar-args` with a
leading space in the quoted value (the recorded evaluation runs used
`--dakar-args " --budget-gbp 0.15"`).

Resolved: the `issues-identified-during-skill-creation` branch marks
`dakar-args` as carrying an option-like value, so
`--dakar-args "--budget-gbp 0.15"` now parses directly; ordinary flags still
reject a following flag token as a missing value. The leading-space form
remains accepted, so the recorded invocations replay unchanged.

### 4.3 Low-reasoning finders are conservative; medium reasoning recovers recall

Across the four clean fixtures the Luna low-reasoning finders produced a single
candidate in total (a `typos.local.toml` ignore-pattern concern on
`gauss#124`), which the Terra audit discarded with a reasoned `not_applicable`
disposition. Each finder returned a substantive `noFindingsReason`, so silence
reflected judgement rather than parsing failure.

The finding-oriented corpus quantified the trade. At low reasoning,
`netsuke#545` returned zero findings where CodeRabbit had flagged a
functional-correctness Major; at `--luna-reasoning medium` Dakar accepted the
same defect at the same anchor (`test_support/src/manifest.rs:109`) for roughly
four times the reported finder spend. The skill therefore recommends medium
reasoning for suspect or unreviewed branches and the low default for routine
incremental review.

### 4.4 CodeRabbit benchmark comparison on pre-review commits

CodeRabbit's inline comments on the same rounds give a recall benchmark:

- `netsuke#545` @ `d9f5dce7`: CodeRabbit posted one functional-correctness
  Major and one maintainability Major. Dakar at low reasoning found neither; at
  medium reasoning it accepted the functional-correctness defect at
  CodeRabbit's exact anchor (`test_support/src/manifest.rs:109`). The PR's own
  follow-up commit ("Reject raced manifest directories") fixed precisely that
  defect, confirming both reviewers.
- `ortho-config#419` first round: CodeRabbit raised five potential issues and
  one nitpick across the ExecPlan, `ortho_config/src/cargo/mod.rs`, and two
  test files. Dakar accepted two ExecPlan contradictions (one within four lines
  of a CodeRabbit anchor) but missed the source and test issues at low
  reasoning.
- `repovec-appliance#78`: CodeRabbit recorded no comments on the draft
  pull request; Dakar's test-effectiveness finding has no benchmark counterpart.
- `cuprum#271` early rounds: CodeRabbit raised roughly sixteen distinct
  anchors; Dakar accepted two findings, one of them (dropped span-event timeout
  attributes) outside CodeRabbit's early anchor set.

The comparison is directional, not a controlled experiment: CodeRabbit reviewed
several rounds with repository scripts at its disposal, while Dakar saw one
pinned diff under a GBP 0.15 budget spending roughly USD 0.05-0.17 per review.

For replaying the comparison, these are the CodeRabbit review banners posted
immediately after each pinned commit:

- `netsuke#545` @ `d9f5dce7`:
  [review 4890391311](https://github.com/leynos/netsuke/pull/545#pullrequestreview-4890391311)
  (submitted twenty minutes after the pinned commit, on that exact commit).
- `ortho-config#419` @ `b55f4b22`:
  [review 4891600420](https://github.com/leynos/ortho-config/pull/419#pullrequestreview-4891600420)
  (on `7046703b`, the pre-rebase identity of the pinned implementation round).
- `repovec-appliance#78` @ `2032b9d3`: no CodeRabbit review exists on the
  draft pull request.
- `cuprum#271` @ `a87b3a83`:
  [review 4870027319](https://github.com/leynos/cuprum/pull/271#pullrequestreview-4870027319)
  (the first review submitted after the pinned commit landed; the branch was
  later rebased, so CodeRabbit's commit identifiers do not appear in current
  history).

### 4.5 Reported spend can exceed the admitted estimate on large runs

On `concordat#110` the priced reported usage (USD 0.1766) exceeded the admitted
worst-case ledger total (USD 0.1040). This matches the user guide's note that
the default `adapterOverheadTokens` of 13,000 undermodels the cache that `pi`'s
agentic loop writes on first, uncached calls; raising
`--adapter-overhead-tokens` towards 28,000 gives more honest admission
estimates on large or cold-cache runs. The hard budget bounds admission
estimates, not the provider's eventual bill, so operators watching real spend
should read `reportedUsd` from the harness summary rather than the ledger.

### 4.6 Recording is withheld on partial coverage

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
