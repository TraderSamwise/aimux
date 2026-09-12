#!/usr/bin/env python3
"""Fast structural checks for live residual daemon-port isolation."""

from __future__ import annotations

import importlib.util
import json
import shutil
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
PHASE8_PATH = ROOT / "scripts" / "phase8-live-residuals.py"
REMOTE_PATH = ROOT / "scripts" / "live-drive-remote.py"
PACKAGE_PATH = ROOT / "package.json"
CI_PATH = ROOT / ".github" / "workflows" / "ci.yml"
PHASE8_CI_LANES = [
    "tmux",
    "command-resolution",
    "agent-shell",
    "graveyard",
    "expose-interaction",
    "sse",
    "process",
]


def load_module(path: Path, name: str) -> Any:
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def assert_raises(label: str, fn: Any) -> None:
    try:
        fn()
    except Exception:
        return
    raise AssertionError(f"{label} unexpectedly succeeded")


def assert_ci_runs_phase8_lanes() -> None:
    package = json.loads(PACKAGE_PATH.read_text())
    scripts = package.get("scripts")
    if not isinstance(scripts, dict):
        raise AssertionError("package.json scripts must be an object")
    workflow = CI_PATH.read_text()
    for lane in PHASE8_CI_LANES:
        script_name = f"audit:phase8-live-residuals:{lane}"
        expected_script = f"python3 scripts/phase8-live-residuals.py --only {lane}"
        if scripts.get(script_name) != expected_script:
            raise AssertionError(f"missing package script for Phase 8 residual lane {lane}")
        if f"yarn {script_name}" not in workflow:
            raise AssertionError(f"CI does not run Phase 8 residual lane {lane}")
        if f"aimux-home-phase8-{lane}" not in workflow:
            raise AssertionError(f"CI residual lane {lane} lacks its own isolated AIMUX_HOME")


def main() -> int:
    compile(PHASE8_PATH.read_text(), str(PHASE8_PATH), "exec")
    compile(REMOTE_PATH.read_text(), str(REMOTE_PATH), "exec")
    assert_ci_runs_phase8_lanes()
    phase8 = load_module(PHASE8_PATH, "phase8_live_residuals_audit")
    remote = load_module(REMOTE_PATH, "live_drive_remote_audit")
    compile(remote.REMOTE_DRIVER, "<live-drive-remote REMOTE_DRIVER>", "exec")
    remote_driver: dict[str, Any] = {}
    exec(remote.REMOTE_DRIVER, remote_driver)

    assert_raises(
        "default daemon port isolation check",
        lambda: phase8.assert_isolated_daemon_port(
            str(phase8.DEFAULT_DAEMON_PORT), "audit"
        ),
    )
    assert_raises(
        "missing daemon port isolation check",
        lambda: phase8.assert_isolated_daemon_port(None, "audit"),
    )

    true_bin = shutil.which("true") or "/usr/bin/true"
    with phase8.Scope("audit-isolation", Path(true_bin)) as scope:
        port = scope.daemon_port()
        if port == phase8.DEFAULT_DAEMON_PORT:
            raise AssertionError("scope selected the default daemon port")
        assert_raises(
            "scope default daemon port override",
            lambda: scope.set_daemon_port(phase8.DEFAULT_DAEMON_PORT),
        )

    excluded = phase8.DEFAULT_DAEMON_PORT
    for _ in range(25):
        port = remote_driver["free_port"]({excluded})
        if port == excluded:
            raise AssertionError("remote hosted port allocator returned excluded port")

    print("live residual isolation audit passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
