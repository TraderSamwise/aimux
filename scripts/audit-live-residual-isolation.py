#!/usr/bin/env python3
"""Fast structural checks for live residual daemon-port isolation."""

from __future__ import annotations

import importlib.util
import shutil
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
PHASE8_PATH = ROOT / "scripts" / "phase8-live-residuals.py"
REMOTE_PATH = ROOT / "scripts" / "live-drive-remote.py"


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


def main() -> int:
    compile(PHASE8_PATH.read_text(), str(PHASE8_PATH), "exec")
    compile(REMOTE_PATH.read_text(), str(REMOTE_PATH), "exec")
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
