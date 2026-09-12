#!/usr/bin/env python3
"""Detect accidental downgrade of the async seam audit implementation."""

from __future__ import annotations

import os
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
AUDIT_SCRIPT = ROOT / "scripts" / "audit-async-seams.py"
MARKER = "aimux-async-seam:"


def rust_files(root: Path) -> list[Path]:
    if not root.exists():
        return []
    files: list[Path] = []
    for directory, names, filenames in os.walk(root):
        names[:] = [name for name in names if name not in {".git", "target"}]
        for filename in filenames:
            if filename.endswith(".rs"):
                files.append(Path(directory) / filename)
    return files


def marker_locations() -> list[str]:
    locations: list[str] = []
    roots = [
        ROOT / "native" / "crates" / "aimux" / "src",
        ROOT / "native" / "crates" / "aimux" / "tests",
    ]
    for file in [path for root in roots for path in rust_files(root)]:
        relative = str(file.relative_to(ROOT))
        for line_number, line in enumerate(file.read_text().splitlines(), start=1):
            if MARKER in line:
                locations.append(f"{relative}:{line_number}")
    return locations


def main() -> int:
    source = AUDIT_SCRIPT.read_text()
    markers = marker_locations()
    if not markers:
        return 0
    failures: list[str] = []
    if "ALLOWED_SEAMS" in source or "class AllowedSeam" in source:
        failures.append(
            "scripts/audit-async-seams.py is in count-mode while "
            f"{len(markers)} local aimux-async-seam markers exist"
        )
    for required in ["SEAM_MARKER", "marker_for_seam", "collect_markers"]:
        if required not in source:
            failures.append(
                f"scripts/audit-async-seams.py is missing marker-gate implementation `{required}`"
            )
    if failures:
        print("async seam audit self-check failed: marker gate was downgraded", file=sys.stderr)
        for failure in failures:
            print(f"  {failure}", file=sys.stderr)
        print(
            "  restore marker-based enforcement so markers are attached to adjacent seams",
            file=sys.stderr,
        )
        print(f"  example marker: {markers[0]}", file=sys.stderr)
        return 1
    print(f"async seam audit self-check passed: marker gate active for {len(markers)} markers")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
