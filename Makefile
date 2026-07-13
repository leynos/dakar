.PHONY: check check-fmt lint typecheck markdownlint nixie test

MD_FILES := $(shell git ls-files '*.md')
NODE_MODULES := bin/dakar-review.mjs scripts/review-config.mjs scripts/review-state.mjs tests/cli.test.mjs tests/review-config.test.mjs tests/review-state.test.mjs tests/review-state.property.test.mjs tests/review-state.robustness.test.mjs tests/workflow-dry-run.test.mjs tests/workflow-task-graph.test.mjs

check: check-fmt lint typecheck test

check-fmt:
	@printf '%s\n' "Checking whitespace and final newlines..."
	@! { find bin docs scripts tests workflows -type f; printf '%s\n' AGENTS.md install.sh; } | xargs grep -n '[[:blank:]]$$'
	@{ find bin docs scripts tests workflows -type f; printf '%s\n' AGENTS.md install.sh; } | xargs sh -c 'for file do test "$$(tail -c 1 "$$file")" = "" || { printf "%s: missing final newline\n" "$$file"; exit 1; }; done' sh

lint: markdownlint nixie

typecheck:
	@for file in $(NODE_MODULES); do node --check "$$file"; done
	@npm run odw:dry-run

markdownlint:
	@npm run markdownlint

nixie:
	@npm run nixie

test:
	@npm test
