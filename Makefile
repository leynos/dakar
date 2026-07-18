.PHONY: check check-fmt docstrings lint typecheck markdownlint nixie test spelling \
	spelling-config spelling-config-write spelling-phrase-check \
	spelling-helper-test workflow-build workflow-freshness workflow-check

MD_FILES := $(shell git ls-files '*.md')
NODE_MODULES := bin/dakar-review.mjs scripts/build-workflow.mjs scripts/check-docstrings.mjs scripts/review-config.mjs scripts/review-state.mjs tests/cli.test.mjs tests/compile-time-contract.test.mjs tests/docstrings.test.mjs tests/review-config.test.mjs tests/review-state.test.mjs tests/review-state.property.test.mjs tests/review-state.robustness.test.mjs tests/workflow-build.test.mjs tests/workflow-candidate-paths.test.mjs tests/workflow-dry-run.test.mjs tests/workflow-retry.test.mjs tests/workflow-task-graph.test.mjs
UV ?= $(if $(wildcard $(HOME)/.local/bin/uv),$(HOME)/.local/bin/uv,uv)
UV_ENV = UV_CACHE_DIR=.uv-cache UV_TOOL_DIR=.uv-tools
RUFF_VERSION ?= 0.15.12
PATHSPEC_VERSION ?= 1.1.1
TYPOS_VERSION ?= 1.48.0
TYPOS_CONFIG_BUILDER_COMMIT := b604f198797fdd36a567dd0f8f07b13f9539b241
TYPOS_CONFIG_BUILDER_SOURCE := git+https://github.com/leynos/typos-config-builder.git@$(TYPOS_CONFIG_BUILDER_COMMIT)
TYPOS_CONFIG_BUILDER := $(UV_ENV) $(UV) tool run --python 3.14 \
	--from "$(TYPOS_CONFIG_BUILDER_SOURCE)" typos-config-builder
SPELLING_PY_SRCS := \
	scripts/typos_rollout_check.py scripts/tests/test_typos_rollout_check.py
SPELLING_PY_TESTS := scripts/tests/test_typos_rollout_check.py
SPELLING_COVERAGE_ARGS := --cov=typos_rollout_check --cov-fail-under=90
SPELLING_HELPER_PYTEST = PYTHONPATH=scripts $(UV_ENV) $(UV) run --no-project \
	--python 3.14 --with pathspec==$(PATHSPEC_VERSION) --with pytest==9.0.2 \
	--with pytest-cov==7.0.0 python -m pytest

check: check-fmt lint typecheck workflow-check test spelling

check-fmt:
	@printf '%s\n' "Checking whitespace and final newlines..."
	@! git ls-files -z -- bin docs scripts tests workflows AGENTS.md install.sh | \
		xargs -0 -r grep -n '[[:blank:]]$$'
	@git ls-files -z -- bin docs scripts tests workflows AGENTS.md install.sh | \
		xargs -0 -r sh -c 'for file do test "$$(tail -c 1 "$$file")" = "" || { printf "%s: missing final newline\n" "$$file"; exit 1; }; done' sh

lint: markdownlint nixie docstrings

docstrings:
	@npm run docstrings

typecheck:
	@for file in $(NODE_MODULES); do node --check "$$file"; done
	@npm run typecheck
	@npm run odw:dry-run

markdownlint: spelling
	@npm run markdownlint

spelling: spelling-phrase-check
	@git ls-files -z '*.md' | xargs -0 -r env $(UV_ENV) \
		$(UV) tool run typos@$(TYPOS_VERSION) --config typos.toml --force-exclude

spelling-phrase-check: spelling-config
	@PYTHONPATH=scripts $(UV_ENV) $(UV) run --no-project --python 3.14 \
		scripts/typos_rollout_check.py --repository .

spelling-config: spelling-helper-test
	@git ls-files --error-unmatch typos.toml >/dev/null
	@$(TYPOS_CONFIG_BUILDER) --repository . --check

spelling-config-write: spelling-helper-test
	@$(TYPOS_CONFIG_BUILDER) --repository .

spelling-helper-test:
	@$(UV_ENV) $(UV) tool run ruff@$(RUFF_VERSION) format --isolated --target-version py313 --check $(SPELLING_PY_SRCS)
	@$(UV_ENV) $(UV) tool run ruff@$(RUFF_VERSION) check --isolated --target-version py313 $(SPELLING_PY_SRCS)
	@$(SPELLING_HELPER_PYTEST) $(SPELLING_PY_TESTS) -c /dev/null --rootdir=. \
		--confcutdir=scripts -p no:cacheprovider $(SPELLING_COVERAGE_ARGS)

nixie:
	@npm run nixie

test:
	@npm test

workflow-build:
	@npm run workflow:build

workflow-freshness:
	@npm run workflow:freshness

workflow-check: workflow-freshness
