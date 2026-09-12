#!/usr/bin/env python3
"""Fail closed on unaccounted sync/async bridge seams.

The async cutover deliberately keeps a few sync/async boundaries: process entry
points, the CLI/TUI foreground loops, and temporary route-family seams that have
not converted yet. New `block_on` calls are migration debt unless they carry a
local `aimux-async-seam` marker with a classification and reason.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ROOTS = [
    ROOT / "native" / "crates" / "aimux" / "src",
    ROOT / "native" / "crates" / "aimux" / "tests",
]
SEAM_CALL = re.compile(
    r"(?:\bblock_on_named\s*\(|(?<![A-Za-z0-9_])\.block_on\s*\(|\bblock_on\s*\()"
)
SEAM_MARKER = re.compile(
    r"aimux-async-seam:\s*(permanent|transitional|test|fixture)\s+-\s*(\S.*)$"
)
VALID_CLASSIFICATIONS = "permanent, transitional, test, fixture"
MARKER_EXAMPLE = "// aimux-async-seam: test - sync test drives async handler"


@dataclass(frozen=True)
class SeamMarker:
    path: str
    line: int
    classification: str
    reason: str


@dataclass(frozen=True)
class Seam:
    path: str
    line: int
    source: str


def rust_files(root: Path) -> list[Path]:
    if not root.exists():
        return []
    if root.is_file():
        return [root] if root.suffix == ".rs" else []
    files: list[Path] = []
    for directory, names, filenames in os.walk(root):
        names[:] = [name for name in names if name not in {".git", "target"}]
        for filename in filenames:
            if filename.endswith(".rs"):
                files.append(Path(directory) / filename)
    return files


def mask_rust(text: str) -> str:
    output: list[str] = []
    index = 0
    state = "code"
    while index < len(text):
        ch = text[index]
        nxt = text[index + 1] if index + 1 < len(text) else ""
        if state == "code":
            if ch == "/" and nxt == "/":
                output.extend("  ")
                index += 2
                state = "line"
            elif ch == "/" and nxt == "*":
                output.extend("  ")
                index += 2
                state = "block"
            elif ch == '"':
                output.append(" ")
                index += 1
                state = "string"
            else:
                output.append(ch)
                index += 1
        elif state == "line":
            output.append("\n" if ch == "\n" else " ")
            index += 1
            if ch == "\n":
                state = "code"
        elif state == "block":
            output.append("\n" if ch == "\n" else " ")
            if ch == "*" and nxt == "/":
                output.append(" ")
                index += 2
                state = "code"
            else:
                index += 1
        else:
            output.append("\n" if ch == "\n" else " ")
            if ch == "\\":
                if nxt:
                    output.append("\n" if nxt == "\n" else " ")
                index += 2
            else:
                index += 1
                if ch == '"':
                    state = "code"
    return "".join(output)


def find_seams(paths: list[Path]) -> list[Seam]:
    seams: list[Seam] = []
    for file in paths:
        text = file.read_text()
        masked = mask_rust(text)
        for line_number, (source_line, masked_line) in enumerate(
            zip(text.splitlines(), masked.splitlines()), start=1
        ):
            if SEAM_CALL.search(masked_line):
                seams.append(
                    Seam(
                        path=str(file.relative_to(ROOT)),
                        line=line_number,
                        source=source_line.strip(),
                    )
                )
    return seams


def parse_marker(path: str, line: int, source: str) -> SeamMarker | str | None:
    if "aimux-async-seam:" not in source:
        return None
    marker = SEAM_MARKER.search(source)
    if marker is None:
        return (
            f"{path}:{line}: malformed async seam marker; use "
            f"`{MARKER_EXAMPLE}` with one of: {VALID_CLASSIFICATIONS}"
        )
    return SeamMarker(
        path=path,
        line=line,
        classification=marker.group(1),
        reason=marker.group(2).strip(),
    )


def marker_for_seam(
    seam: Seam, lines_by_path: dict[str, list[str]], used_markers: set[tuple[str, int]]
) -> SeamMarker | str | None:
    lines = lines_by_path[seam.path]
    candidates = [seam.line, seam.line - 1]
    for line_number in candidates:
        if line_number < 1:
            continue
        marker = parse_marker(seam.path, line_number, lines[line_number - 1])
        if marker is None:
            continue
        if isinstance(marker, str):
            return marker
        key = (marker.path, marker.line)
        if key in used_markers:
            return (
                f"{seam.path}:{seam.line}: async seam marker at "
                f"{marker.path}:{marker.line} is already attached to another seam; "
                "write one marker per seam"
            )
        used_markers.add(key)
        return marker
    return None


def collect_markers(paths: list[Path]) -> dict[tuple[str, int], SeamMarker | str]:
    markers: dict[tuple[str, int], SeamMarker | str] = {}
    for file in paths:
        path = str(file.relative_to(ROOT))
        for line_number, source in enumerate(file.read_text().splitlines(), start=1):
            marker = parse_marker(path, line_number, source)
            if marker is not None:
                markers[(path, line_number)] = marker
    return markers


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Audit the remaining sync/async bridge seams."
    )
    parser.add_argument(
        "--list",
        action="store_true",
        help="print the classified seam inventory after the audit passes",
    )
    parser.add_argument(
        "roots",
        nargs="*",
        help="repository-relative Rust source roots to scan",
    )
    args = parser.parse_args()
    roots = [ROOT / arg for arg in args.roots] if args.roots else DEFAULT_ROOTS
    files = [file for root in roots for file in rust_files(root)]
    seams = find_seams(files)
    lines_by_path = {
        str(file.relative_to(ROOT)): file.read_text().splitlines() for file in files
    }
    markers = collect_markers(files)
    used_markers: set[tuple[str, int]] = set()
    classified: list[tuple[Seam, SeamMarker]] = []
    violations: list[str] = []
    for seam in seams:
        marker = marker_for_seam(seam, lines_by_path, used_markers)
        if marker is None:
            violations.append(
                f"{seam.path}:{seam.line}: {seam.source} "
                f"(missing adjacent marker; add `{MARKER_EXAMPLE}` immediately "
                "before the call or on the same line)"
            )
            continue
        if isinstance(marker, str):
            violations.append(marker)
            continue
        classified.append((seam, marker))
    for key, marker in markers.items():
        if key in used_markers:
            continue
        if isinstance(marker, str):
            violations.append(marker)
            continue
        violations.append(
            f"{marker.path}:{marker.line}: stale async seam marker has no adjacent seam"
        )
    if violations:
        print("async seam audit failed: unclassified sync/async bridge", file=sys.stderr)
        print(
            f"mark each allowed seam as `{MARKER_EXAMPLE}` with one of: {VALID_CLASSIFICATIONS}",
            file=sys.stderr,
        )
        for violation in violations:
            print(f"  {violation}", file=sys.stderr)
        return 1
    permanent = sum(
        1 for _, marker in classified if marker.classification == "permanent"
    )
    transitional = sum(
        1 for _, marker in classified if marker.classification == "transitional"
    )
    tests = len(seams) - permanent - transitional
    print(
        f"async seam audit passed: {len(seams)} seams ({permanent} permanent, {transitional} transitional, {tests} test/fixture)"
    )
    if args.list:
        for seam, marker in classified:
            print(
                f"{marker.classification}\t{seam.path}:{seam.line}\t{marker.reason}"
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
