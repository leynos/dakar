---
name: dakar-review
description:
  Run Dakar's budgeted, routed code review over the unreviewed commits on a
  branch using the dakar-review CLI. Use when asked to review a branch with
  Dakar, run or tune dakar-review, replay a pinned Dakar evaluation, choose a
  review budget, or interpret Dakar output (SARIF, findings, admission
  refusals, Luna downgrades, deferrals, or withheld recording).
---

# dakar-review

Dakar reviews the commits on a branch that have not already been reviewed,
using a deterministic, budgeted fan-out of model calls: bounded "finder" packs
on the Luna Flex lane produce candidate findings, and a single Terra Flex audit
call accepts or discards each candidate. The result is one JSON object on
stdout with a SARIF evidence document, a Markdown report, and a full cost
ledger. Dakar is not a linter: it spends budget on semantic correctness,
security, behavioural regressions, and missing context, not formatting.

## Prerequisites

- `node`, `bun`, and `odw` on `PATH`, plus the `pi` coding agent
  (`bun add -g @earendil-works/pi-coding-agent`).
- `OPENAI_API_KEY` exported for live runs. The CLI warns on stderr but does
  not fail if it is unset; the finder calls then fail instead.
- Install the CLI from a Dakar checkout with `./install.sh`, or run
  `node bin/dakar-review.mjs` directly from the checkout.

## Quick start

From the root of the repository under review:

```bash
OPENAI_API_KEY=... dakar-review \
  --repo-root "$PWD" \
  --base origin/main \
  --telemetry > review.json
```

- `--repo-root` must be the real git checkout, as an absolute path.
- `--base` is only used when the branch has no review history; later runs
  review from the last recorded head.
- `--telemetry` streams ODW progress to stderr while keeping stdout
  machine-readable.
- `--format markdown` prints the human-readable report instead of JSON.
- `--dry-run` prints the workflow contract (models, lanes, limits, budget
  arithmetic) without any model call; use it to sanity-check a configuration.

## Set the budget deliberately

The admission controller reserves the audit call's worst case (about USD 0.114
at default token bounds) before admitting any finder pack, and each finder
pack's worst case is about USD 0.0142. The default `--budget-gbp 0.15` (USD
0.1905) covers the default caps — four packs of five files plus the audit
reserve, with modest retry headroom. A budget too small for even one pack fails
with a "zero coverage" error rather than reporting a hollow pass, so a lowered
budget or raised caps must keep the arithmetic in balance:

- Approximate rule: `budgetUsd >= 0.114 + packs x 0.0143`, with
  `packs = ceil(changedFiles / transactionMaxFiles)` capped at
  `maxLunaFlexCalls`. GBP converts at the pricing table's snapshot (1.27).
- The default budget suffices for up to 20 changed files at the default caps;
  no flag is needed for ordinary branch reviews.
- For larger diffs, raise coverage and budget together, for example
  `--budget-gbp 0.3 --max-luna-calls 8 --transaction-max-files 10` for up to 80
  files. Packs group files by task kind (source, tests, config, docs), so real
  coverage can fall short of the arithmetic maximum — always verify
  `metrics.truncatedFiles` afterwards.
- The budget bounds admission estimates, not the provider's bill: on large or
  cold-cache runs, real reported usage can exceed the ledger estimate because
  the default `--adapter-overhead-tokens 13000` undermodels `pi`'s first-call
  cache writes. Raise it towards `28000` for honest admission on large runs.

Check coverage after every run: `metrics.truncatedFiles` lists files that were
never packed, `admissionRefusals` lists packs the budget refused, and
`lunaDowngrades` lists packs whose retries were exhausted. A successful run
with any of these is not recorded to review history (`recordWithheld` replaces
`recordInput`), so the same head is reviewed again next time.

## Read the result

- `verdict` is `changes-requested` or `pass`; accepted findings do not make
  the CLI exit non-zero. Non-zero exit means the review itself failed.
- `sarif` is the authoritative evidence document; `findings`, `discarded`,
  and `reportMarkdown` are derived projections.
- `metrics.ledger` itemizes every admitted call with its worst-case estimate;
  `metrics.spentUsd` and `budgetUsd` show the admission trail.
- Failure stages: `config`/`prepare` (host-side, before ODW), `admission`
  (budget refused the audit reserve), `audit` (invalid audit output,
  fail-closed), `deferred` (audit retries exhausted; space out the retry —
  finder spend is re-paid), `record` (history append failed; `recordInput` is
  preserved for manual recovery).
- `skipped: true` means the branch head was already reviewed; nothing ran.

## Review history and trial runs

Completed, fully covered reviews record the head commit under
`$XDG_STATE_HOME/dakar/<owner>/<repo>/<branch>/reviews.toml`; later runs review
only newer commits. For experiments, isolate history with
`--state-root /tmp/dakar-trial` so real branch history is untouched.

## Configuration

Without `--config`, Dakar resolves a CodeRabbit-compatible YAML from the
repository (`.coderabbit.yaml` and variants), then
`~/.config/dakar/config.yaml`, then a bundled example. Path instructions are
sliced per finder pack by changed path; `pre_merge_checks.custom_checks`
commands run host-side from the trusted base commit before any model call. A
root `AGENTS.md` is passed to the workflow as repository context.

## Replaying pinned evaluations

The repository pins evaluation fixtures (open estate pull requests, with base
and head SHAs) in `scripts/live-corpus.json`; the fixture commits are also
tagged on each remote as `dakar-eval/pr-<n>-base` and `dakar-eval/pr-<n>-head`
so they survive branch rebases. Replay one with the harness, which clones,
verifies the pinned SHAs, isolates state, and injects the key from
`~/dakar-api-key.txt`:

```bash
node scripts/live-review-harness.mjs \
  --repo leynos/gauss --pr 124 \
  --work /tmp/dakar-eval/work --out /tmp/dakar-eval/out \
  --dakar-args "--budget-gbp 0.15"
```

Fixture provenance and the exact flags used for the recorded evaluation runs
are documented in `docs/review-skill-design.md`.
