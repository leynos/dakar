# Migration guide: 0.1.0 review behaviour

Dakar 0.1.0 changes the default review effort and adds optional repository
context. Existing invocations and explicit token-limit overrides remain valid;
no operator action is required to keep running reviews. As a pre-1.0.0 change,
these defaults and optional tools require no operator configuration migration;
installation changes remain covered by the
[0.1 installation migration guide](migration-0.1.md).

## Optional context tools

When the operator's `mcp` CLI is available on `PATH`, finder prompts can use
CodeGraph for indexed code and documentation lookups. The CLI warms that index
before dispatch. For repositories with a GitHub `origin`, finder prompts can
also use DeepWiki for repository-level questions. DeepWiki is not realtime and
must not be used as evidence about the head under review.

These tools are optional. If `mcp` is missing or a warmup call fails, Dakar
warns on standard error and continues with Git and direct file inspection. To
skip CodeGraph warmup explicitly, set `DAKAR_SKIP_CONTEXT_WARMUP` in the
environment. There is no required MCP installation or configuration change.

## Reasoning defaults and token estimates

Both the Luna finder lane and Terra audit lane now default to high reasoning.
Use `--luna-reasoning medium` or `--luna-reasoning low` to select a cheaper
Luna de-escalation adapter; the Terra audit remains high reasoning.

The default output-token estimates are now 2,000 per finder pack and 5,000 for
the audit call. These estimates account for reasoning tokens being billed as
output. Existing explicit token-limit options continue to override the defaults.
