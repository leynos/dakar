.PHONY: check fmt check-fmt docs-check lint typecheck markdownlint nixie test spelling \
	workflow-build workflow-freshness workflow-check

MD_FILES := $(shell git ls-files '*.md')
# Explicit bin/ and scripts/ entries, then every tracked test module via a glob
# so a newly added test cannot silently escape the node --check pre-flight.
NODE_MODULES := bin/dakar-review.mjs scripts/build-workflow.mjs scripts/live-review-harness.mjs scripts/odw-config.mjs scripts/review-config.mjs scripts/review-state.mjs $(shell git ls-files 'tests/*.test.mjs' 'tests/helpers/*.mjs')
UV ?= $(if $(wildcard $(HOME)/.local/bin/uv),$(HOME)/.local/bin/uv,uv)
UV_ENV = UV_CACHE_DIR=.uv-cache UV_TOOL_DIR=.uv-tools
TYPOS_CONFIG_BUILDER_VERSION ?= v0.1.1
TYPOS_CONFIG_BUILDER = $(UV_ENV) $(UV) tool run --python 3.14 --from \
	"git+https://github.com/leynos/typos-config-builder.git@$(TYPOS_CONFIG_BUILDER_VERSION)" \
	typos-config-builder

MDLINT ?= $(shell command -v markdownlint-cli2 2>/dev/null || printf '%s' "$$HOME/.bun/bin/markdownlint-cli2")
# `make fmt` and `make check-fmt` call mdtablefix directly. `--git` selects the
# Markdown files Git tracks and `--include-untracked` adds the untracked files
# Git does not ignore, so a new document is formatted before it is staged.
# Both modes need mdtablefix 0.6.0 or later; CI pins the version at the
# install-mdtablefix step.
MDTABLEFIX ?= mdtablefix
MDTABLEFIX_SELECT = --git --include-untracked
MDTABLEFIX_RULES = --wrap --renumber --breaks --ellipsis --fences

check: check-fmt lint typecheck workflow-check test spelling

fmt:
	$(MDTABLEFIX) --in-place $(MDTABLEFIX_SELECT) $(MDTABLEFIX_RULES)
	@unset FORCE_COLOR; $(MDLINT) --fix "**/*.md"

check-fmt:
	@printf '%s\n' "Checking whitespace and final newlines..."
	@! git ls-files -z -- bin docs scripts tests workflows AGENTS.md install.sh | \
		xargs -0 -r grep -n '[[:blank:]]$$'
	@git ls-files -z -- bin docs scripts tests workflows AGENTS.md install.sh | \
		xargs -0 -r sh -c 'for file do test "$$(tail -c 1 "$$file")" = "" || { printf "%s: missing final newline\n" "$$file"; exit 1; }; done' sh
	$(MDTABLEFIX) --check $(MDTABLEFIX_SELECT) $(MDTABLEFIX_RULES)

lint: markdownlint nixie docs-check

docs-check:
	@npm run docs:check

typecheck:
	@for file in $(NODE_MODULES); do node --check "$$file"; done
	@npm run typecheck
	@npm run odw:dry-run

markdownlint: spelling
	@npm run markdownlint

spelling:
	$(TYPOS_CONFIG_BUILDER) gate --repository .

nixie:
	@npm run nixie

test:
	@npm test

workflow-build:
	@npm run workflow:build

workflow-freshness:
	@npm run workflow:freshness

workflow-check: workflow-freshness
