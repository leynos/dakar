# Architectural decision record (ADR) 003: Add Oxlint application rules

## Status

Accepted.

## Date

2026-10-26.

## Context and problem statement

Dakar already uses pinned Biome for its cognitive-complexity gate, but it has
no consistent application-wide rules for JavaScript and TypeScript correctness
and maintainability. The project wants the native Oxlint Unicorn recommended
profile and the `deslop` recommended profile, while keeping the installed ODW
workflow as a single self-contained artefact.

## Decision drivers

- Add only the requested Unicorn and deslop rule sets to the application lint
  gate.
- Pin every lint tool and plugin version in `package.json` and
  `package-lock.json`.
- Keep generated bundles out of source linting; their inputs are linted and
  freshness is checked separately.
- Keep test source outside the application Oxlint target. Behavioural tests
  remain covered by `make test`, and their files continue through the existing
  repository gates.
- Disable rules only for documented incompatibilities with an existing
  repository requirement or between the selected plugins.
- Do not leave rule findings suppressed when a source correction can address
  them.

## Decision outcome

Run Oxlint from `make lint` against `adapters`, `bin/dakar-review.mjs`,
`scripts`, and `src`. Use the Unicorn recommended rules supported by the pinned
Oxlint release and `ai-deslop`'s recommended configuration. The package pins are
`oxlint` 1.82.0, `ai-deslop` 0.4.9, and `oxlint-tsgolint` 7.0.2004.

Unicorn's `prefer-reflect-apply` and deslop's `no-reflect-apply` prescribe
opposite implementations. Keep Unicorn's recommendation and disable only
`deslop/no-reflect-apply`. No other plugin rule is disabled.

The application validates untrusted workflow, CLI, and configuration data at
its boundaries with Zod 4.6.7. This lets internal code use parsed domain values
instead of repeating runtime shape checks. Zod is pinned as a development
dependency because both shipped JavaScript artefacts are bundled; it is inlined
into those artefacts and adds no external runtime import. The workflow compiler
permits the pinned `zod` package as its sole third-party runtime input and
continues to reject all other inputs outside the explicit module manifest. The
compiler encloses the flattened workflow body in a lexical block so its
internal bindings cannot collide with the required literal `meta` declaration.

## Options considered

### Keep Biome alone

This preserves the existing narrow gate but does not provide the requested
Unicorn and deslop rules.

### Enable every Oxlint built-in category

This would add unrelated rule sets beyond the selected plugin profiles and make
the new gate's scope less predictable. The configuration instead enables the
two requested profiles explicitly.

### Add exceptions for current source findings

Suppressions would preserve code that the new rules identify as needlessly
ambiguous or unsafe. Fix the underlying source instead, keeping the single
plugin-conflict exception above.

## Consequences

- `make lint` now runs Oxlint after the existing Biome complexity check.
- New authored application modules are included in the Oxlint command.
- The ODW source remains TypeScript; `make workflow-build` bundles Zod and
  regenerates `workflows/dakar-review.js` together with the CLI bundle.
- Changes to runtime schemas must preserve the existing CLI and workflow
  contracts, which remain covered by the full test and dry-run gates.
- Plugin upgrades require deliberate version bumps and a review of recommended
  rules and the documented `Reflect.apply` conflict.
