.PHONY: check check-fmt lint typecheck markdownlint nixie test

MD_FILES := $(shell git ls-files '*.md')
NODE_MODULES := bin/dakar-review.mjs scripts/review-config.mjs scripts/review-state.mjs tests/cli.test.mjs tests/review-config.test.mjs tests/review-state.test.mjs tests/workflow-dry-run.test.mjs

check: check-fmt lint typecheck markdownlint nixie test

check-fmt:
	@printf '%s\n' "Checking whitespace and final newlines..."
	@! { find bin docs scripts tests workflows -type f; printf '%s\n' AGENTS.md install.sh; } | xargs grep -n '[[:blank:]]$$'
	@{ find bin docs scripts tests workflows -type f; printf '%s\n' AGENTS.md install.sh; } | xargs sh -c 'for file do test "$$(tail -c 1 "$$file")" = "" || { printf "%s: missing final newline\n" "$$file"; exit 1; }; done' sh

lint: typecheck test

typecheck:
	@for file in $(NODE_MODULES); do node --check "$$file"; done
	@npm run odw:dry-run

markdownlint:
	@markdownlint-cli2 $(MD_FILES)

nixie:
	@nixie $(MD_FILES)

test:
	@npm test
