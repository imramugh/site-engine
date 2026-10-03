.PHONY: check test build

check:
	python3 scripts/validate_scaffolding.py

test:
	pnpm test

build:
	pnpm build
