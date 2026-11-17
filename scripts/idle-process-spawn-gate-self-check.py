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


def check_instrument_is_not_reported_as_a_host_spawner() -> list[str]:
    """The observed-spawner list must leave out the gate's own `ps` calls.

    On macOS the sampler snapshots every 0.10s, so a five-second window spawns
    about fifty `ps` processes and each one is a new pid to the next snapshot.
    They used to be counted, and `ps -axo` then read as the top system spawner
    on the machine. That is the gate reporting its instrument, and it is read
    during an incident, which is when a wrong lead costs the most.
    """
    problems: list[str] = []
    samples = [
        gate.SpawnSample(pid=501, ppid=1, command="tmux new-session"),
        gate.SpawnSample(pid=502, ppid=1, command="ps -axo pid=,ppid=,command="),
        gate.SpawnSample(pid=503, ppid=1, command="ps -axo pid=,ppid=,command="),
        gate.SpawnSample(pid=504, ppid=1, command="/bin/sh -c printf '%s' $$"),
    ]
    instrument = {502, 503, 504}

    labels = dict(gate._top_labels_excluding(samples, instrument, 8))
    if any("ps -axo" in label for label in labels):
        problems.append(
            "the gate's own ps calls are still reported as host spawners, which is how "
            f"'ps -axo' becomes the top spawner on a quiet machine: {labels}"
        )
    if any("/bin/sh" in label for label in labels):
        problems.append(
            f"the pid-allocation probe is still reported as a host spawner: {labels}"
        )
    if labels.get("tmux new-session") != 1:
        problems.append(
            "excluding the instrument also dropped a REAL spawner; the exclusion must be "
            f"by pid, not by command text: {labels}"
        )

    # And the control: with nothing excluded, the instrument IS counted. Without
    # this, a helper that returned an empty list would satisfy every assertion
    # above.
    unfiltered = dict(gate._top_labels_excluding(samples, set(), 8))
    if not any("ps -axo" in label for label in unfiltered):
        problems.append(
            "the control did not see the instrument even with nothing excluded, so this "
            f"check cannot tell filtering from an empty result: {unfiltered}"
        )
    return problems


def main() -> int:
    problems: list[str] = []

    problems += check_instrument_is_not_reported_as_a_host_spawner()

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

    # An excess the gate cannot attribute is not a regression: the attributed
    # rate is checked first, so reaching here means aimux is under budget and
    # only the cross-check is unavailable. Reporting it as a failure made a
    # working PR sit red while naming no culprit.
    problems += check(
        "quiet host, unattributable excess",
        decide(incremental_rate=30.0),
        gate.PASS_EXIT,
        "PASS",
        "cross-check UNAVAILABLE",
        "not attributable",
        "heaviest system spawner=python3",
    )

    # But an excess that IS attributable still fails, which is the whole point.
    problems += check(
        "quiet host, attributable excess",
        decide(incremental_rate=30.0, aimux_spawn_rate=30.0),
        gate.FAIL_EXIT,
        "FAIL",
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

    # A pid wrap inside a sample is ordinary on a long-uptime Mac. It makes one
    # window unusable, and refusing outright failed a release gate.
    wraps = {"count": 0}

    def wrapping_probe(sequence=[99_644, 1_071, 1_200, 1_400]):
        wraps["count"] += 1
        return sequence[min(wraps["count"] - 1, len(sequence) - 1)]

    meter = gate.ProcessCreationMeter()
    meter.system = "Darwin"
    original_probe = gate._spawn_pid_probe
    original_sleep = gate.time.sleep
    gate._spawn_pid_probe = wrapping_probe
    gate.time.sleep = lambda _seconds: None
    try:
        measurement = meter._measure_darwin(0.0)
    finally:
        gate._spawn_pid_probe = original_probe
        gate.time.sleep = original_sleep
    if measurement.count != 200:
        problems.append(
            f"pid wrap re-sample: expected the window after the wrap, got {measurement.count}"
        )

    for problem in problems:
        print(problem, file=sys.stderr)
    if problems:
        return 1
    print("idle process spawn gate self-check: 6 outcomes and a pid wrap verified")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
