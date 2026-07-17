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

The equivalent direct ODW invocation is:

```bash
odw run workflows/dakar-review.js --source . --wait --timeout 900 \
  --args '{"config":"examples/df12-code-review.yaml","base":"origin/main","repoRoot":"/path/to/dakar"}'
```

`workflows/dakar-review.js` is a pre-generated runtime artefact included with
Dakar. Running the CLI or invoking that file directly does not require
TypeScript, esbuild, or a contributor build step.

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
- `--synthesis-model <model>` selects the synthesis model. The default is
  `gpt-5.5`.
- `--synthesis-reasoning <level>` selects `low`, `medium`, or `high` reasoning
  for synthesis. The default is `high`.
- `--timeout <seconds>` sets the ODW wait timeout. The default is `900`.
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

The workflow records the reviewed head commit after synthesis. A later run on
the same branch reviews only commits after the last recorded head. If the
current `HEAD` has already been recorded, the workflow returns `skipped: true`
and does not launch review agents.

To isolate a trial run from normal review history, pass `stateRoot`:

```bash
dakar-review \
  --repo-root "$PWD" \
  --base origin/main \
  --state-root /tmp/dakar-review-state
```

The equivalent direct ODW invocation is:

```bash
odw run workflows/dakar-review.js --source . --wait --timeout 900 \
  --args '{"config":"examples/df12-code-review.yaml","base":"origin/main","repoRoot":"/path/to/dakar","stateRoot":"/tmp/dakar-review-state"}'
```

## What the workflow returns

In the default JSON output mode, a successful live run prints one JSON object
on standard output (the `--format markdown` case is described below). Important
fields are:

- `ok`: whether the workflow itself completed.
- `workflowVersion`: the machine-readable workflow contract version.
- `config`: the CodeRabbit-compatible config file used for the run.
- `resolvedConfig`: config resolution audit data, including `source` and
  checked paths.
- `stateFile`: review-history file used for this branch.
- `reviewBase` and `headCommit`: reviewed commit range.
- `changedFiles`: files covered by the review.
- `reportMarkdown`: the human-readable review report.
- `findings`: accepted findings that survived high-reasoning verification.
- `discarded`: rejected candidate findings with discard reasons.
- `taskGraph`: the bounded review tasks planned for the change set.
- `taskResults`, `candidates`, and `verdicts`: audit data from fan-out and
  verification.
- `metrics`: counts for tasks, candidates, accepted findings, discarded
  findings, model assignments, and warnings.
- `recordAttempts`: the number of workflow attempts made to record review
  history, from one through three.
- `recorded`: the review-history write result.

Only `findings` should be treated as actionable review output. The `discarded`
array is an audit trail showing what the workflow rejected. `reportMarkdown`
is presentation text, not a deterministic schema; automation should consume
`findings`, `discarded`, `metrics`, `verdicts`, and `recorded`.

If the branch has already been reviewed, output still uses JSON:

```json
{
  "ok": true,
  "skipped": true,
  "reason": "No unreviewed commits remain for this branch.",
  "config": ".../config.yaml",
  "resolvedConfig": { "source": "user" },
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
  "taskKinds": ["docs", "config", "tests", "source", "review-summary"],
  "limits": { "maxTasks": 8, "maxCandidates": 30, "maxFindings": 20 },
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
    },
    {
      "taskId": "review-summary-1",
      "kind": "review-summary",
      "assignedModel": "gpt-5.3-codex-spark/medium",
      "adapter": "codex-medium",
      "model": "gpt-5.3-codex-spark",
      "role": "spark",
      "maxFindings": 3,
      "verificationPolicy": "verify-non-low-and-sampled-low"
    }
  ],
  "candidateSchema": {
    "type": "object",
    "properties": {
      "taskId": { "type": "string" },
      "summary": { "type": "string" },
      "candidates": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "title": { "type": "string" },
            "severity": { "type": "string", "enum": ["critical", "high", "medium", "low"] },
            "path": { "type": "string" },
            "line": { "type": "integer" },
            "detail": { "type": "string" },
            "confidence": { "type": "string", "enum": ["high", "medium", "low"] }
          }
        }
      }
    }
  },
  "verdictSchema": {
    "type": "object",
    "properties": {
      "candidateId": { "type": "string" },
      "status": {
        "type": "string",
        "enum": [
          "accepted",
          "duplicate",
          "out_of_scope",
          "not_applicable",
          "insufficient_evidence",
          "speculative",
          "tool_false_positive",
          "severity_downgraded",
          "needs_human"
        ]
      },
      "reason": { "type": "string" },
      "evidenceChecked": { "type": "string" }
    }
  },
  "synthesisSchema": {
    "type": "object",
    "properties": {
      "verdict": { "type": "string" },
      "summary": { "type": "string" },
      "reportMarkdown": { "type": "string" },
      "findings": { "type": "array" }
    }
  }
}
```

The schemas and task graph above are shown abbreviated; the real dry-run emits
the full `candidateSchema`, `verdictSchema`, and `synthesisSchema`, plus one
task per changed-file group (source, tests, config, docs) followed by the
mandatory `review-summary` task.

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

If ODW completes the review but the workflow's record phase fails, the CLI
attempts one deterministic local recovery by calling Dakar's state helper
directly. A recovered result has `recorded.recoveredBy: "dakar-review"` and
`metrics.recordRecoveredByCli: true`. If recovery also fails, the result keeps
`stage: "record"` and exits non-zero so the caller knows the same commit range
may be reviewed again. The workflow result's `recordAttempts` field reports how
many of its three bounded recording attempts ran before that CLI fallback. The
fallback derives the destination from the CLI's trusted repository and state
root; it does not accept a workflow-supplied state-file path.

## Routing and limits

The first routed workflow groups changed files into `source`, `tests`,
`config`, `docs`, and `review-summary` tasks. Smaller or faster agents propose
bounded candidate findings. `gpt-5.5` high verifies candidates before final
synthesis.

The following optional limits are supported:

- `maxTasks`: maximum planned tasks, default `8`.
- `maxCandidates`: maximum candidates sent to verification, default `30`.
- `maxFindings`: maximum accepted findings in the final result, default `20`.

Example:

```bash
odw run workflows/dakar-review.js --source . --wait --timeout 900 \
  --args '{"config":"examples/df12-code-review.yaml","base":"origin/main","repoRoot":"/path/to/dakar","maxTasks":4,"maxFindings":5}'
```

## Error and skip behaviour

If a direct agent call fails during configuration resolution, range preparation,
or report synthesis, the workflow returns `ok: false` with stage `config`,
`prepare`, or `synthesize`, respectively, and includes the failure message.
If recording fails after synthesis, the returned review is still visible in
the ODW result; the CLI first attempts its one-shot local recovery (see the
record-phase recovery behaviour described above). Only if that recovery also
fails will a later run review the same commits again because the history file
was not updated.

If `origin/main` is not available, pass a different `base`. If prepare reports
that the workspace is not a git repository, pass `repoRoot` as an absolute path
to the real checkout.
