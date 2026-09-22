#!/usr/bin/env python3
"""Print the release assets the tag workflow actually builds.

The shipped platform set lives in one place: the `release-assets` build matrix
in `.github/workflows/release.yml`. Every checker that needs to know what a
complete release looks like reads it from here instead of keeping its own copy
-- dropping Intel from the matrix left three stale copies behind, and each one
failed a different release tag.

Output is one `platform<TAB>arch<TAB>variant<TAB>asset` line per matrix entry.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

WORKFLOW = Path(__file__).resolve().parent.parent / ".github" / "workflows" / "release.yml"
FIELDS = ("platform", "arch", "variant", "asset")
ENTRY = re.compile(r"^(\s*)-\s+(\w+):\s*(\S+)\s*$")
PAIR = re.compile(r"^(\s*)(\w+):\s*(\S+)\s*$")


def matrix_entries(workflow_text: str) -> list[dict[str, str]]:
    lines = workflow_text.splitlines()
    try:
        start = next(
            index
            for index, line in enumerate(lines)
            if line.startswith("  release-assets:")
        )
    except StopIteration:
        raise SystemExit("release.yml has no release-assets job")

    include = next(
        (index for index in range(start, len(lines)) if lines[index].strip() == "include:"),
        None,
    )
    if include is None:
        raise SystemExit("release-assets job has no matrix include block")

    entries: list[dict[str, str]] = []
    current: dict[str, str] | None = None
    indent: int | None = None
    for line in lines[include + 1 :]:
        if not line.strip():
            continue
        item = ENTRY.match(line)
        if item and (indent is None or len(item.group(1)) == indent):
            indent = len(item.group(1))
            current = {item.group(2): item.group(3)}
            entries.append(current)
            continue
        pair = PAIR.match(line)
        if current is not None and pair and len(pair.group(1)) == (indent or 0) + 2:
            current[pair.group(2)] = pair.group(3)
            continue
        break

    if not entries:
        raise SystemExit("release-assets matrix lists no entries")
    for entry in entries:
        missing = [field for field in FIELDS if field not in entry]
        if missing:
            raise SystemExit(f"release-assets matrix entry is missing {missing}: {entry}")
    return entries


def main() -> int:
    for entry in matrix_entries(WORKFLOW.read_text(encoding="utf-8")):
        print("\t".join(entry[field] for field in FIELDS))
    return 0


if __name__ == "__main__":
    sys.exit(main())
