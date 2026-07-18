# User's guide

This guide is for people who want to run Dakar's Open Dynamic Workflow (ODW)
code-review workflow on a branch. It explains the supported command, what the
workflow reviews, where review history is stored, and how to interpret the
result.

## Installing the CLI

Agents can install Dakar's review command from a checkout with Bun:

```bash
./install.sh
```

The installer calls Bun with the absolute checkout path and exposes
`dakar-review`. The package remains private; the command is meant for local or
git-based installation, not npm publication. `install.sh` accepts no install
arguments; run `./install.sh --help` for its short usage text.
On each repeated installer run, `install.sh` first executes
`bun remove -g dakar` before reinstalling, preventing an interrupted
installation from leaving duplicate `dakar` entries while keeping the shared
Bun lockfile and other global packages intact.

If you prefer to call Bun directly, use an absolute path or `file:` URL:

```bash
bun install -g "$PWD"
bun install -g "file:$PWD"
```

Do not use `bun install -g .` for this local install path. In Bun 1.3.11, bare
`.` is parsed as an empty package spec before Dakar's `package.json` is read,
so Bun installs `@` and creates no `dakar-review` bin link.

## Running a branch review

Dakar reviews only commits that have not already been recorded for the current
branch. From the repository root, the preferred command is:

```bash
dakar-review --repo-root "$PWD" --base origin/main
```

The CLI runs the installed Dakar workflow and passes the reviewed checkout as
`repoRoot`, which is required because ODW normally gives agents copied
workspaces without `.git`.

Before invoking ODW, the CLI resolves configuration and prepares the review
range itself, host-side, with no model calls: it calls
`scripts/review-state.mjs prepare` in-process and passes the result as the
workflow's `prepared` argument. If nothing is unreviewed, the CLI prints the
skip result and exits without invoking ODW at all. The equivalent direct ODW
invocation therefore also needs a `prepared` object built the same way; it is
shown here for illustration only, and `dakar-review` is the supported path:

```bash
odw run workflows/dakar-review.js --source . --wait --timeout 900 \
  --args '{"config":"examples/df12-code-review.yaml","base":"origin/main",
           "repoRoot":"/path/to/dakar","prepared":{"...":"see prepare output"}}'
```

`workflows/dakar-review.js` is a pre-generated runtime artefact included with
Dakar. Running the CLI or invoking that file directly does not require
TypeScript, esbuild, or a contributor build step.

Set `OPENAI_API_KEY` before running a live review. The default
`deterministic-flex-v1` route dispatches finder and audit calls through the
`pi` coding agent (`@earendil-works/pi-coding-agent`) with Dakar's own
`adapters/pi/` extension and provider catalogue; `pi` must be installed and
on `PATH`. The CLI sets `PI_CODING_AGENT_DIR` to point `pi` at that
catalogue and warns on stderr, without failing, if `OPENAI_API_KEY` is
unset.

The `config` argument points at the CodeRabbit YAML file whose review tone,
path instructions, and pre-merge checks should guide the review. The `base`
argument is the branch or ref used to compute the merge base when there is no
previous review history. The `repoRoot` argument points at the real git
checkout being reviewed.

## Command-line options

`dakar-review` accepts the following options:

- `--repo-root <path>` selects the Git checkout to review. The default is the
  current working directory.
- `--config <path>` selects a CodeRabbit YAML file relative to the repository
  root.
- `--base <ref>` selects the base ref for the first review. The default is
  `origin/main`.
- `--head <ref>` selects the head ref to review. The default is `HEAD`.
- `--state-root <path>` overrides the review-history root.
- `--max-tasks <number>`, `--max-candidates <number>`, and
  `--max-findings <number>` override the workflow limits described below.
- `--synthesis-model <model>` and `--synthesis-reasoning <level>` are
  accepted for backward compatibility and still appear in the dry-run
  contract's `synthesisModel`/`synthesisAdapter` fields, but under the
  `deterministic-flex-v1` route the audit call always runs on the fixed
  Terra Flex lane (`gpt-5.6-terra`, medium reasoning); these flags no
  longer change which model or adapter performs the audit.
- `--timeout <seconds>` sets the ODW wait timeout. The default is `900`.
  Operators overriding this should keep it above the review's
  `worstCaseReviewSeconds` (2,020 s at default limits; see the dry-run
  example below), the worst-case wall clock the retry schedule can take.
- `--runs-root <path>` selects the ODW runs directory used for the run, logs,
  and result.
- `--format <json|markdown>` selects the output format. The default is `json`.
- `--odw-bin <path>` selects the ODW executable. The default is `odw`.
- `--telemetry` streams ODW logs to standard error while preserving the final
  result on standard output.
- `--dry-run` returns the workflow contract without launching review agents.
- `--help` prints command usage, and `--version` prints the Dakar version.

When `--config` is omitted, Dakar resolves review configuration in this order:

1. Repository-local `.coderabbit.yaml`.
2. Repository-local `.coderabbit.yml`.
3. Repository-local `coderabbit.yaml`.
4. Repository-local `coderabbit.yml`.
5. User-level `$XDG_CONFIG_HOME/dakar/config.yaml`, or
   `~/.config/dakar/config.yaml` when `XDG_CONFIG_HOME` is unset.
6. Dakar's bundled example config.

The user-level config is treated as the current repository's CodeRabbit config
only when no repository-local CodeRabbit YAML exists. It is useful for agents
that should apply one house review policy across repositories without copying a
`.coderabbit.yaml` into every checkout.

### How much of the CodeRabbit format is honoured

Dakar treats the resolved file as policy context for the review agents, not
as a parsed configuration. The host discovers the path with the precedence
above and injects it into every finder and audit prompt; the agents are
instructed to prioritize explicit policy violations and cite policy rules as
evidence. No key is parsed, validated, or enforced host-side yet, so a
malformed file is not detected (only a missing explicit `--config` path
fails closed).

| Support level | What it covers |
| - | - |
| Host-enforced | Path discovery and precedence; fail-closed handling of a missing explicit `--config` path. Review limits, budget, and ranges come from Dakar's own CLI and workflow arguments, never from this file. |
| Model-mediated | Natural-language policy keys the agents can read and honour: `tone_instructions`, `language`, `reviews.profile`, `reviews.path_instructions`, and the `pre_merge_checks.custom_checks` bodies. Adherence is interpretive, not guaranteed, and instructions are not sliced per changed path. |
| Ignored | CodeRabbit platform features: `early_access`, `chat.integrations`, `knowledge_base`, `issue_enrichment`, `code_generation`, pull-request surface options (`auto_title_instructions`, `high_level_summary_*`, walkthrough and labelling options, `request_changes_workflow`, `abort_on_close`, `auto_review`, `estimate_code_review_effort`), and `tools` integrations (github-checks, languagetool, clippy, presidio). |

_Table: CodeRabbit configuration support levels in the current route._

Host-enforced interpretation of `path_instructions` (sliced per evidence
pack) and `pre_merge_checks` (run as deterministic gates before semantic
review) are planned work; see roadmap items 2.3, 6.2, and 7.5.2, and the
deterministic host boundary in
[ADR 002](adr-002-deterministic-tiered-review-cost.md). Note that a root
`AGENTS.md` is loaded through its own dedicated path (described below)
independently of any `knowledge_base.code_guidelines` patterns in the
CodeRabbit file.

ODW normally runs agents in copied workspaces. Those copies may not contain
the repository's `.git` directory, so live review runs should pass `repoRoot`
as an absolute path. Finder and verifier prompts use `git -C <repoRoot>` for
diff evidence, and the prepare step passes the same path to the state helper.

If the reviewed repository has a root `AGENTS.md`, `dakar-review` passes it to
the workflow as repository-local review context. Workflow schema rules,
machine-readable output requirements, and Dakar safety rules still take
precedence over repository instructions.

For a syntax and contract check that does not call review agents, run either:

```bash
dakar-review --dry-run --repo-root "$PWD"
npm run odw:dry-run
```

Dry-run output includes the workflow version, default finder model set,
synthesis model and adapter, task kinds, limits, default task graph, and JSON
Schemas used for candidate, verifier, and synthesis handoffs.

By default, `dakar-review` stays quiet until the workflow finishes so standard
output is easy to parse. To watch ODW progress while keeping the final result
machine-readable, pass `--telemetry`:

```bash
dakar-review --repo-root "$PWD" --base origin/main --telemetry
```

Telemetry follows `odw logs <run-id> --follow` and writes the live ODW event
stream to standard error. The final JSON or Markdown result still goes to
standard output, so callers can redirect the channels independently:

```bash
dakar-review --repo-root "$PWD" --telemetry > review.json
```

## Review history

Review history is stored outside the repository under the XDG state directory:

```plaintext
$XDG_STATE_HOME/dakar/<repo-owner>/<repo-name>/<branch-slug>/reviews.toml
```

When `XDG_STATE_HOME` is unset, Dakar uses:

```plaintext
~/.local/state/dakar/<repo-owner>/<repo-name>/<branch-slug>/reviews.toml
```

The CLI records the reviewed head commit in-process, after the workflow
returns a completed result, stamping `recorded.recordedBy: "dakar-review"`.
A later run on the same branch reviews only commits after the last recorded
head. If the current `HEAD` has already been recorded, the CLI's host-side
prepare step detects this before invoking ODW at all: it prints the skip
result (`skipped: true`) directly and never launches a model call.

To isolate a trial run from normal review history, pass `stateRoot`:

```bash
dakar-review \
  --repo-root "$PWD" \
  --base origin/main \
  --state-root /tmp/dakar-review-state
```

The equivalent direct ODW invocation, once a matching `prepared` object has
been produced by `scripts/review-state.mjs prepare`, is:

```bash
odw run workflows/dakar-review.js --source . --wait --timeout 900 \
  --args '{"config":"examples/df12-code-review.yaml","base":"origin/main",
           "repoRoot":"/path/to/dakar","stateRoot":"/tmp/dakar-review-state",
           "prepared":{"...":"see prepare output"}}'
```

## What the workflow returns

In the default JSON output mode, a successful live run prints one JSON object
on standard output (the `--format markdown` case is described below). Important
fields are:

- `ok`: whether the workflow itself completed.
- `workflowVersion`: the machine-readable workflow contract version.
- `verdict`: `changes-requested` when at least one finding was accepted,
  otherwise `pass`.
- `config`: the CodeRabbit-compatible config file used for the run.
- `reviewBase`, `headCommit`, and `commitCount`: the reviewed commit range.
- `changedFiles`: files covered by the review.
- `reportMarkdown`: the human-readable review report.
- `findings`: accepted findings that survived the audit.
- `discarded`: rejected candidate findings with discard reasons.
- `taskGraph`, `taskResults`, `candidates`, and `verdicts`: audit data from
  the finder fan-out and the audit call.
- `admissionRefusals`: finder packs the budget controller refused before
  dispatch, each with a reason and its estimated worst-case cost.
- `lunaDowngrades`: finder packs whose Flex retries were exhausted; the
  review continues with the surviving candidates rather than failing.
- `metrics`: counts for tasks, candidates, accepted and discarded findings,
  model assignments, the cost ledger, and audit-routing tallies (see
  "Cost, budget, and the ledger" below).
- `recordInput`: the deterministic data the CLI records to review history;
  present only until the CLI has appended it.
- `recorded`: stamped by the CLI, not the workflow, after a successful
  append: `{ ok, stateFile, headCommit, recordedBy: "dakar-review" }`.

Only `findings` should be treated as actionable review output. The `discarded`
array is an audit trail showing what the workflow rejected. `reportMarkdown`
is presentation text, not a deterministic schema; automation should consume
`findings`, `discarded`, `metrics`, `verdicts`, and `recorded`.

If the branch has already been reviewed, the CLI's host-side prepare step
prints the skip result without invoking ODW:

```json
{
  "ok": true,
  "skipped": true,
  "reason": "No unreviewed commits remain for this branch.",
  "config": ".../config.yaml",
  "stateFile": ".../reviews.toml",
  "headCommit": "..."
}
```

Dry-run output is also JSON, but it describes the contract instead of a review:

```json
{
  "ok": true,
  "dryRun": true,
  "workflowVersion": "divide-and-conquer-v1",
  "config": ".../df12-code-review.yaml",
  "repoRoot": "/path/to/repo",
  "models": [
    "gpt-5.5/low",
    "gpt-5.5/medium",
    "gpt-5.5/high",
    "gpt-5.4-mini/medium",
    "gpt-5.3-codex-spark/medium"
  ],
  "synthesisModel": "gpt-5.5/high",
  "synthesisAdapter": "codex-high",
  "routingPolicy": "deterministic-flex-v1",
  "taskKinds": ["docs", "config", "tests", "source", "review-summary"],
  "limits": {
    "maxTasks": 8,
    "maxCandidates": 30,
    "maxFindings": 20,
    "maxAuditCandidates": 30
  },
  "lanes": {
    "luna": {
      "role": "luna", "model": "gpt-5.6-luna",
      "adapter": "pi-luna-flex", "serviceTier": "flex", "reasoning": "low"
    },
    "luna-medium": {
      "role": "luna-medium", "model": "gpt-5.6-luna",
      "adapter": "pi-luna-flex-medium", "serviceTier": "flex",
      "reasoning": "medium"
    },
    "terra": {
      "role": "terra", "model": "gpt-5.6-terra",
      "adapter": "pi-terra-flex", "serviceTier": "flex", "reasoning": "medium"
    }
  },
  "budgetGbp": 0.1,
  "budgetUsd": 0.127,
  "pricingTableVersion": "2026-07-18",
  "reservedAuditUsd": 0.09375,
  "flexLimits": {
    "maxLunaFlexCalls": 4,
    "transactionMaxFiles": 5,
    "transactionMaxInputTokens": 12000,
    "transactionMaxOutputTokens": 750,
    "terraMaxInputTokens": 48000,
    "terraMaxOutputTokens": 2500,
    "adapterOverheadTokens": 13000
  },
  "flexRetry": {
    "flexAttempts": 3,
    "flexInitialBackoffSeconds": 30,
    "flexMaxBackoffSeconds": 120,
    "flexJitterSeconds": 10,
    "perCallTimeoutSeconds": 300
  },
  "worstCaseReviewSeconds": 2020,
  "defaultTaskGraph": [
    {
      "taskId": "source-1",
      "kind": "source",
      "assignedModel": "gpt-5.5/high",
      "adapter": "codex-high",
      "model": "gpt-5.5",
      "role": "high",
      "maxFindings": 6,
      "verificationPolicy": "verify-all"
    }
  ],
  "candidateSchema": { "type": "object" },
  "verdictSchema": { "type": "object" },
  "auditSchema": { "type": "object" }
}
```

The schemas, lanes, and task graph above are shown abbreviated; the real
dry-run emits the full `candidateSchema`, `verdictSchema`, and `auditSchema`,
plus one task per changed-file group (source, tests, config, docs). The
dry-run no longer includes `synthesisSchema`: the report is rendered by
deterministic host code, not a model call. `synthesisModel` and
`synthesisAdapter` remain in the dry run for the `--synthesis-model` and
`--synthesis-reasoning` flags, but, as noted above, they no longer select
the model or adapter used for the audit call.

`dakar-review --format markdown` prints `reportMarkdown` when a live result has
one. Machine users should prefer the default `--format json`.

On CLI or ODW process failures, `dakar-review` exits non-zero and prints a JSON
error object to standard error:

```json
{
  "ok": false,
  "stage": "cli",
  "error": "..."
}
```

If the workflow returns `ok: false`, the CLI prints that workflow JSON and exits
non-zero. Accepted findings do not make the CLI exit non-zero; they mean the
review succeeded and found actionable issues.

Recording is now CLI-owned, not workflow-owned: after ODW returns a
successful, non-skipped result, the CLI calls Dakar's state helper directly
and stamps `recorded: { ok, stateFile, headCommit, recordedBy:
"dakar-review" }` onto the result before printing it. If that append fails,
the CLI sets `ok: false` and `stage: "record"` on the result, exits non-zero,
and preserves `recordInput` so the review can be recorded manually later; the
same commit range will be reviewed again on the next run because the history
file was not updated. The destination is always derived from the CLI's
trusted `repo-root`/`state-root`, never from workflow-supplied data.

## Routing and limits

The workflow groups changed files into bounded finder evidence packs
(`buildFlexFinderPlan`) of at most `transactionMaxFiles` files each, up to
`maxLunaFlexCalls` packs. Each admitted pack is reviewed by the Luna Flex
lane (`gpt-5.6-luna`, low reasoning by default, escalating to the
pre-registered `pi-luna-flex-medium` medium-reasoning adapter when
`lunaReasoning` is set to `medium`). Files beyond the
`maxLunaFlexCalls x transactionMaxFiles` coverage window are not packed and
are listed in `metrics.truncatedFiles`. Deterministic host code then
deduplicates and severity-orders the resulting candidates and caps them at
`maxAuditCandidates`; the surviving set goes to a single Terra Flex audit
call (`gpt-5.6-terra`, medium reasoning) that returns one verdict per
candidate. Findings that survive the audit are accepted; the rest are
discarded with a reason.

The following optional limits are supported:

- `maxTasks`: maximum planned finder tasks, default `8`.
- `maxCandidates`: maximum candidates kept after normalization, default `30`.
- `maxFindings`: maximum accepted findings in the final result, default `20`.
- `maxAuditCandidates`: maximum candidates sent to the single audit call,
  default `30`; candidates beyond the cap are discarded with reason
  `over_audit_cap`.
- `maxLunaFlexCalls`: maximum finder evidence packs, default `4`.
- `transactionMaxFiles`: maximum files per finder pack, default `5`.
- `budgetGbp`: hard per-review budget in GBP, default `0.10`, converted to
  USD through the pricing table's `usdPerGbp` snapshot.
- `routingPolicy`: recorded in metrics and the dry run; the only supported
  value is `deterministic-flex-v1`.
- `lunaReasoning`: `low` (default) or `medium`, selecting the Luna
  escalation adapter.
- `flexAttempts`, `flexInitialBackoffSeconds`, `flexMaxBackoffSeconds`,
  `flexJitterSeconds`, and `perCallTimeoutSeconds`: the Flex retry schedule
  (see "Retries, downgrades, and deferral" below).
- `transactionMaxInputTokens`, `transactionMaxOutputTokens`,
  `terraMaxInputTokens`, `terraMaxOutputTokens`, and
  `adapterOverheadTokens`: token bounds feeding the cost estimator.

Example:

```bash
odw run workflows/dakar-review.js --source . --wait --timeout 900 \
  --args '{"config":"examples/df12-code-review.yaml","base":"origin/main",
           "repoRoot":"/path/to/dakar","prepared":{"...":"see prepare output"},
           "maxTasks":4,"maxFindings":5}'
```

## Cost, budget, and the ledger

Every finder and audit call runs through an admission controller that
enforces the hard `budgetGbp` before any model call is dispatched. The
audit's worst-case cost is reserved first, before any Luna finder call, so
an unaffordable review refuses outright (`stage: "admission"`) rather than
spending on finders it cannot afford to conclude. Refused finder packs are
listed in `admissionRefusals` and never consume any budget.

`metrics` carries the cost accounting:

- `ledger`: one entry per admitted call, with `lane`, `model`,
  `serviceTier`, `reasoningEffort`, `estimatedWorstCaseUsd`,
  `pricingTableVersion`, and `attempts`.
- `ledgerTotalEstimatedUsd`: the sum of admitted worst-case estimates.
- `budgetUsd`, `reservedAuditUsd`, and `spentUsd`: the admission trail for
  this run.
- `routingPolicy` and `pricingTableVersion`: which routing policy and
  pricing snapshot produced this ledger.
- `auditCandidateCount`, `overAuditCapCount`, `unknownAuditVerdictCount`,
  and `duplicateAuditVerdictCount`: audit compaction and verdict-pairing
  tallies.
- `lunaDowngradeCount` and `truncatedFiles`: partial-coverage indicators.

## Retries, downgrades, and deferral

Flex calls retry under bounded exponential backoff (`flexAttempts`, default
`3`; backoff from `flexInitialBackoffSeconds` (`30`) up to
`flexMaxBackoffSeconds` (`120`), with up to `flexJitterSeconds` (`10`) of
deterministic jitter). A finder pack that exhausts its retries downgrades:
it is recorded in `lunaDowngrades` and `metrics.lunaDowngradeCount`, and the
review continues with the surviving candidates. An audit call that
exhausts its retries defers the whole review instead: the result is
`ok: false`, `stage: "deferred"`, no `recordInput` is present, and the CLI
exits non-zero without recording anything, so the head remains unreviewed.

A deferred review retried later re-pays its Luna finder calls: Luna output
is not cached across separate `dakar-review` invocations, so a retry after
a deferral repeats the finder phase's spend (roughly USD 0.04 worst case at
default limits). Operators should space retries after a deferral rather
than tight-looping them.

`worstCaseReviewSeconds` (2,020 s at default limits, shown in the dry run)
is the worst-case wall clock for one review's finder and audit retry
chains. Operators overriding `--timeout` should keep it above this figure.

## Error and skip behaviour

Configuration resolution and range preparation are deterministic host code
run by the CLI before ODW is invoked; a failure there is reported by the CLI
with stage `config` or `prepare` and never launches ODW. Within the
workflow, an admission refusal for the audit's own reservation returns
`stage: "admission"` before any model call; an incomplete audit (a missing
or invalid verdict) fails closed with `stage: "audit"` so nothing is
recorded; an exhausted audit retry defers with `stage: "deferred"` (see
above). If the CLI's own append to review history fails after a completed
review, the result carries `stage: "record"` with `recordInput` preserved
for manual retry, and the same commit range will be reviewed again on the
next run.

If `origin/main` is not available, pass a different `base`. If prepare reports
that the workspace is not a git repository, pass `repoRoot` as an absolute path
to the real checkout.
