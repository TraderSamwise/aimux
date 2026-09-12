#!/usr/bin/env python3
"""Fail closed on unaccounted sync/async bridge seams.

The async cutover deliberately keeps a few sync/async boundaries: process entry
points, the CLI/TUI foreground loops, and temporary route-family seams that have
not converted yet. New `block_on` calls are migration debt unless they are named
here with a reason.
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


@dataclass(frozen=True)
class AllowedSeam:
    path: str
    contains: str
    max_count: int
    classification: str
    reason: str


ALLOWED_SEAMS = [
    AllowedSeam(
        "native/crates/aimux/src/async_runtime.rs",
        "pub fn block_on_named",
        1,
        "permanent",
        "shared sync/async bridge helper definition",
    ),
    AllowedSeam(
        "native/crates/aimux/src/async_runtime.rs",
        "return handle.block_on(future);",
        1,
        "permanent",
        "bridge execution from the registered blocking-pool handle",
    ),
    AllowedSeam(
        "native/crates/aimux/src/async_runtime.rs",
        "Err(_) => process_runtime().block_on(future),",
        1,
        "permanent",
        "process-entry bridge when no async runtime is already entered",
    ),
    AllowedSeam(
        "native/crates/aimux/src/async_runtime.rs",
        'block_on_named(task_name("phase1"',
        3,
        "test",
        "unit tests for the bridge helper",
    ),
    AllowedSeam(
        "native/crates/aimux/src/async_runtime.rs",
        ".block_on(handle)",
        2,
        "test",
        "unit tests that await spawned runtime handles",
    ),
    AllowedSeam(
        "native/crates/aimux/src/async_subprocess.rs",
        "block_on_named(name, run_output(self, timeout))",
        1,
        "permanent",
        "bounded output bridge for sync CLI, TUI, debug, git-root, and process-inspection callers",
    ),
    AllowedSeam(
        "native/crates/aimux/src/async_subprocess.rs",
        "block_on_named(name, run_status(self, timeout))",
        1,
        "permanent",
        "bounded status bridge for sync CLI, readiness, hyperlink, cleanup, and runtime-adapter callers",
    ),
    AllowedSeam(
        "native/crates/aimux/src/async_subprocess.rs",
        "block_on_named(name, run_spawn_detached(self))",
        1,
        "permanent",
        "detached launch bridge for sync long-lived process launchers; helper disables kill_on_drop",
    ),
    AllowedSeam(
        "native/crates/aimux/src/async_subprocess.rs",
        ".block_on(handle)",
        2,
        "test",
        "unit tests that await spawned runtime handles",
    ),
    AllowedSeam(
        "native/crates/aimux/src/daemon/runtime.rs",
        "crate::async_runtime::process_runtime().block_on(",
        1,
        "permanent",
        "daemon process entry point starts the async listener from mainline sync startup",
    ),
    AllowedSeam(
        "native/crates/aimux/src/project_service/process.rs",
        "crate::async_runtime::process_runtime().block_on(serve_project_service_listener_until(",
        1,
        "permanent",
        "project-service process entry point starts the async listener from mainline sync startup",
    ),
    AllowedSeam(
        "native/crates/aimux/src/project_service/process.rs",
        "crate::async_runtime::process_runtime().block_on(async {",
        11,
        "test",
        "project-service transport unit tests drive async handlers from sync test cases",
    ),
    AllowedSeam(
        "native/crates/aimux/tests/project_service_agents.rs",
        "aimux::async_runtime::block_on_named(",
        1,
        "test",
        "agent read route test drives async handler from sync test case",
    ),
    AllowedSeam(
        "native/crates/aimux/tests/project_service_controls.rs",
        "aimux::async_runtime::block_on_named(",
        2,
        "test",
        "control route tests drive async handlers from sync test cases",
    ),
    AllowedSeam(
        "native/crates/aimux/tests/project_service_desktop_state.rs",
        "aimux::async_runtime::block_on_named(",
        1,
        "test",
        "desktop-state route test drives async handler from sync test case",
    ),
    AllowedSeam(
        "native/crates/aimux/tests/project_service_statusline.rs",
        "aimux::async_runtime::block_on_named(",
        1,
        "test",
        "statusline route test drives async handler from sync test case",
    ),
    AllowedSeam(
        "native/crates/aimux/tests/project_service_switchable_agents.rs",
        "aimux::async_runtime::block_on_named(",
        2,
        "test",
        "switchable-agents route test drives async handler from sync test case",
    ),
    AllowedSeam(
        "native/crates/aimux/src/project_service/lifecycle/agent_launch_routes.rs",
        "crate::async_runtime::block_on_named(",
        1,
        "test",
        "agent spawn unit test drives async handler from a sync test case",
    ),
    AllowedSeam(
        "native/crates/aimux/src/relay_runner.rs",
        "crate::async_runtime::block_on_named(",
        2,
        "test",
        "relay runner unit tests drive async subscription polling from sync tests",
    ),
    AllowedSeam(
        "native/crates/aimux/tests/project_service_scheduler.rs",
        "aimux::async_runtime::block_on_named(",
        1,
        "test",
        "scheduler tests drive async scheduler methods from sync test cases",
    ),
    AllowedSeam(
        "native/crates/aimux/tests/async_cutover_phase3_characterization.rs",
        "aimux::async_runtime::block_on_named(",
        3,
        "test",
        "characterization tests drive async stream helpers from sync tests",
    ),
    AllowedSeam(
        "native/crates/aimux/tests/async_cutover_phase3_characterization.rs",
        ".block_on(hosted)",
        1,
        "test",
        "hosted characterization awaits one side of a paired async exchange",
    ),
    AllowedSeam(
        "native/crates/aimux/tests/async_cutover_phase3_characterization.rs",
        ".block_on(client)",
        1,
        "test",
        "hosted characterization awaits one side of a paired async exchange",
    ),
    AllowedSeam(
        "native/crates/aimux/tests/daemon_listener.rs",
        "aimux::async_runtime::block_on_named(",
        1,
        "test",
        "listener test joins async client/server tasks from a sync test",
    ),
    AllowedSeam(
        "native/crates/aimux/tests/daemon_process.rs",
        ".block_on(hosted)",
        1,
        "test",
        "hosted stream test awaits one side of a paired async exchange",
    ),
    AllowedSeam(
        "native/crates/aimux/tests/daemon_process.rs",
        ".block_on(client)",
        1,
        "test",
        "hosted stream test awaits one side of a paired async exchange",
    ),
    AllowedSeam(
        "native/crates/aimux/tests/daemon_stream.rs",
        "aimux::async_runtime::block_on_named(",
        1,
        "test",
        "daemon stream test drives async stream helper from a sync test",
    ),
    AllowedSeam(
        "native/crates/aimux/tests/fixtures/fixture_relay_client.rs",
        "aimux::async_runtime::block_on_named(",
        1,
        "fixture",
        "relay client fixture is a sync executable around an async relay client",
    ),
    AllowedSeam(
        "native/crates/aimux/tests/project_service_agent_restore.rs",
        "aimux::async_runtime::block_on_named(",
        1,
        "test",
        "restore task test drives one async PeriodicTask body from a sync test",
    ),
    AllowedSeam(
        "native/crates/aimux/tests/relay_runner.rs",
        "aimux::async_runtime::block_on_named(",
        1,
        "test",
        "relay runner test drives async subscription polling from a sync test",
    ),
    AllowedSeam(
        "native/crates/aimux/tests/tmux_runtime_manager.rs",
        "block_on(manager.",
        9,
        "test",
        "tmux runtime tests drive async tmux methods from sync test cases",
    ),
    AllowedSeam(
        "native/crates/aimux/tests/transcript_reconciler_task.rs",
        "aimux::async_runtime::block_on_named(",
        1,
        "test",
        "transcript reconciler test drives one async PeriodicTask body from a sync test",
    ),
]


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


def matching_allowed(seam: Seam) -> AllowedSeam | None:
    for allowed in ALLOWED_SEAMS:
        if seam.path == allowed.path and allowed.contains in seam.source:
            return allowed
    return None


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
    seams = find_seams([file for root in roots for file in rust_files(root)])
    counts: dict[AllowedSeam, int] = {allowed: 0 for allowed in ALLOWED_SEAMS}
    classified: list[tuple[Seam, AllowedSeam]] = []
    violations: list[str] = []
    for seam in seams:
        allowed = matching_allowed(seam)
        if allowed is None:
            violations.append(f"{seam.path}:{seam.line}: {seam.source}")
            continue
        counts[allowed] += 1
        classified.append((seam, allowed))
        if counts[allowed] > allowed.max_count:
            violations.append(
                f"{seam.path}:{seam.line}: {seam.source} (exceeds allowed {allowed.max_count} for {allowed.reason})"
            )
    if violations:
        print("async seam audit failed: unclassified sync/async bridge", file=sys.stderr)
        print(
            "classify each allowed seam as one of: permanent, transitional, test, fixture",
            file=sys.stderr,
        )
        for violation in violations:
            print(f"  {violation}", file=sys.stderr)
        return 1
    permanent = sum(count for allowed, count in counts.items() if allowed.classification == "permanent")
    transitional = sum(count for allowed, count in counts.items() if allowed.classification == "transitional")
    tests = len(seams) - permanent - transitional
    print(
        f"async seam audit passed: {len(seams)} seams ({permanent} permanent, {transitional} transitional, {tests} test/fixture)"
    )
    if args.list:
        for seam, allowed in classified:
            print(
                f"{allowed.classification}\t{seam.path}:{seam.line}\t{allowed.reason}"
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
