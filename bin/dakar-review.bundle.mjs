#!/usr/bin/env node
/**
 * Generated Node-loadable Dakar CLI bundle.
 *
 * Built by `npm run cli:build` from bin/dakar-review.mjs and local runtime
 * modules. Do not edit directly.
 *
 * @module
 */

// bin/dakar-review.mjs
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { deriveOdwConfig } from "../scripts/odw-config.mjs";
import { runDeterministicGates } from "../scripts/deterministic-gates.mjs";
import { parseReviewPolicy, resolveReviewConfig } from "../scripts/review-config.mjs";

// src/workflows/dakar-review/pricing.ts
var DEFAULT_PRICING_TABLE = {
  // Rates re-verified against the OpenAI pricing page on 2026-08-13: Luna
  // Flex fell to a fifth of the 2026-07-18 rates and Terra Flex by a fifth.
  version: "2026-08-13",
  // Deliberately conservative (haircut) GBP->USD conversion snapshot, chosen
  // below the prevailing spot rate so GBP budgets under-admit rather than
  // over-admit. Versioned data, revised with the rest of this table.
  usdPerGbp: 1.27,
  rates: {
    "gpt-5.6-luna:flex": {
      inputUsdPerMTok: 0.1,
      cachedInputUsdPerMTok: 0.01,
      cacheWriteUsdPerMTok: 0.125,
      outputUsdPerMTok: 0.6
    },
    "gpt-5.6-terra:flex": {
      inputUsdPerMTok: 1,
      cachedInputUsdPerMTok: 0.1,
      cacheWriteUsdPerMTok: 1.25,
      outputUsdPerMTok: 6
    },
    "gpt-5.6-luna:standard": {
      inputUsdPerMTok: 0.2,
      cachedInputUsdPerMTok: 0.02,
      cacheWriteUsdPerMTok: 0.25,
      outputUsdPerMTok: 1.2
    },
    "gpt-5.6-terra:standard": {
      inputUsdPerMTok: 2,
      cachedInputUsdPerMTok: 0.2,
      cacheWriteUsdPerMTok: 2.5,
      outputUsdPerMTok: 12
    }
  }
};

// src/workflows/dakar-review/retry.ts
function worstCaseChainSeconds(config, perCallTimeoutSeconds) {
  let total = config.flexAttempts * perCallTimeoutSeconds;
  for (let attempt = 2; attempt <= config.flexAttempts; attempt += 1) {
    const base = Math.min(config.flexInitialBackoffSeconds * 2 ** (attempt - 2), config.flexMaxBackoffSeconds);
    total += base + config.flexJitterSeconds;
  }
  return total;
}
function worstCaseReviewSeconds(config, perCallTimeoutSeconds) {
  const chain = worstCaseChainSeconds(config, perCallTimeoutSeconds);
  return chain + chain;
}

// src/workflows/dakar-review/sarif.ts
var SARIF_SCHEMA = "https://json.schemastore.org/sarif-2.1.0.json";
function sarifLevel(severity) {
  if (severity === "critical" || severity === "high") return "error";
  if (severity === "medium") return "warning";
  return "note";
}
function candidateEvidence(candidate) {
  return {
    candidateId: candidate.candidateId,
    ..."taskId" in candidate ? {
      taskId: candidate.taskId,
      taskKind: candidate.taskKind,
      sourceModel: candidate.sourceModel,
      verificationPolicy: candidate.verificationPolicy,
      title: candidate.title,
      severity: candidate.severity,
      path: candidate.path,
      line: candidate.line,
      detail: candidate.detail,
      evidence: candidate.evidence,
      confidence: candidate.confidence,
      policyRefs: [...candidate.policyRefs]
    } : {}
  };
}
function locationsFor(candidate) {
  if (!("path" in candidate) || !candidate.path) return [];
  return [{
    physicalLocation: {
      artifactLocation: { uri: candidate.path },
      region: candidate.line > 0 ? { startLine: candidate.line } : void 0
    }
  }];
}
function verdictFor(candidateId, verdicts) {
  return verdicts.find((verdict) => verdict.candidateId === candidateId);
}
function ledgerFor(candidate, ledger) {
  if (!("taskId" in candidate)) return void 0;
  return ledger.find((entry) => entry.callId === candidate.taskId);
}
function assembleSarif(input) {
  const candidates = [...input.candidates || []];
  const acceptedById = new Map(
    (input.accepted || []).map((candidate) => [candidate.candidateId, candidate])
  );
  const verdicts = [...input.verdicts || []];
  const ledger = [...input.ledger || []];
  const discardById = new Map(
    (input.discarded || []).map((item) => [item.candidate.candidateId, item])
  );
  const semanticResults = candidates.map((candidate) => {
    const accepted = acceptedById.get(candidate.candidateId);
    const discard = discardById.get(candidate.candidateId);
    const verdict = verdictFor(candidate.candidateId, verdicts);
    const sourceLedger = ledgerFor(candidate, ledger);
    const disposition = accepted ? {
      status: verdict?.status || "accepted",
      reason: verdict?.reason || "",
      evidenceChecked: verdict?.evidenceChecked || "",
      acceptedSeverity: accepted.severity
    } : {
      status: discard?.status || verdict?.status || "not_selected",
      reason: discard?.reason || verdict?.reason || "",
      evidenceChecked: discard?.evidenceChecked || verdict?.evidenceChecked || ""
    };
    return {
      ruleId: `dakar/semantic/${candidate.candidateId}`,
      level: sarifLevel(accepted?.severity || candidate.severity),
      message: { text: candidate.title },
      locations: locationsFor(candidate),
      fingerprints: {
        "dakar/candidateId": candidate.candidateId,
        "dakar/semanticFingerprint": candidate.candidateId.slice(candidate.taskId.length + 1)
      },
      ...accepted ? {} : { suppressions: [{ kind: "external", status: "accepted", justification: disposition.reason }] },
      properties: {
        dakar: {
          kind: "semantic",
          candidate: candidateEvidence(candidate),
          provenance: {
            taskId: candidate.taskId,
            taskKind: candidate.taskKind,
            model: candidate.sourceModel,
            lane: sourceLedger?.lane || "luna-flex",
            serviceTier: sourceLedger?.serviceTier || "flex",
            reasoningEffort: sourceLedger?.reasoningEffort
          },
          audit: verdict ? { ...verdict } : null,
          disposition,
          clusterId: verdict?.clusterId,
          cost: sourceLedger ? { ...sourceLedger } : null,
          pricingTableVersion: input.pricingTableVersion
        }
      }
    };
  }).sort((left, right) => {
    const leftId = left.fingerprints["dakar/candidateId"];
    const rightId = right.fingerprints["dakar/candidateId"];
    return leftId === rightId ? 0 : leftId < rightId ? -1 : 1;
  });
  const knownCandidateIds = new Set(candidates.map((candidate) => candidate.candidateId));
  const extraDiscards = (input.discarded || []).filter((item) => !knownCandidateIds.has(item.candidate.candidateId || "")).map((item) => ({
    ruleId: `dakar/semantic/${item.candidate.candidateId || "unknown"}`,
    level: "note",
    message: { text: item.reason },
    locations: locationsFor(item.candidate),
    fingerprints: { "dakar/candidateId": item.candidate.candidateId || "unknown" },
    suppressions: [{ kind: "external", status: "accepted", justification: item.reason }],
    properties: {
      dakar: {
        kind: "semantic",
        candidate: candidateEvidence(item.candidate),
        provenance: null,
        audit: verdictFor(item.candidate.candidateId, verdicts) || null,
        disposition: { status: item.status, reason: item.reason, evidenceChecked: item.evidenceChecked },
        cost: null,
        pricingTableVersion: input.pricingTableVersion
      }
    }
  }));
  const gateResults = (input.gates || []).filter((gate) => gate.status !== "passed").map((gate) => ({
    ruleId: `dakar/gate/${gate.gateId}`,
    level: gate.blocking ? "error" : "warning",
    message: { text: `${gate.name} ${gate.status}: ${gate.command}` },
    fingerprints: { "dakar/gateId": gate.gateId },
    properties: {
      dakar: {
        kind: "deterministic-gate",
        gate: { ...gate },
        disposition: { status: gate.blocking ? "blocking" : "non-blocking" },
        pricingTableVersion: input.pricingTableVersion
      }
    }
  }));
  const results = [...gateResults, ...semanticResults, ...extraDiscards];
  const ruleIds = [...new Set(results.map((result) => result.ruleId))].sort();
  const gates = (input.gates || []).map((gate) => ({ ...gate }));
  return {
    $schema: SARIF_SCHEMA,
    version: "2.1.0",
    runs: [{
      tool: {
        driver: {
          name: "Dakar",
          version: "0.1.0",
          rules: ruleIds.map((id) => ({ id, name: id }))
        }
      },
      invocations: [{
        executionSuccessful: gates.every((gate) => gate.status === "passed" || !gate.blocking),
        properties: { dakar: { gates } }
      }],
      results,
      properties: {
        dakar: {
          pricingTableVersion: input.pricingTableVersion,
          ledger: ledger.map((entry) => ({ ...entry })),
          auditVerdicts: verdicts.map((verdict) => ({ ...verdict }))
        }
      }
    }]
  };
}
function dakarProperties(result) {
  const properties = result.properties;
  if (!properties || typeof properties !== "object") return {};
  const dakar = properties.dakar;
  return dakar && typeof dakar === "object" ? dakar : {};
}
function projectFindingsFromSarif(sarif) {
  const [run2] = sarif.runs;
  if (!run2) return [];
  return run2.results.flatMap((result) => {
    const dakar = dakarProperties(result);
    if (dakar.kind !== "semantic") return [];
    const disposition = dakar.disposition;
    if (!["accepted", "severity_downgraded"].includes(String(disposition?.status))) return [];
    const candidate = dakar.candidate;
    const audit = dakar.audit;
    return [{
      severity: disposition.acceptedSeverity || candidate.severity,
      path: candidate.path,
      line: Number(candidate.line) > 0 ? candidate.line : void 0,
      title: candidate.title,
      detail: candidate.detail || "",
      evidence: candidate.evidence || "",
      clusterId: audit?.clusterId || void 0,
      sourceTasks: [candidate.taskId]
    }];
  });
}
function projectDiscardedFromSarif(sarif) {
  const [run2] = sarif.runs;
  if (!run2) return [];
  return run2.results.flatMap((result) => {
    const dakar = dakarProperties(result);
    if (dakar.kind !== "semantic") return [];
    const disposition = dakar.disposition;
    if (["accepted", "severity_downgraded"].includes(String(disposition?.status))) return [];
    return [{
      candidate: dakar.candidate,
      status: String(disposition?.status || ""),
      reason: String(disposition?.reason || ""),
      evidenceChecked: String(disposition?.evidenceChecked || "")
    }];
  });
}
function renderSarifMarkdown(sarif) {
  const findings = projectFindingsFromSarif(sarif);
  const [run2] = sarif.runs;
  const gateFailures = (run2?.results || []).filter((result) => dakarProperties(result).kind === "deterministic-gate");
  const blockingGateFailures = gateFailures.filter((result) => {
    const disposition = dakarProperties(result).disposition;
    return disposition && typeof disposition === "object" && disposition.status === "blocking";
  });
  const summary = blockingGateFailures.length > 0 ? `${blockingGateFailures.length} blocking deterministic gate failure${blockingGateFailures.length === 1 ? "" : "s"} require remediation.` : findings.length === 0 ? "No blocking findings were accepted." : `${findings.length} confirmed finding${findings.length === 1 ? "" : "s"} require changes.`;
  return [
    "# Dakar review",
    "",
    summary,
    ...gateFailures.flatMap((result) => ["", `## deterministic gate: ${String(result.message.text)}`]),
    ...findings.flatMap((finding) => [
      "",
      `## ${finding.severity}: ${finding.title}`,
      "",
      `${finding.path}${finding.line ? `:${finding.line}` : ""}`,
      "",
      String(finding.detail),
      "",
      `Evidence: ${finding.evidence}`
    ])
  ].join("\n");
}

// bin/dakar-review.mjs
import { appendReview, prepare } from "../scripts/review-state.mjs";
var DEFAULT_PER_CALL_TIMEOUT_SECONDS = 300;
var CONTEXT_WARMUP_TIMEOUT_MILLISECONDS = 3e4;
var MAX_MARKDOWN_WARMUP_ATTEMPTS = 20;
function clampPerCallTimeout(value = DEFAULT_PER_CALL_TIMEOUT_SECONDS) {
  const floored = Math.floor(Number(value));
  return Number.isFinite(floored) && floored >= 30 ? Math.min(floored, 900) : DEFAULT_PER_CALL_TIMEOUT_SECONDS;
}
function clampLikeConfig(value, fallback, min, max) {
  const floored = Math.floor(Number(value));
  return Number.isFinite(floored) && floored >= min ? Math.min(floored, max) : fallback;
}
var packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
var workflowPath = join(packageRoot, "workflows", "dakar-review.js");
var odwConfigPath = join(packageRoot, "odw.config.json");
var piAgentDir = join(packageRoot, "adapters", "pi");
function writeDerivedOdwConfig(perCallTimeoutSeconds = DEFAULT_PER_CALL_TIMEOUT_SECONDS) {
  const baseConfig = JSON.parse(readFileSync(odwConfigPath, "utf8"));
  const derived = deriveOdwConfig(baseConfig, perCallTimeoutSeconds);
  const path = join(tmpdir(), `dakar-odw-config-${process.pid}-${Date.now()}.json`);
  writeFileSync(path, JSON.stringify(derived, null, 2));
  return path;
}
function odwEnv(usageLogPath = usageLogFile) {
  const env = { ...process.env, PI_CODING_AGENT_DIR: piAgentDir, PI_SKIP_VERSION_CHECK: "1" };
  if (usageLogPath) env.DAKAR_USAGE_LOG = usageLogPath;
  return env;
}
var usageLogFile = join(tmpdir(), `dakar-usage-${process.pid}-${Date.now()}.jsonl`);
function attachReportedUsage(output) {
  let raw;
  try {
    raw = readFileSync(usageLogFile, "utf8");
  } catch {
    return output;
  }
  try {
    rmSync(usageLogFile, { force: true });
  } catch {
  }
  const lines = raw.split("\n").filter((line) => line.trim() !== "").flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
  if (lines.length === 0 || typeof output !== "object" || output === null) return output;
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const line of lines) {
    for (const key of Object.keys(totals)) {
      totals[key] += Number(line.usage?.[key]) || 0;
    }
  }
  output.metrics = output.metrics || {};
  output.metrics.reportedUsage = lines;
  output.metrics.reportedTokens = totals;
  const sarifDakar = output.sarif?.runs?.[0]?.properties?.dakar;
  if (sarifDakar && typeof sarifDakar === "object") {
    sarifDakar.reportedUsage = lines;
    sarifDakar.reportedTokens = totals;
  }
  return output;
}
var OPTION_SPECS = /* @__PURE__ */ new Map([
  ["repo-root", { key: "repoRoot", value: true }],
  ["config", { key: "config", value: true }],
  ["base", { key: "base", value: true }],
  ["head", { key: "head", value: true }],
  ["state-root", { key: "stateRoot", value: true }],
  ["max-tasks", { key: "maxTasks", value: true, number: true }],
  ["max-candidates", { key: "maxCandidates", value: true, number: true }],
  ["max-findings", { key: "maxFindings", value: true, number: true }],
  ["synthesis-model", { key: "synthesisModel", value: true }],
  ["synthesis-reasoning", { key: "synthesisReasoning", value: true }],
  // Review-tuning knobs (ADR 002 admission and retry envelope). The CLI only
  // forwards these to their WorkflowArgs keys; resolveWorkflowConfig owns the
  // bounds, so no validation is duplicated here beyond the numeric parse.
  ["budget-gbp", { key: "budgetGbp", value: true, number: true }],
  ["max-luna-calls", { key: "maxLunaFlexCalls", value: true, number: true }],
  ["transaction-max-files", { key: "transactionMaxFiles", value: true, number: true }],
  ["transaction-max-input-tokens", { key: "transactionMaxInputTokens", value: true, number: true }],
  ["transaction-max-output-tokens", { key: "transactionMaxOutputTokens", value: true, number: true }],
  ["terra-max-input-tokens", { key: "terraMaxInputTokens", value: true, number: true }],
  ["terra-max-output-tokens", { key: "terraMaxOutputTokens", value: true, number: true }],
  ["adapter-overhead-tokens", { key: "adapterOverheadTokens", value: true, number: true }],
  ["max-audit-candidates", { key: "maxAuditCandidates", value: true, number: true }],
  ["luna-reasoning", { key: "lunaReasoning", value: true }],
  ["routing-policy", { key: "routingPolicy", value: true }],
  ["flex-attempts", { key: "flexAttempts", value: true, number: true }],
  ["per-call-timeout", { key: "perCallTimeoutSeconds", value: true, number: true }],
  ["timeout", { key: "timeout", value: true, number: true }],
  ["runs-root", { key: "runsRoot", value: true }],
  ["format", { key: "format", value: true }],
  ["odw-bin", { key: "odwBin", value: true }],
  ["telemetry", { key: "telemetry", value: false }],
  ["dry-run", { key: "dryRun", value: false }],
  ["help", { key: "help", value: false }],
  ["version", { key: "version", value: false }]
]);
function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      throw new Error(`unexpected positional argument: ${token}`);
    }
    const [name, inlineValue] = token.slice(2).split(/=(.*)/su, 2);
    const spec = OPTION_SPECS.get(name);
    if (!spec) {
      throw new Error(`unknown option: --${name}`);
    }
    if (!spec.value) {
      if (inlineValue !== void 0) {
        throw new Error(`--${name} does not take a value`);
      }
      parsed[spec.key] = true;
      continue;
    }
    const value = inlineValue ?? argv[++index];
    if (value === void 0 || value.startsWith("--")) {
      throw new Error(`--${name} requires a value`);
    }
    parsed[spec.key] = spec.number ? numberValue(name, value) : value;
  }
  return parsed;
}
function numberValue(name, value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`--${name} must be a number`);
  }
  return number;
}
function extractJson(text) {
  const start = text.indexOf("{");
  if (start === -1) {
    throw new Error("ODW output did not contain a JSON object");
  }
  return JSON.parse(text.slice(start));
}
function extractRunId(text) {
  const match = text.match(/\b\d{8}-\d{6}-[0-9a-f]+\b/u);
  if (!match) {
    throw new Error("ODW output did not contain a run id");
  }
  return match[0];
}
function readAgentInstructions(repoRoot, baseRef) {
  const revision = spawnSync("git", ["-C", repoRoot, "rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (revision.error) throw revision.error;
  if (revision.status !== 0) {
    throw new Error(`cannot resolve trusted review base ${baseRef}: ${revision.stderr.trim() || "git rev-parse failed"}`);
  }
  const resolvedCommit = revision.stdout.trim();
  const exists = spawnSync("git", ["-C", repoRoot, "ls-tree", "-z", resolvedCommit, "--", "AGENTS.md"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (exists.error) throw exists.error;
  if (exists.status !== 0) {
    throw new Error(`cannot inspect ${resolvedCommit}:AGENTS.md: ${exists.stderr.trim() || "git ls-tree failed"}`);
  }
  if (exists.stdout === "") return null;
  const result = spawnSync("git", ["-C", repoRoot, "show", `${resolvedCommit}:AGENTS.md`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`cannot read ${resolvedCommit}:AGENTS.md: ${result.stderr.trim() || "git show failed"}`);
  }
  const content = result.stdout;
  return {
    source: `${resolvedCommit}:AGENTS.md`,
    content: content.slice(0, 24e3),
    truncated: content.length > 24e3
  };
}
function deriveRepoSlug(repoRoot) {
  const result = spawnSync("git", ["-C", repoRoot, "config", "--get", "remote.origin.url"], {
    encoding: "utf8",
    timeout: 1e4
  });
  if (result.error) return { kind: "error", operation: "reading the origin URL" };
  if (result.status === 1) return { kind: "unavailable" };
  if (result.status !== 0) return { kind: "error", operation: "reading the origin URL" };
  const match = /github\.com[/:]([^/]+)\/([^/\s]+?)(?:\.git)?$/u.exec((result.stdout || "").trim());
  return match ? { kind: "slug", value: `${match[1]}/${match[2]}` } : { kind: "unavailable" };
}
function addRepoSlug(workflowArgs, repoRoot) {
  const result = deriveRepoSlug(repoRoot);
  if (result.kind === "slug") {
    workflowArgs.repoSlug = result.value;
  } else if (result.kind === "error") {
    process.stderr.write(`dakar-review: Git failed while ${result.operation}; DeepWiki context is unavailable.
`);
  }
}
function isMcpCliAvailable(timeout) {
  if (timeout === null) return false;
  const probe = spawnSync("mcp", ["--list"], { encoding: "utf8", timeout });
  return !probe.error && probe.status === 0;
}
function warmupTimeout(deadline, requestedTimeout) {
  const remaining = deadline - Date.now();
  return remaining > 0 ? Math.min(requestedTimeout, remaining) : null;
}
function warmContextTool(tool, payload, timeout, deadline) {
  const boundedTimeout = warmupTimeout(deadline, timeout);
  if (boundedTimeout === null) return false;
  const result = spawnSync("mcp", ["codegraph", tool, JSON.stringify(payload)], {
    encoding: "utf8",
    timeout: boundedTimeout
  });
  if (result.error || result.status !== 0) {
    process.stderr.write(`dakar-review: CodeGraph warmup call ${tool} failed; continuing without it.
`);
    return false;
  }
  return true;
}
function warmMarkdownContext(repoRoot, changedFiles, deadline) {
  const candidates = ["AGENTS.md", "README.md"].concat((changedFiles || []).filter((path) => path.endsWith(".md")));
  const seen = /* @__PURE__ */ new Set();
  let attempts = 0;
  let indexed = 0;
  for (const relPath of candidates) {
    if (attempts >= MAX_MARKDOWN_WARMUP_ATTEMPTS || warmupTimeout(deadline, 1) === null) break;
    const absolute = join(repoRoot, relPath);
    if (seen.has(absolute) || !existsSync(absolute)) continue;
    seen.add(absolute);
    attempts += 1;
    if (warmContextTool("codegraph_index_markdown", { path: absolute }, 12e4, deadline)) indexed += 1;
  }
  return indexed;
}
function warmContextIndex(repoRoot, changedFiles) {
  if (process.env.DAKAR_SKIP_CONTEXT_WARMUP) {
    process.stderr.write("dakar-review: CodeGraph warmup skipped (DAKAR_SKIP_CONTEXT_WARMUP is set).\n");
    return;
  }
  const deadline = Date.now() + CONTEXT_WARMUP_TIMEOUT_MILLISECONDS;
  if (!isMcpCliAvailable(warmupTimeout(deadline, CONTEXT_WARMUP_TIMEOUT_MILLISECONDS))) {
    process.stderr.write("dakar-review: mcp CLI unavailable; skipping CodeGraph warmup.\n");
    return;
  }
  process.stderr.write("dakar-review: warming CodeGraph index for the reviewed checkout.\n");
  warmContextTool("codegraph_index_directory", { path: repoRoot }, 6e5, deadline);
  const indexed = warmMarkdownContext(repoRoot, changedFiles, deadline);
  process.stderr.write(`dakar-review: CodeGraph warmup complete (${indexed} markdown file(s) indexed).
`);
}
function isCheckedOutReviewHead(repoRoot, headCommit) {
  const head = spawnSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" });
  if (head.error || head.status !== 0) return { kind: "error", operation: "reading HEAD" };
  if (head.stdout.trim() !== headCommit) return { kind: "different-head" };
  const status = spawnSync("git", ["-C", repoRoot, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" });
  if (status.error || status.status !== 0) return { kind: "error", operation: "checking worktree status" };
  return status.stdout === "" ? { kind: "clean" } : { kind: "dirty" };
}
function buildWorkflowArgs(options, repoRoot) {
  const resolvedConfig = resolveReviewConfig({ repoRoot, config: options.config, packageRoot });
  if (resolvedConfig.ok === false) {
    throw new Error(resolvedConfig.error || `could not resolve review config: ${resolvedConfig.config}`);
  }
  const agentInstructions = readAgentInstructions(repoRoot, options.base || "origin/main");
  const workflowArgs = {
    config: resolvedConfig.config,
    policy: resolvedConfig.policy,
    repoRoot
  };
  addRepoSlug(workflowArgs, repoRoot);
  if (agentInstructions) {
    workflowArgs.agentInstructions = agentInstructions;
  }
  for (const [optionKey, workflowKey] of [
    ["base", "base"],
    ["head", "head"],
    ["stateRoot", "stateRoot"],
    ["maxTasks", "maxTasks"],
    ["maxCandidates", "maxCandidates"],
    ["maxFindings", "maxFindings"],
    ["synthesisModel", "synthesisModel"],
    ["synthesisReasoning", "synthesisReasoning"],
    ["budgetGbp", "budgetGbp"],
    ["maxLunaFlexCalls", "maxLunaFlexCalls"],
    ["transactionMaxFiles", "transactionMaxFiles"],
    ["transactionMaxInputTokens", "transactionMaxInputTokens"],
    ["transactionMaxOutputTokens", "transactionMaxOutputTokens"],
    ["terraMaxInputTokens", "terraMaxInputTokens"],
    ["terraMaxOutputTokens", "terraMaxOutputTokens"],
    ["adapterOverheadTokens", "adapterOverheadTokens"],
    ["maxAuditCandidates", "maxAuditCandidates"],
    ["lunaReasoning", "lunaReasoning"],
    ["routingPolicy", "routingPolicy"],
    ["flexAttempts", "flexAttempts"],
    ["perCallTimeoutSeconds", "perCallTimeoutSeconds"]
  ]) {
    if (options[optionKey] !== void 0) {
      workflowArgs[workflowKey] = options[optionKey];
    }
  }
  if (options.dryRun) {
    workflowArgs.dryRun = true;
  }
  return workflowArgs;
}
function buildOdwRunArgs(options, workflowArgs, wait) {
  const odwArgs = [
    "run",
    workflowPath,
    "--source",
    packageRoot,
    "--config",
    // The CLI's own spawns use a run-local config that bounds the pi Flex calls
    // with the per-call timeout; it falls back to the packaged path only if the
    // derivation was skipped.
    options.odwConfigPath || odwConfigPath
  ];
  if (wait) {
    odwArgs.push("--wait", "--timeout", String(options.timeout || 3600));
  }
  odwArgs.push("--args", JSON.stringify(workflowArgs));
  if (options.runsRoot) {
    odwArgs.splice(2, 0, "--runs-root", resolve(options.runsRoot));
  }
  return odwArgs;
}
function buildRunScopedArgs(command, options, runId, extraArgs = []) {
  const args = [command, runId];
  if (options.runsRoot) {
    args.push("--runs-root", resolve(options.runsRoot));
  }
  args.push(...extraArgs);
  return args;
}
function printWorkflowOutput(output, format) {
  if (format === "markdown") {
    process.stdout.write(`${output.reportMarkdown || JSON.stringify(output, null, 2)}
`);
  } else {
    process.stdout.write(`${JSON.stringify(output, null, 2)}
`);
  }
}
function changedFilesEqual(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}
function snapshotMismatch(recordInput, prepared) {
  if (!prepared || typeof prepared !== "object") return null;
  const scalarChecks = [
    ["headCommit", recordInput.headCommit, prepared.headCommit],
    ["baseCommit", recordInput.baseCommit, prepared.reviewBase],
    ["commitCount", recordInput.commitCount, prepared.commitCount]
  ];
  for (const [field, actual, expected] of scalarChecks) {
    if (actual !== expected) {
      return `recordInput.${field} (${JSON.stringify(actual)}) does not match the prepared review snapshot (${JSON.stringify(expected)}); refusing to record`;
    }
  }
  if (!changedFilesEqual(recordInput.changedFiles, prepared.changedFiles)) {
    return "recordInput.changedFiles does not match the prepared review snapshot; refusing to record";
  }
  return null;
}
function recordReview(output, trustedLocation, prepared) {
  if (!output || output.dryRun || output.skipped || output.ok !== true) {
    return output;
  }
  if (output.recordWithheld && !output.recordInput) {
    return output;
  }
  if (!output.recordInput) {
    const error = "workflow result lacked recordInput; refusing to treat an unrecorded review as complete";
    output.ok = false;
    output.stage = "record";
    output.error = error;
    output.recorded = { ok: false, error, recordedBy: "dakar-review" };
    return output;
  }
  const mismatch = snapshotMismatch(output.recordInput, prepared);
  if (mismatch) {
    output.ok = false;
    output.stage = "record";
    output.error = mismatch;
    output.recorded = { ok: false, error: mismatch, recordedBy: "dakar-review" };
    return output;
  }
  try {
    const recorded = appendReview(output.recordInput, trustedLocation);
    output.recorded = {
      ok: true,
      stateFile: recorded.stateFile,
      headCommit: recorded.headCommit,
      recordedBy: "dakar-review"
    };
    output.stateFile = recorded.stateFile;
  } catch (error) {
    output.ok = false;
    output.stage = "record";
    output.error = error.message;
    output.recorded = { ok: false, error: error.message, recordedBy: "dakar-review" };
  }
  return output;
}
function finalizeWorkflowResult(output, workflowArgs) {
  attachReportedUsage(output);
  if (workflowArgs.dryRun) return output;
  if (output && typeof output === "object" && output.recordInput) {
    const metrics = output.recordInput.metrics = output.recordInput.metrics || {};
    if (output.metrics?.reportedUsage !== void 0) metrics.reportedUsage = output.metrics.reportedUsage;
    if (output.metrics?.reportedTokens !== void 0) metrics.reportedTokens = output.metrics.reportedTokens;
  }
  return recordReview(
    output,
    { "repo-root": workflowArgs.repoRoot, "state-root": workflowArgs.stateRoot },
    workflowArgs.prepared
  );
}
function runOdwQuiet(options, workflowArgs) {
  const result = spawnSync(options.odwBin || "odw", buildOdwRunArgs(options, workflowArgs, true), {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: odwEnv()
  });
  if (result.status !== 0) {
    const error = {
      ok: false,
      stage: "odw",
      status: result.status,
      error: result.stderr.trim() || result.stdout.trim() || "ODW failed"
    };
    process.stderr.write(`${JSON.stringify(error, null, 2)}
`);
    return { status: result.status || 1 };
  }
  return { output: finalizeWorkflowResult(extractJson(result.stdout), workflowArgs) };
}
function followOdwLogs(odwBin, args, timeoutMs) {
  return new Promise((resolvePromise) => {
    const child = spawn(odwBin, args, { stdio: ["ignore", "pipe", "pipe"], env: odwEnv() });
    let timedOut = false;
    const timer = globalThis.setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => process.stderr.write(chunk));
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.on("error", (error) => {
      globalThis.clearTimeout(timer);
      process.stderr.write(`dakar-review: failed to follow ODW logs: ${error.message}
`);
      resolvePromise(1);
    });
    child.on("close", (code) => {
      globalThis.clearTimeout(timer);
      resolvePromise(timedOut ? 124 : code || 0);
    });
  });
}
async function waitForOdwResult(options, workflowArgs, runId, timeoutMs = (options.timeout || 3600) * 1e3) {
  const odwBin = options.odwBin || "odw";
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (true) {
    const result = spawnSync(odwBin, buildRunScopedArgs("result", options, runId), {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: odwEnv()
    });
    if (result.status === 0) {
      return finalizeWorkflowResult(extractJson(result.stdout), workflowArgs);
    }
    lastError = result.stderr.trim() || result.stdout.trim();
    if (Date.now() >= deadline) {
      break;
    }
    await sleep(Math.min(1e3, Math.max(0, deadline - Date.now())));
  }
  throw new Error(lastError || `timed out waiting for ODW run ${runId} after ${options.timeout || 3600}s`);
}
async function runOdwWithTelemetry(options, workflowArgs) {
  const odwBin = options.odwBin || "odw";
  const result = spawnSync(odwBin, buildOdwRunArgs(options, workflowArgs, false), {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: odwEnv()
  });
  if (result.status !== 0) {
    const error = {
      ok: false,
      stage: "odw",
      status: result.status,
      error: result.stderr.trim() || result.stdout.trim() || "ODW failed"
    };
    process.stderr.write(`${JSON.stringify(error, null, 2)}
`);
    return { status: result.status || 1 };
  }
  if (result.stderr.trim()) {
    process.stderr.write(`${result.stderr.trim()}
`);
  }
  const runId = extractRunId(result.stdout);
  const timeoutMs = (options.timeout || 3600) * 1e3;
  const resultDeadline = Date.now() + timeoutMs;
  process.stderr.write(`dakar-review: following ODW run ${runId}
`);
  const logStatus = await followOdwLogs(odwBin, buildRunScopedArgs("logs", options, runId, ["--follow"]), timeoutMs);
  if (logStatus === 124) {
    process.stderr.write(
      `dakar-review: log follow timed out after ${options.timeout || 3600}s; attempting one result fetch
`
    );
    try {
      return { output: await waitForOdwResult(options, workflowArgs, runId, 5e3) };
    } catch (error) {
      process.stderr.write(
        `${JSON.stringify(
          {
            ok: false,
            stage: "odw-logs",
            runId,
            error: error.message || `timed out following ODW run after ${options.timeout || 3600}s and no result was available`
          },
          null,
          2
        )}
`
      );
      return { status: 1 };
    }
  }
  if (logStatus !== 0) {
    process.stderr.write(`dakar-review: ODW log stream exited with status ${logStatus}; fetching result anyway
`);
  }
  try {
    return { output: await waitForOdwResult(options, workflowArgs, runId, Math.max(0, resultDeadline - Date.now())) };
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ ok: false, stage: "odw-result", runId, error: error.message }, null, 2)}
`
    );
    return { status: 1 };
  }
}
function usage() {
  return `Usage: dakar-review [options]

Run Dakar's routed review workflow and print the workflow result.

Options:
  --repo-root <path>          Git checkout to review (default: cwd)
  --config <path>             CodeRabbit YAML path, relative to repo root
  --base <ref>                Base ref for first review (default: origin/main)
  --head <ref>                Head ref to review (default: HEAD)
  --state-root <path>         Isolated review-history root
  --max-tasks <n>             Maximum planned review tasks
  --max-candidates <n>        Maximum candidates sent to verification
  --max-findings <n>          Maximum accepted findings
  --synthesis-model <model>   Synthesis model (default: gpt-5.5)
  --synthesis-reasoning <r>   Synthesis reasoning: low, medium, or high
  --timeout <seconds>         ODW wait timeout (default: 3600)
  --runs-root <path>          ODW runs directory
  --format <json|markdown>    Output format (default: json)
  --odw-bin <path>            ODW executable (default: odw)
  --telemetry                 Stream ODW logs to stderr while preserving final stdout
  --dry-run                   Return workflow contract without agents
  --help                      Show this help

Review tuning (bounds enforced by the workflow; the CLI only forwards):
  --budget-gbp <n>                   Hard admission budget in GBP (default: 0.15)
  --max-luna-calls <n>               Maximum Luna Flex finder calls (default: 4)
  --transaction-max-files <n>        Maximum files per finder pack (default: 5)
  --transaction-max-input-tokens <n> Finder input-token estimate (default: 12000)
  --transaction-max-output-tokens <n> Finder output-token estimate (default: 2000)
  --terra-max-input-tokens <n>       Audit input-token estimate (default: 48000)
  --terra-max-output-tokens <n>      Audit output-token estimate (default: 5000)
  --adapter-overhead-tokens <n>      Per-call adapter overhead tokens (default: 13000)
  --max-audit-candidates <n>         Maximum candidates sent to the audit (default: 30)
  --luna-reasoning <low|medium|high> Luna finder reasoning effort (default: high)
  --routing-policy <policy>          Routing policy (default: deterministic-flex-v1)
  --flex-attempts <n>                Flex retry attempts per call (default: 3)
  --per-call-timeout <seconds>       Per-model-call timeout (default: 300)
`;
}
function prepareReview(options, repoRoot, resolvedConfig) {
  const prepareArgs = {
    "repo-root": repoRoot,
    base: options.base || "origin/main",
    head: options.head || "HEAD"
  };
  if (options.stateRoot) {
    prepareArgs["state-root"] = options.stateRoot;
  }
  let prepared;
  try {
    prepared = prepare(prepareArgs);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, stage: "prepare", error: error.message }, null, 2)}
`);
    return { status: 1 };
  }
  if (prepared.alreadyReviewed || prepared.commitCount === 0) {
    return {
      skip: {
        ok: true,
        skipped: true,
        reason: "No unreviewed commits remain for this branch.",
        config: resolvedConfig,
        stateFile: prepared.stateFile,
        headCommit: prepared.headCommit
      }
    };
  }
  return { prepared };
}
function blockingGateResult(gates, config, prepared) {
  const blocking = gates.filter((gate) => gate.blocking && gate.status !== "passed");
  const sarif = assembleSarif({ gates, pricingTableVersion: DEFAULT_PRICING_TABLE.version });
  return {
    ok: false,
    stage: "deterministic-gates",
    error: `${blocking.length} blocking deterministic gate${blocking.length === 1 ? "" : "s"} failed`,
    config,
    reviewBase: prepared.reviewBase,
    headCommit: prepared.headCommit,
    commitCount: prepared.commitCount,
    changedFiles: prepared.changedFiles,
    sarif,
    findings: projectFindingsFromSarif(sarif),
    discarded: projectDiscardedFromSarif(sarif),
    reportMarkdown: renderSarifMarkdown(sarif),
    metrics: {
      routingPolicy: "deterministic-flex-v1",
      ledger: [],
      ledgerTotalEstimatedUsd: 0,
      spentUsd: 0,
      reservedAuditUsd: 0,
      pricingTableVersion: DEFAULT_PRICING_TABLE.version,
      deterministicGateCount: gates.length,
      blockingGateFailureCount: blocking.length
    }
  };
}
function readTrustedGateConfig(configPath, repoRoot, reviewBase) {
  const relativePath = relative(repoRoot, configPath);
  if (!isAbsolute(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    const revisionPath = relativePath.replaceAll("\\", "/");
    const revision = `${reviewBase}:${revisionPath}`;
    const result = spawnSync("git", ["-C", repoRoot, "show", revision], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    if (result.error) throw new Error(`cannot read trusted review configuration ${revision}: ${result.error.message}`);
    if (result.status !== 0) {
      const detail = result.stderr.trim() || `git show exited with status ${result.status ?? "unknown"}`;
      throw new Error(`cannot read trusted review configuration ${revision}: ${detail}`);
    }
    return result.stdout;
  }
  return readFileSync(configPath, "utf8");
}
function prepareLiveReview(options, repoRoot, workflowArgs, format) {
  const preparation = prepareReview(options, repoRoot, workflowArgs.config);
  if (preparation.status !== void 0) return preparation.status;
  if (preparation.skip) {
    printWorkflowOutput(preparation.skip, format);
    return 0;
  }
  workflowArgs.prepared = preparation.prepared;
  const gateConfig = readTrustedGateConfig(workflowArgs.config, repoRoot, workflowArgs.prepared.reviewBase);
  const trustedPolicy = parseReviewPolicy(gateConfig, {
    configPath: `${workflowArgs.config} (trusted review base ${workflowArgs.prepared.reviewBase})`
  });
  workflowArgs.policy = trustedPolicy;
  const deterministicGates = runDeterministicGates(trustedPolicy, repoRoot);
  workflowArgs.prepared.deterministicGates = deterministicGates;
  if (deterministicGates.some((gate) => gate.blocking && gate.status !== "passed")) {
    printWorkflowOutput(blockingGateResult(deterministicGates, workflowArgs.config, workflowArgs.prepared), format);
    return 1;
  }
  if (!process.env.OPENAI_API_KEY) {
    process.stderr.write("dakar-review: OPENAI_API_KEY is not set; the pi Flex adapters will fail to authenticate.\n");
  }
  if (process.env.DAKAR_SKIP_CONTEXT_WARMUP) {
    warmContextIndex(repoRoot, workflowArgs.prepared.changedFiles || []);
  } else {
    const checkout = isCheckedOutReviewHead(repoRoot, workflowArgs.prepared.headCommit);
    if (checkout.kind === "clean") {
      warmContextIndex(repoRoot, workflowArgs.prepared.changedFiles || []);
    } else if (checkout.kind === "error") {
      process.stderr.write(`dakar-review: could not verify the reviewed checkout while ${checkout.operation}; skipping CodeGraph warmup.
`);
    } else {
      process.stderr.write("dakar-review: reviewed head is not checked out cleanly; skipping CodeGraph warmup.\n");
    }
  }
  const worstCase = worstCaseReviewSeconds(
    {
      flexAttempts: clampLikeConfig(options.flexAttempts, 3, 1, 6),
      flexInitialBackoffSeconds: clampLikeConfig(options.flexInitialBackoffSeconds, 30, 1, 300),
      flexMaxBackoffSeconds: clampLikeConfig(options.flexMaxBackoffSeconds, 120, 1, 900),
      flexJitterSeconds: clampLikeConfig(options.flexJitterSeconds, 10, 0, 60)
    },
    clampPerCallTimeout(options.perCallTimeoutSeconds)
  );
  if ((options.timeout || 3600) < worstCase) {
    process.stderr.write(
      `dakar-review: --timeout ${options.timeout || 3600}s is below the retry schedule's worst case (${worstCase}s); the run may be killed before the workflow can defer.
`
    );
  }
  return null;
}
function metaOptionExitCode(options) {
  if (options.help) {
    process.stdout.write(usage());
    return 0;
  }
  if (options.version) {
    process.stdout.write("0.1.0\n");
    return 0;
  }
  return null;
}
function outputFormat(options) {
  const format = options.format || "json";
  if (!["json", "markdown"].includes(format)) throw new Error("--format must be json or markdown");
  return format;
}
async function launchOdw(options, workflowArgs, format) {
  options.odwConfigPath = writeDerivedOdwConfig(clampPerCallTimeout(options.perCallTimeoutSeconds));
  let outcome;
  try {
    outcome = options.telemetry ? await runOdwWithTelemetry(options, workflowArgs) : runOdwQuiet(options, workflowArgs);
  } finally {
    try {
      rmSync(options.odwConfigPath, { force: true });
    } catch {
    }
  }
  if (outcome.status !== void 0) return outcome.status;
  const output = outcome.output;
  printWorkflowOutput(output, format);
  return output.ok === false ? 1 : 0;
}
async function run(argv) {
  const options = parseArgs(argv);
  const metaExitCode = metaOptionExitCode(options);
  if (metaExitCode !== null) return metaExitCode;
  const repoRoot = resolve(options.repoRoot || process.cwd());
  const format = outputFormat(options);
  const workflowArgs = buildWorkflowArgs(options, repoRoot);
  if (!options.dryRun) {
    const preflightStatus = prepareLiveReview(options, repoRoot, workflowArgs, format);
    if (preflightStatus !== null) return preflightStatus;
  }
  return launchOdw(options, workflowArgs, format);
}
try {
  process.exitCode = await run(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, stage: "cli", error: error.message }, null, 2)}
`);
  process.exitCode = 1;
}
