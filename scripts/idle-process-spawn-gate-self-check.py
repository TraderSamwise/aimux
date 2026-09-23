#!/usr/bin/env python3
"""Exercise every outcome of the idle process-spawn gate's verdict.

The gate's own --mutation flags reproduce these outcomes against a real fleet,
but the host-load mutation spawns ~166 processes/sec, which is the pattern that
wedged this machine's kernel quarantine path. The verdict is a pure function of
two measurements, so the outcomes are proved here instead and the mutations stay
available for a dedicated box.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GATE = ROOT / "scripts" / "idle-process-spawn-gate.py"

spec = importlib.util.spec_from_file_location("idle_process_spawn_gate", GATE)
assert spec and spec.loader
gate = importlib.util.module_from_spec(spec)
# dataclasses resolves annotations through sys.modules, so register first.
sys.modules[spec.name] = gate
spec.loader.exec_module(gate)


def decide(**overrides):
    arguments = {
        "budget_per_sec": 8.0,
        "max_baseline_rate": 50.0,
        "baseline_rate": 4.0,
        "incremental_rate": 0.5,
        "aimux_spawn_rate": 0.4,
        "root_pids": {101, 102},
        "aimux_top_spawners": [("tmux (isolated PATH exec)", 2)],
        "system_top_spawners": [("python3", 40)],
    }
    arguments.update(overrides)
    return gate.decide_verdict(**arguments)


def check(label: str, verdict, exit_code: int, *fragments: str) -> list[str]:
    problems = []
    if verdict.exit_code != exit_code:
        problems.append(f"{label}: expected exit {exit_code}, got {verdict.exit_code}")
    for fragment in fragments:
        if fragment not in verdict.message:
            problems.append(f"{label}: message does not say {fragment!r}: {verdict.message}")
    return problems


def main() -> int:
    problems: list[str] = []

    problems += check(
        "quiet host, quiet aimux",
        decide(),
        gate.PASS_EXIT,
        "PASS",
        "cross-check clean",
    )

    # The case that made release readiness unrunnable while agents work: the
    # host is noisy, and aimux was measured directly at well under budget.
    problems += check(
        "noisy host, quiet aimux",
        decide(baseline_rate=62.0, incremental_rate=0.0),
        gate.PASS_EXIT,
        "PASS",
        "cross-check UNAVAILABLE",
        "host baseline 62.00/s",
    )

    # A noisy host must not mask a real regression: attribution is by process
    # identity and does not depend on the whole-machine delta at all.
    problems += check(
        "noisy host, spawning aimux",
        decide(
            baseline_rate=62.0,
            aimux_spawn_rate=40.25,
            aimux_top_spawners=[("tmux (isolated PATH exec)", 201)],
        ),
        gate.FAIL_EXIT,
        "FAIL",
        "heaviest aimux-subtree spawner=tmux (isolated PATH exec)",
    )

    problems += check(
        "quiet host, unattributable excess",
        decide(incremental_rate=30.0),
        gate.COULD_NOT_MEASURE_EXIT,
        "COULD_NOT_MEASURE",
        "not attributable",
        "heaviest system spawner=python3",
    )

    problems += check(
        "no process roots",
        decide(root_pids=set()),
        gate.COULD_NOT_MEASURE_EXIT,
        "COULD_NOT_MEASURE",
        "process roots",
    )

    # A noisy host must never turn into a pass when aimux could not be located.
    problems += check(
        "noisy host, no process roots",
        decide(baseline_rate=62.0, root_pids=set()),
        gate.COULD_NOT_MEASURE_EXIT,
        "COULD_NOT_MEASURE",
    )

    for problem in problems:
        print(problem, file=sys.stderr)
    if problems:
        return 1
    print("idle process spawn gate self-check: 6 outcomes verified")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
