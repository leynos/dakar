.PHONY: check check-fmt lint typecheck markdownlint nixie test

MD_FILES := $(shell git ls-files '*.md')
NODE_MODULES := scripts/review-state.mjs tests/review-state.test.mjs

check: check-fmt lint typecheck markdownlint nixie test

check-fmt:
	@printf '%s\n' "Checking whitespace and final newlines..."
	@! find docs scripts tests workflows -type f -print0 | xargs -0 grep -n '[[:blank:]]$$'
	@find docs scripts tests workflows -type f -exec sh -c 'for file do test "$$(tail -c 1 "$$file")" = "" || { printf "%s: missing final newline\n" "$$file"; exit 1; }; done' sh {} +

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
