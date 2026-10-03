#!/usr/bin/env python3
"""Validate repository metadata without third-party dependencies."""

from __future__ import annotations

import json
import re
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REQUIRED_FILES = (
    "README.md", "CONTRIBUTING.md", "SECURITY.md", "LICENSE", "NOTICE", "CODEOWNERS",
    ".github/pull_request_template.md", ".github/ISSUE_TEMPLATE/user-story.yml",
    ".github/ISSUE_TEMPLATE/bug-report.yml", ".github/workflows/validate-scaffold.yml",
    "docs/release-policy.md", "docs/dependency-policy.md",
)
ISSUE_FIELDS = {
    "user-story.yml": ("user", "outcome", "acceptance_criteria", "constraints", "test_evidence", "e2e_scenarios", "dependencies"),
    "bug-report.yml": ("summary", "reproduce", "expected", "actual", "environment", "evidence"),
}

def fail(message: str) -> None:
    raise SystemExit(f"validation failed: {message}")

def main() -> None:
    for relative_path in REQUIRED_FILES:
        if not (ROOT / relative_path).is_file():
            fail(f"missing required file: {relative_path}")
    try:
        json.loads((ROOT / "renovate.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        fail(f"invalid renovate.json: {error}")
    for filename, fields in ISSUE_FIELDS.items():
        contents = (ROOT / ".github" / "ISSUE_TEMPLATE" / filename).read_text(encoding="utf-8")
        for field in fields:
            marker = f"    id: {field}\n"
            if marker not in contents:
                fail(f"{filename} is missing required field '{field}'")
            start = contents.index(marker)
            next_field = contents.find("  - type:", start + len(marker))
            section = contents[start : next_field if next_field != -1 else None]
            if "required: true" not in section:
                fail(f"{filename} field '{field}' must be required")
    workflow = (ROOT / ".github/workflows/validate-scaffold.yml").read_text(encoding="utf-8")
    if 'python-version: "3.14"' not in workflow:
        fail("workflow must use Python 3.14")
    for action in ("actions/checkout", "actions/setup-python"):
        if not re.search(re.escape(action) + r"@[0-9a-f]{40}\b", workflow):
            fail(f"workflow must pin {action} to a commit")
    for config in (ROOT / ".codex").rglob("*.toml"):
        tomllib.loads(config.read_text(encoding="utf-8"))
    print("scaffold metadata is valid")

if __name__ == "__main__":
    main()
