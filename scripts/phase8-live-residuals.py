#!/usr/bin/env python3
"""Phase 8 live residual smoke/stress checks.

This is intentionally not part of the default unit test lane. It starts live
processes and a private tmux server, but every side effect is scoped to temp
HOME/AIMUX_HOME roots, random loopback ports, and a unique tmux -L socket.
"""

from __future__ import annotations

import argparse
import fcntl
import glob
import http.client
import json
import os
import pty
import re
import shlex
import shutil
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import termios
import threading
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_TARGET_DIR = Path("/tmp/aimux-phase8-live-target")
SSE_EVENT_COUNT = 96
SSE_CLIENT_COUNT = 8
DEFAULT_DAEMON_PORT = 43190
RESIDUAL_DAEMON_PORT_MIN = 45000
RESIDUAL_DAEMON_PORT_MAX = 45999
ANSI_ESCAPE_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
TMUX_SESSION_ENV_KEYS = [
    "AIMUX_HOME",
    "AIMUX_DAEMON_HOST",
    "AIMUX_DAEMON_PORT",
    "AIMUX_DASHBOARD_IMPLEMENTATION",
    "AIMUX_NATIVE_BIN",
    "AIMUX_CLI_BIN",
    "HOME",
    "PATH",
    "TERM",
    "TMPDIR",
]


class LiveResidualFailure(Exception):
    pass


class Scope:
    def __init__(self, label: str, aimux_bin: Path):
        self.temp = tempfile.TemporaryDirectory(prefix=f"aimux-phase8-{label}-")
        self.root = Path(self.temp.name)
        self.home = self.root / "home"
        self.aimux_home = self.root / "aimux-home"
        self.project = self.root / "project"
        self.tmp = Path(tempfile.mkdtemp(prefix=f"aimux-phase8-{label}-{os.getpid()}-", dir="/tmp"))
        self.aimux_bin = aimux_bin
        self.procs: list[subprocess.Popen[Any]] = []
        self.fds: list[int] = []
        self.tmux_socket_name: str | None = None
        self.extra_tmux_socket_names: list[str] = []
        self.real_tmux: str | None = None
        self.env = isolated_env(self.home, self.aimux_home, aimux_bin, self.tmp)
        self.home.mkdir(parents=True, exist_ok=True)
        self.aimux_home.mkdir(parents=True, exist_ok=True)
        self.project.mkdir(parents=True, exist_ok=True)

    def init_git_project(self) -> None:
        run(["git", "init", "-q"], cwd=self.project, env=self.env, timeout=10)
        run(
            ["git", "config", "user.email", "phase8@example.invalid"],
            cwd=self.project,
            env=self.env,
            timeout=10,
        )
        run(
            ["git", "config", "user.name", "Phase 8 Smoke"],
            cwd=self.project,
            env=self.env,
            timeout=10,
        )

    def popen(
        self,
        args: list[str],
        *,
        cwd: Path | None = None,
        stdout: int | None = subprocess.PIPE,
        stderr: int | None = subprocess.PIPE,
    ) -> subprocess.Popen[Any]:
        proc = subprocess.Popen(
            args,
            cwd=str(cwd or self.project),
            env=self.env,
            stdin=subprocess.DEVNULL,
            stdout=stdout,
            stderr=stderr,
            text=True,
        )
        self.procs.append(proc)
        return proc

    def cleanup(self) -> None:
        self.stop_control_plane()
        tmux = find_tmux(required=False)
        if tmux:
            socket_names = []
            if self.tmux_socket_name:
                socket_names.append(self.tmux_socket_name)
            socket_names.extend(self.extra_tmux_socket_names)
            for socket_name in socket_names:
                subprocess.run(
                    [tmux, "-L", socket_name, "kill-server"],
                    env=without_tmux(os.environ.copy()),
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=5,
                    check=False,
                )
        for proc in reversed(self.procs):
            terminate_process(proc)
        for fd in self.fds:
            try:
                os.close(fd)
            except OSError:
                pass
        shutil.rmtree(self.tmp, ignore_errors=True)
        self.temp.cleanup()

    def stop_control_plane(self) -> None:
        project_service_pids = self.project_service_pids()
        try:
            subprocess.run(
                [str(self.aimux_bin), "daemon", "stop", "--json"],
                cwd=str(self.project),
                env=self.env,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=5,
                check=False,
            )
        except Exception:
            pass
        for pid in project_service_pids:
            terminate_pid(pid)

    def project_service_pids(self) -> list[int]:
        state_path = self.aimux_home / "daemon" / "state.json"
        try:
            state = json.loads(state_path.read_text())
        except Exception:
            return []
        projects = state.get("projects")
        if not isinstance(projects, dict):
            return []
        pids = []
        for project in projects.values():
            if isinstance(project, dict) and isinstance(project.get("pid"), int):
                pids.append(project["pid"])
        return pids

    def __enter__(self) -> "Scope":
        return self

    def __exit__(self, _exc_type: Any, _exc: Any, _tb: Any) -> None:
        self.cleanup()


def isolated_env(home: Path, aimux_home: Path, aimux_bin: Path, tmp: Path) -> dict[str, str]:
    env = os.environ.copy()
    env["HOME"] = str(home)
    env["AIMUX_HOME"] = str(aimux_home)
    env["AIMUX_NATIVE_BIN"] = str(aimux_bin)
    env["AIMUX_CLI_BIN"] = str(aimux_bin)
    env["AIMUX_DAEMON_HOST"] = "127.0.0.1"
    env["AIMUX_DAEMON_PORT"] = str(free_residual_daemon_port())
    env["AIMUX_DASHBOARD_IMPLEMENTATION"] = "native"
    env["TERM"] = "xterm-256color"
    env["TMPDIR"] = str(tmp)
    Path(env["TMPDIR"]).mkdir(parents=True, exist_ok=True)
    return without_tmux(env)


def without_tmux(env: dict[str, str]) -> dict[str, str]:
    env.pop("TMUX", None)
    env.pop("TMUX_PANE", None)
    return env


def free_residual_daemon_port() -> int:
    span = RESIDUAL_DAEMON_PORT_MAX - RESIDUAL_DAEMON_PORT_MIN + 1
    start = RESIDUAL_DAEMON_PORT_MIN + ((os.getpid() + time.monotonic_ns()) % span)
    for offset in range(span):
        port = RESIDUAL_DAEMON_PORT_MIN + ((start - RESIDUAL_DAEMON_PORT_MIN + offset) % span)
        if port == DEFAULT_DAEMON_PORT:
            continue
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            try:
                sock.bind(("127.0.0.1", port))
            except OSError:
                continue
            return port
    raise LiveResidualFailure(
        f"no free isolated daemon port in {RESIDUAL_DAEMON_PORT_MIN}-{RESIDUAL_DAEMON_PORT_MAX}"
    )


def default_daemon_listener_snapshot() -> str:
    result = subprocess.run(
        ["lsof", "-nP", f"-iTCP:{DEFAULT_DAEMON_PORT}", "-sTCP:LISTEN"],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode != 0 or not result.stdout.strip():
        raise LiveResidualFailure(
            f"expected an existing non-harness listener on {DEFAULT_DAEMON_PORT}; lsof returned {result.returncode}"
        )
    return result.stdout.strip()


def assert_default_daemon_listener_unchanged(before: str) -> None:
    after = default_daemon_listener_snapshot()
    if after != before:
        raise LiveResidualFailure(
            f"default daemon port {DEFAULT_DAEMON_PORT} listener changed during residual run\n"
            f"before:\n{before}\n\nafter:\n{after}"
        )


def run(
    args: list[str],
    *,
    cwd: Path = ROOT,
    env: dict[str, str] | None = None,
    timeout: float = 30,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        args,
        cwd=str(cwd),
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
        check=False,
    )
    if check and result.returncode != 0:
        raise LiveResidualFailure(
            f"command failed ({result.returncode}): {' '.join(args)}\n"
            f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )
    return result


def terminate_process(proc: subprocess.Popen[Any]) -> None:
    if proc.poll() is not None:
        return
    try:
        proc.terminate()
        proc.wait(timeout=3)
        return
    except subprocess.TimeoutExpired:
        pass
    try:
        proc.kill()
        proc.wait(timeout=3)
    except Exception:
        pass


def terminate_pid(pid: int) -> None:
    if pid <= 0:
        return
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        if not pid_is_alive(pid):
            return
        time.sleep(0.05)
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        return
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        if not pid_is_alive(pid):
            return
        time.sleep(0.05)
    try:
        os.kill(pid, signal.SIGKILL)
    except OSError:
        pass


def pid_is_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def build_aimux(args: argparse.Namespace) -> Path:
    if args.aimux_bin:
        aimux_bin = Path(args.aimux_bin).resolve()
        if not aimux_bin.exists():
            raise LiveResidualFailure(f"--aimux-bin does not exist: {aimux_bin}")
        return aimux_bin
    target_dir = Path(os.environ.get("CARGO_TARGET_DIR", DEFAULT_TARGET_DIR))
    env = os.environ.copy()
    env["CARGO_TARGET_DIR"] = str(target_dir)
    if not args.skip_build:
        run(
            ["cargo", "build", "--manifest-path", "native/Cargo.toml", "-p", "aimux", "--bin", "aimux"],
            env=env,
            timeout=180,
        )
    aimux_bin = target_dir / "debug" / "aimux"
    if not aimux_bin.exists():
        raise LiveResidualFailure(f"native binary not found after build: {aimux_bin}")
    return aimux_bin


def find_tmux(*, required: bool = True) -> str | None:
    for candidate in [shutil.which("tmux"), "/opt/homebrew/bin/tmux", "/usr/local/bin/tmux"]:
        if candidate and Path(candidate).exists():
            return str(candidate)
    if required:
        raise LiveResidualFailure("tmux is required for phase8-live-tmux-smoke")
    return None


def wait_until(predicate: Any, *, timeout: float, interval: float = 0.05, label: str) -> Any:
    deadline = time.monotonic() + timeout
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            value = predicate()
            if value:
                return value
        except Exception as error:  # keep polling until timeout
            last_error = error
        time.sleep(interval)
    suffix = f": {last_error}" if last_error else ""
    raise LiveResidualFailure(f"timed out waiting for {label}{suffix}")


def run_tmux_live_smoke(aimux_bin: Path, mutation: str | None) -> dict[str, Any]:
    tmux = find_tmux()
    with Scope("tmux", aimux_bin) as scope:
        socket_name = f"aimux-phase8-{os.getpid()}-{time.time_ns()}"
        scope.tmux_socket_name = socket_name
        session = "phase8-live"
        marker_a = f"alpha-{time.time_ns()}"
        marker_b = f"beta-{time.time_ns()}"
        command = (
            "printf 'READY\\n'; "
            "while IFS= read -r line; do printf 'ECHO:%s\\n' \"$line\"; done"
        )
        tmux_cmd(scope, ["-f", "/dev/null", "new-session", "-d", "-s", session, "-x", "80", "-y", "24", "sh", "-lc", command])
        wait_until(lambda: "READY" in capture_tmux(scope, session), timeout=5, label="tmux READY output")
        tmux_cmd(scope, ["send-keys", "-t", f"{session}:0", marker_a, "Enter"])
        if mutation != "tmux-drop-output":
            tmux_cmd(scope, ["send-keys", "-t", f"{session}:0", marker_b, "Enter"])
        output = wait_until(
            lambda: capture_tmux(scope, session) if marker_b in capture_tmux(scope, session) else None,
            timeout=5,
            label="tmux echoed markers",
        )
        if output.index(f"ECHO:{marker_a}") > output.index(f"ECHO:{marker_b}"):
            raise LiveResidualFailure("tmux output order regressed: beta appeared before alpha")
        resize = ["101", "31"] if mutation == "tmux-wrong-resize" else ["100", "30"]
        tmux_cmd(scope, ["resize-window", "-t", f"{session}:0", "-x", resize[0], "-y", resize[1]])
        size = tmux_cmd(scope, ["display-message", "-p", "-t", f"{session}:0", "#{window_width}x#{window_height}"]).stdout.strip()
        if size != "100x30":
            raise LiveResidualFailure(f"tmux resize did not settle to 100x30, got {size!r}")
        return {
            "name": "phase8-live-tmux-smoke",
            "privateSocket": socket_name,
            "caught": [
                "PTY output buffering",
                "send-keys delivery",
                "pane output ordering",
                "window resize propagation",
            ],
            "notCaught": [
                "real user terminal attach/detach focus behavior",
                "long-running pane output under sustained load",
            ],
        }


def run_dashboard_render_smoke(aimux_bin: Path, mutation: str | None) -> dict[str, Any]:
    tmux = find_tmux()
    with Scope("dashboard", aimux_bin) as scope:
        scope.init_git_project()
        seed_initial_commit(scope)
        project_root = scope.project.resolve()
        run([str(aimux_bin), "init"], cwd=scope.project, env=scope.env, timeout=30)
        run([str(aimux_bin), "ps", "--json"], cwd=scope.project, env=scope.env, timeout=30)
        endpoint = wait_for_project_service_endpoint(scope)
        health = http_json(endpoint, "GET", "/health")
        if health.get("ok") is not True:
            raise LiveResidualFailure(f"project-service health failed: {health}")

        socket_name = f"aimux-dashboard-{os.getpid()}-{time.time_ns()}"
        scope.tmux_socket_name = socket_name
        install_tmux_socket_wrapper(scope, tmux, socket_name)
        session = "phase8-dashboard"
        dashboard_command = (
            f"cd {shlex.quote(str(project_root))} && "
            f"{shlex.quote(str(aimux_bin))} __dashboard-internal-native "
            f"--project-root {shlex.quote(str(project_root))}"
        )
        command = f"{dashboard_command}; code=$?; printf '\\n__AIMUX_DASHBOARD_EXIT:%s\\n' \"$code\"; sleep 30"
        tmux_cmd(scope, [
            "-f",
            "/dev/null",
            "new-session",
            "-d",
            "-s",
            session,
            "-x",
            "80",
            "-y",
            "24",
            "sh",
            "-lc",
            command,
        ])
        required = "agent multiplexer"
        if mutation == "dashboard-empty-frame":
            required = "phase8-dashboard-mutation-never-present"
        output = ""
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            try:
                output = capture_tmux(scope, session)
            except LiveResidualFailure:
                output = ""
            if required in output:
                break
            if "__AIMUX_DASHBOARD_EXIT:" in output:
                break
            time.sleep(0.05)
        else:
            raise LiveResidualFailure(f"timed out waiting for native dashboard first frame:\n{output}")
        if required not in output:
            raise LiveResidualFailure(f"dashboard did not render required content:\n{output}")
        if "Main Checkout" not in output or "worktrees" not in output:
            raise LiveResidualFailure(f"dashboard frame missing project row or navigation hints:\n{output}")
        _client_proc, client_fd = start_tmux_capture_client(
            scope,
            tmux,
            socket_name,
            ["-f", "/dev/null", "attach-session", "-t", f"{session}:0"],
            cwd=project_root,
            cols=80,
            rows=24,
        )
        wait_until(
            lambda: (
                clients
                if (clients := tmux_cmd_for_socket(tmux, socket_name, ["list-clients"]).stdout.strip()
                )
                else None
            ),
            timeout=5,
            label="dashboard render attached tmux client",
        )
        dashboard_pane_id = tmux_cmd(scope, [
            "display-message",
            "-p",
            "-t",
            f"{session}:0",
            "#{pane_id}",
        ]).stdout.strip()
        if not dashboard_pane_id:
            raise LiveResidualFailure("dashboard render smoke could not resolve dashboard pane id")
        for cols, rows in [(120, 30), (200, 50)]:
            drain_fd_now(client_fd)
            set_pty_size(client_fd, cols, rows)
            os.kill(_client_proc.pid, signal.SIGWINCH)
            tmux_cmd(scope, ["resize-window", "-t", dashboard_pane_id, "-x", str(cols), "-y", str(rows)])
            tmux_cmd(scope, ["resize-pane", "-t", dashboard_pane_id, "-x", str(cols), "-y", str(rows)])
            wait_until(
                lambda: (
                    size
                    if (size := tmux_cmd(scope, [
                        "display-message",
                        "-p",
                        "-t",
                        dashboard_pane_id,
                        "#{pane_width}x#{pane_height}",
                    ]).stdout.strip()) == f"{cols}x{rows}"
                    else None
                ),
                timeout=5,
                label=f"dashboard resize reaches {cols}x{rows}",
            )
            frame = ""
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                frame = capture_tmux(scope, session)
                if (
                    "agent multiplexer" in frame
                    and "↑↓/jk" in frame
                    and frame_reaches_width(frame, cols)
                ):
                    break
                time.sleep(0.05)
            else:
                pane_state = tmux_cmd(scope, [
                    "display-message",
                    "-p",
                    "-t",
                    dashboard_pane_id,
                    "#{pane_width}x#{pane_height}\t#{window_width}x#{window_height}\t#{session_attached}\t#{window_active}\t#{pane_current_command}\t#{pane_dead}",
                ]).stdout.strip()
                max_width = max((len(strip_ansi(line)) for line in frame.splitlines()), default=0)
                raise LiveResidualFailure(
                    "dashboard did not repaint after resize without input:\n"
                    + json.dumps({
                        "target": f"{cols}x{rows}",
                        "paneState": pane_state,
                        "maxVisibleLineWidth": max_width,
                        "hasHeader": "agent multiplexer" in frame,
                        "hasFooter": "↑↓/jk" in frame,
                        "frame": frame,
                    }, indent=2)
                )
            allowed_width = cols - 1 if mutation == "dashboard-resize-width-overflow" else cols
            assert_frame_width(frame, allowed_width, f"dashboard resize {cols}x{rows}")
            assert_frame_reaches_width(frame, cols, f"dashboard resize {cols}x{rows}")
        terminate_process(_client_proc)

        def exercise_key(
            key_session: str,
            key: str,
            label: str,
            anchor: str | None,
            reset_key: str = "Escape",
        ) -> None:
            key_command = (
                f"cd {shlex.quote(str(project_root))} && {shlex.quote(str(aimux_bin))}; code=$?; "
                f"printf '\\n__AIMUX_DASHBOARD_{key_session}_EXIT:%s\\n' \"$code\"; sleep 30"
            )
            proc = subprocess.Popen(
                [
                    "script",
                    "-q",
                    "/dev/null",
                    tmux,
                    "-L",
                    socket_name,
                    "-f",
                    "/dev/null",
                    "new-session",
                    "-s",
                    key_session,
                    "-x",
                    "100",
                    "-y",
                    "30",
                    "sh",
                    "-lc",
                    key_command,
                ],
                cwd=str(project_root),
                env=scope.env,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            scope.procs.append(proc)
            before = wait_until(
                lambda: capture_tmux(scope, key_session)
                if required in capture_tmux(scope, key_session)
                else None,
                timeout=10,
                label=f"{label} dashboard frame",
            )
            time.sleep(1.0)
            if mutation != "dashboard-input-dead":
                tmux_cmd(scope, ["send-keys", "-t", f"{key_session}:0", key])
            after = ""
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                after = capture_tmux(scope, key_session)
                if after != before and (anchor is None or anchor in after) and after.strip():
                    break
                time.sleep(0.05)
            else:
                pane_state = tmux_cmd(scope, [
                    "display-message",
                    "-p",
                    "-t",
                    f"{key_session}:0",
                    "#{pane_width}x#{pane_height}\t#{session_attached}\t#{window_active}\t#{pane_current_command}\t#{pane_dead}",
                ]).stdout.strip()
                raise LiveResidualFailure(
                    f"{label} key did not change dashboard frame:\n"
                    + json.dumps({
                        "key": key,
                        "anchor": anchor,
                        "paneState": pane_state,
                        "before": before[-2000:],
                        "after": after[-2000:],
                    }, indent=2)
                )
            if anchor is not None and anchor not in after:
                raise LiveResidualFailure(
                    f"{label} key changed frame without expected anchor {anchor!r}:\n{after}"
                )
            tmux_cmd(scope, ["send-keys", "-t", f"{key_session}:0", reset_key])
            wait_until(
                lambda: (
                    current
                    if required in (current := capture_tmux(scope, key_session))
                    and current != after
                    else None
                ),
                timeout=5,
                label=f"{label} key returned to dashboard before quit",
            )
            tmux_cmd(scope, ["send-keys", "-t", f"{key_session}:0", "q"])
            final_output = ""
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                final_output = capture_tmux(scope, key_session)
                if f"__AIMUX_DASHBOARD_{key_session}_EXIT:0" in final_output:
                    return
                time.sleep(0.05)
            raise LiveResidualFailure(f"{label} dashboard did not accept q after input:\n{final_output}")

        key_specs = [
            ("?", "help", "— help", "Escape"),
            ("n", "new-agent", "SELECT TOOL", "Escape"),
            ("w", "worktree-create", "CREATE WORKTREE", "Escape"),
            ("v", "service-create", "CREATE SERVICE", "Escape"),
            ("Tab", "details-toggle", None, "Tab"),
            ("c", "coordination-screen", "— coordination", "Escape"),
            ("p", "project-screen", "— project", "Escape"),
            ("L", "library-screen", "— library", "Escape"),
            ("t", "topology-screen", "— topology", "Escape"),
            ("g", "graveyard-screen", "— graveyard", "Escape"),
            ("a", "hide-offline-toggle", "Offline agents hidden", "a"),
        ]
        if mutation == "dashboard-input-dead":
            key_specs = key_specs[:1]
        for index, (key, label, anchor, reset_key) in enumerate(key_specs, start=1):
            exercise_key(f"phase8-dashboard-key-{index}", key, label, anchor, reset_key)
        return {
            "name": "phase8-live-dashboard-render-smoke",
            "privateSocket": socket_name,
            "caught": [
                "native dashboard first paint reaching a real tmux pane",
                "advertised native dashboard keys visibly repaint the TUI",
                "native dashboard quit works after non-quit input",
                "native dashboard repaints to the current tmux size without input after resize",
                "blank alternate-screen dashboard startup",
                "daemon/project-service backed dashboard snapshot rendering",
            ],
            "notCaught": [
                "user terminal attach handoff outside the private socket",
                "long-running visibility transitions after first paint",
            ],
        }


def run_dashboard_attach_smoke(aimux_bin: Path, mutation: str | None) -> dict[str, Any]:
    tmux = find_tmux()
    with Scope("dashboard-attach", aimux_bin) as scope:
        socket_name = f"aimux-attach-{os.getpid()}-{time.time_ns()}"
        scope.tmux_socket_name = socket_name
        install_tmux_socket_wrapper(scope, tmux, socket_name)
        run([tmux, "-L", socket_name, "kill-server"], env=without_tmux(os.environ.copy()), timeout=10, check=False)
        scope.init_git_project()
        run([str(aimux_bin), "init"], cwd=scope.project, env=scope.env, timeout=30)
        install_shell_tool_config(scope)
        shell_targets = []
        for _ in range(2):
            spawned = run(
                [str(aimux_bin), "spawn", "--tool", "shell", "--no-open", "--json"],
                cwd=scope.project,
                env=scope.env,
                timeout=30,
            )
            spawn_payload = parse_json_stdout(spawned.stdout, "dashboard attach shell spawn")
            target = spawn_payload.get("tmuxTarget")
            if not isinstance(target, dict):
                raise LiveResidualFailure(f"dashboard attach spawn did not return a tmuxTarget: {spawn_payload}")
            shell_targets.append(target)
        first_target = shell_targets[0]
        second_target = shell_targets[1]
        shell_window_id = str(first_target.get("windowId") or "")
        shell_window_name = str(first_target.get("windowName") or "")
        second_shell_window_id = str(second_target.get("windowId") or "")
        second_shell_window_name = str(second_target.get("windowName") or "")
        host_session_name = str(first_target.get("sessionName") or "")
        if (
            not shell_window_id
            or not shell_window_name
            or not second_shell_window_id
            or not second_shell_window_name
            or not host_session_name
        ):
            raise LiveResidualFailure(f"dashboard attach spawn returned incomplete targets: {shell_targets}")
        run([str(aimux_bin), "dashboard-reload"], cwd=scope.project, env=scope.env, timeout=30)
        session = "phase8-attach"
        project_root = scope.project.resolve()
        proc, client_fd = start_tmux_capture_client(
            scope,
            tmux,
            socket_name,
            [
                "-f",
                "/dev/null",
                "attach-session",
                "-t",
                f"{host_session_name}:0",
            ],
            cwd=project_root,
            cols=120,
            rows=30,
        )
        output = ""
        deadline = time.monotonic() + 35
        while time.monotonic() < deadline:
            try:
                output = capture_all_tmux(scope)
            except LiveResidualFailure:
                output = ""
            if mutation == "dashboard-attach-terminal-error":
                output += "\ncannot attach to tmux session phase8-mutation without a terminal"
            if "cannot attach to tmux session" in output:
                raise LiveResidualFailure(f"bare aimux refused terminal attach:\n{output}")
            if "agent multiplexer" in output or "Main Checkout" in output:
                break
            time.sleep(0.05)
        else:
            terminate_process(proc)
            raise LiveResidualFailure(
                "timed out waiting for managed dashboard attach:\n"
                f"{output}\nclient:\n{drain_fd_now(client_fd)}"
            )

        def attached_client_rows() -> list[dict[str, str]]:
            raw = tmux_cmd_for_socket(
                tmux,
                socket_name,
                [
                    "list-clients",
                    "-F",
                    "#{client_tty}\t#{session_name}\t#{window_id}\t#{window_name}\t#{client_name}\t#{client_width}\t#{client_height}",
                ],
            ).stdout
            rows = []
            for line in raw.splitlines():
                fields = line.split("\t")
                if len(fields) == 7:
                    rows.append({
                        "tty": fields[0],
                        "session": fields[1],
                        "windowId": fields[2],
                        "windowName": fields[3],
                        "name": fields[4],
                        "width": fields[5],
                        "height": fields[6],
                    })
            return rows

        client = wait_until(
            lambda: (rows[0] if (rows := attached_client_rows()) else None),
            timeout=5,
            label="dashboard attach tmux client",
        )
        client_tty = client["tty"]
        client_name = client["name"]

        def write_client_keys(*chunks: bytes) -> None:
            for chunk in chunks:
                os.write(client_fd, chunk)
                time.sleep(0.05)

        write_client_keys(b"\r")
        selection_frame = None
        selection_deadline = time.monotonic() + 5
        while time.monotonic() < selection_deadline:
            current = capture_all_tmux(scope)
            if any(marker in current for marker in ["▸ ●", "▸ ◆", "▸ ◇", "> ●", "> ◆", "> ◇"]):
                selection_frame = current
                break
            time.sleep(0.05)
        if selection_frame is None:
            raise LiveResidualFailure(
                "timed out waiting for dashboard attach session selection:\n"
                + json.dumps({
                    "client": client,
                    "clients": attached_client_rows(),
                    "capture": capture_all_tmux(scope)[-2000:],
                }, indent=2)
            )
        focused_dashboard = next(
            (item for item in attached_client_rows() if item["tty"] == client_tty),
            client,
        )
        write_client_keys(b"\r")
        focused = None
        focus_deadline = time.monotonic() + 8
        while time.monotonic() < focus_deadline:
            focused = next(
                (
                    item
                    for item in attached_client_rows()
                    if item["tty"] == client_tty
                    and (
                        item["windowId"] == "@phase8-attach-mutation-missing"
                        if mutation == "dashboard-attach-focus-target-missing"
                        else item["windowId"] in {shell_window_id, second_shell_window_id}
                    )
                ),
                None,
            )
            if focused:
                break
            time.sleep(0.05)
        if not focused:
            raise LiveResidualFailure(
                "timed out waiting for dashboard attach focus handoff to selected session:\n"
                + json.dumps({
                    "expectedTarget": target,
                    "clientTty": client_tty,
                    "clients": attached_client_rows(),
                    "capture": capture_all_tmux(scope)[-2000:],
                }, indent=2)
            )
        if focused["windowName"] not in {shell_window_name, second_shell_window_name}:
            raise LiveResidualFailure(
                "dashboard attach focused the wrong target:\n"
                + json.dumps({"expected": shell_targets, "focused": focused}, indent=2)
            )

        project_state_dirs = sorted((scope.aimux_home / "projects").glob("*"))
        if not project_state_dirs:
            raise LiveResidualFailure("dashboard attach could not find project state dir")
        if mutation != "dashboard-attach-return-missing":
            os.write(client_fd, b"\x01")
            time.sleep(0.05)
            os.write(client_fd, b"d")
        expected_dashboard_name = (
            "phase8-attach-mutation-missing"
            if mutation == "dashboard-attach-return-missing"
            else "dashboard"
        )
        dashboard_client = None
        return_deadline = time.monotonic() + 8
        while time.monotonic() < return_deadline:
            dashboard_client = next(
                (
                    item
                    for item in attached_client_rows()
                    if item["tty"] == client_tty and item["windowName"] == expected_dashboard_name
                ),
                None,
            )
            if dashboard_client:
                break
            time.sleep(0.05)
        if not dashboard_client:
            metadata_api = (project_state_dirs[0] / "metadata-api.txt").read_text().strip()
            probe_body = json.dumps({
                "focus": True,
                "forceReload": True,
                "clientTty": client_tty,
                "currentClientSession": focused["session"],
                "currentWindowId": focused["windowId"],
            })
            api_probe = run(
                [
                    "curl",
                    "-sS",
                    "--max-time",
                    "8",
                    "-H",
                    "content-type: application/json",
                    "--data-binary",
                    probe_body,
                    f"{metadata_api.rstrip('/')}/control/open-dashboard",
                ],
                env=scope.env,
                timeout=10,
                check=False,
            )
            manual_return = tmux_cmd_for_socket(
                tmux,
                socket_name,
                ["switch-client", "-c", client_tty, "-t", f"{focused['session']}:0"],
                check=False,
            )
            debug_log = Path(scope.env.get("TMPDIR", "/tmp")) / "aimux-debug.log"
            raise LiveResidualFailure(
                "timed out waiting for dashboard attach return to dashboard:\n"
                + json.dumps({
                    "clientTty": client_tty,
                    "returnPath": "managed tmux prefix+d key binding",
                    "productKeySent": mutation != "dashboard-attach-return-missing",
                    "manualReturn": {
                        "stdout": manual_return.stdout[-2000:],
                        "stderr": manual_return.stderr[-2000:],
                        "returncode": manual_return.returncode,
                        "clientsAfter": attached_client_rows(),
                    },
                    "apiProbe": {
                        "url": f"{metadata_api.rstrip('/')}/control/open-dashboard",
                        "body": probe_body,
                        "stdout": api_probe.stdout[-2000:],
                        "stderr": api_probe.stderr[-2000:],
                        "returncode": api_probe.returncode,
                    },
                    "clients": attached_client_rows(),
                    "windows": tmux_cmd_for_socket(
                        tmux,
                        socket_name,
                        ["list-windows", "-a", "-F", "#{session_name}\t#{window_id}\t#{window_index}\t#{window_name}"],
                    ).stdout,
                    "debugLog": debug_log.read_text(errors="replace")[-2000:] if debug_log.exists() else "",
                    "capture": capture_all_tmux(scope)[-2000:],
                }, indent=2)
            )
        returned_frame = capture_all_tmux(scope)
        if "agent multiplexer" not in returned_frame or "Main Checkout" not in returned_frame:
            raise LiveResidualFailure(
                "dashboard attach returned to a dashboard window without a complete dashboard frame:\n"
                + json.dumps({
                    "client": dashboard_client,
                    "capture": returned_frame[-2000:],
                }, indent=2)
            )

        write_client_keys(b"\r")
        wait_until(
            lambda: capture_all_tmux(scope)
            if any(marker in capture_all_tmux(scope) for marker in ["▸ ●", "▸ ◆", "▸ ◇", "> ●", "> ◆", "> ◇"])
            else None,
            timeout=5,
            label="dashboard attach returns to session selection for digit entry",
        )
        if mutation != "dashboard-attach-digit-target-missing":
            write_client_keys(b"2")
        expected_digit_window_id = (
            "@phase8-attach-digit-mutation-missing"
            if mutation == "dashboard-attach-digit-target-missing"
            else second_shell_window_id
        )
        digit_focused = wait_until(
            lambda: next(
                (
                    item
                    for item in attached_client_rows()
                    if item["tty"] == client_tty and item["windowId"] == expected_digit_window_id
                ),
                None,
            ),
            timeout=8,
            label="dashboard digit focuses numbered session from attached client",
        )
        if digit_focused["windowName"] != second_shell_window_name:
            raise LiveResidualFailure(
                "dashboard digit focused the wrong target:\n"
                + json.dumps({"expected": second_target, "focused": digit_focused}, indent=2)
            )
        return {
            "name": "phase8-live-dashboard-attach-smoke",
            "privateSocket": socket_name,
            "caught": [
                "managed native TUI renders inside a real tmux client",
                "dashboard Enter focuses the selected managed session from an attached tmux client",
                "managed prefix+d returns the attached client to the dashboard",
                "dashboard digit focuses a numbered session from an attached tmux client",
            ],
            "notCaught": [
                "host-specific terminal emulator behavior outside tmux",
                "native terminal emulator detach key translation outside tmux",
            ],
        }


def run_bare_dashboard_tmux_smoke(aimux_bin: Path, mutation: str | None) -> dict[str, Any]:
    tmux = find_tmux()
    with Scope("bare-dashboard", aimux_bin) as scope:
        socket_name = f"aimux-bare-dashboard-{os.getpid()}-{time.time_ns()}"
        scope.tmux_socket_name = socket_name
        install_tmux_socket_wrapper(scope, tmux, socket_name)
        run([tmux, "-L", socket_name, "kill-server"], env=without_tmux(os.environ.copy()), timeout=10, check=False)
        scope.init_git_project()
        seed_initial_commit(scope)

        proc, client_fd = start_process_capture_client(
            scope,
            [str(aimux_bin)],
            cwd=scope.project.resolve(),
            cols=120,
            rows=30,
        )

        def attached_client_rows() -> list[dict[str, str]]:
            result = tmux_cmd_for_socket(
                tmux,
                socket_name,
                [
                    "list-clients",
                    "-F",
                    "#{client_tty}\t#{session_name}\t#{window_id}\t#{window_name}\t#{client_name}\t#{client_pid}",
                ],
                check=False,
            )
            if result.returncode != 0:
                return []
            rows = []
            for line in result.stdout.splitlines():
                fields = line.split("\t")
                if len(fields) == 6:
                    rows.append({
                        "tty": fields[0],
                        "session": fields[1],
                        "windowId": fields[2],
                        "windowName": fields[3],
                        "name": fields[4],
                        "pid": fields[5],
                    })
            return rows

        def managed_window_debug() -> list[dict[str, str]]:
            def tmux_option(args: list[str]) -> str:
                return tmux_cmd_for_socket(tmux, socket_name, args, check=False).stdout.strip()

            result = tmux_cmd_for_socket(
                tmux,
                socket_name,
                [
                    "list-windows",
                    "-a",
                    "-F",
                    "#{session_name}\t#{window_id}\t#{window_index}\t#{window_name}",
                ],
                check=False,
            )
            rows = []
            for line in result.stdout.splitlines():
                fields = line.split("\t")
                if len(fields) != 4:
                    continue
                session_name, window_id, window_index, window_name = fields
                pane_command = tmux_cmd_for_socket(
                    tmux,
                    socket_name,
                    ["display-message", "-p", "-t", window_id, "#{pane_current_command}"],
                    check=False,
                )
                rows.append({
                    "session": session_name,
                    "windowId": window_id,
                    "windowIndex": window_index,
                    "windowName": window_name,
                    "projectRoot": tmux_option(["show-options", "-v", "-t", session_name, "@aimux-project-root"]),
                    "runtimeOwner": tmux_option(["show-options", "-v", "-t", session_name, "@aimux-runtime-owner"]),
                    "sessionDashboardBuild": tmux_option(["show-options", "-v", "-t", session_name, "@aimux-dashboard-build"]),
                    "dashboardOwner": tmux_option(["show-window-options", "-v", "-t", window_id, "@aimux-dashboard-owner"]),
                    "dashboardReady": tmux_option(["show-window-options", "-v", "-t", window_id, "@aimux-dashboard-ready"]),
                    "dashboardBuild": tmux_option(["show-window-options", "-v", "-t", window_id, "@aimux-dashboard-build"]),
                    "paneCommand": pane_command.stdout.strip(),
                    "paneCommandError": pane_command.stderr,
                })
            return rows

        expected_window_name = "phase8-missing-dashboard" if mutation == "bare-dashboard-inline" else "dashboard"
        dashboard_client = None
        raw_output = ""
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            raw_output += drain_fd_now(client_fd)
            dashboard_client = next(
                (
                    item
                    for item in attached_client_rows()
                    if item["windowName"] == expected_window_name
                ),
                None,
            )
            if dashboard_client:
                break
            time.sleep(0.05)
        if not dashboard_client:
            sessions = tmux_cmd_for_socket(
                tmux,
                socket_name,
                ["list-sessions", "-F", "#{session_name}\t#{session_windows}"],
                check=False,
            )
            windows = tmux_cmd_for_socket(
                tmux,
                socket_name,
                ["list-windows", "-a", "-F", "#{session_name}\t#{window_id}\t#{window_index}\t#{window_name}"],
                check=False,
            )
            clients = tmux_cmd_for_socket(
                tmux,
                socket_name,
                ["list-clients", "-F", "#{client_tty}\t#{session_name}\t#{window_id}\t#{window_name}\t#{client_name}"],
                check=False,
            )
            raise LiveResidualFailure(
                "timed out waiting for bare aimux to attach a tmux dashboard client:\n"
                + json.dumps({
                    "returncode": proc.poll(),
                    "expectedWindowName": expected_window_name,
                    "stdout": raw_output[-2000:],
                    "sessions": sessions.stdout[-2000:],
                    "sessionError": sessions.stderr[-1000:],
                    "windows": windows.stdout[-2000:],
                    "windowError": windows.stderr[-1000:],
                    "clients": clients.stdout[-2000:],
                    "clientError": clients.stderr[-1000:],
                }, indent=2)
            )
        output = drain_fd_now(client_fd)
        if "agent multiplexer" in output and not attached_client_rows():
            raise LiveResidualFailure(f"bare aimux rendered inline instead of attaching tmux:\n{output[-2000:]}")
        if proc.poll() is not None:
            raise LiveResidualFailure(
                "bare aimux exited before holding an attached tmux client:\n"
                + json.dumps({
                    "returncode": proc.returncode,
                    "client": dashboard_client,
                    "output": output[-2000:],
                }, indent=2)
            )
        wait_until(
            lambda: tmux_cmd_for_socket(
                tmux,
                socket_name,
                ["show-window-options", "-v", "-t", dashboard_client["windowId"], "@aimux-dashboard-ready"],
                check=False,
            ).stdout.strip(),
            timeout=15,
            label="bare aimux dashboard window ready stamp",
        )
        user_session = "phase8-user-shell"
        seed_tmux_socket_environment(tmux, socket_name, scope)
        same_socket_go = scope.tmp / "same-socket-go"
        same_socket_log = scope.tmp / "same-socket-aimux.log"
        private_aimux_env = " ".join(
            f"{key}={shlex.quote(value)}"
            for key in TMUX_SESSION_ENV_KEYS
            if (value := scope.env.get(key))
        )
        same_socket_shell_command = (
            "sh"
            if mutation == "bare-dashboard-inline"
            else (
                "sh -lc "
                + shlex.quote(
                    f"while [ ! -f {shlex.quote(str(same_socket_go))} ]; do sleep 0.05; done; "
                    f"exec env {private_aimux_env} {shlex.quote(str(aimux_bin))} > {shlex.quote(str(same_socket_log))} 2>&1"
                )
            )
        )
        tmux_cmd_for_socket(
            tmux,
            socket_name,
            [
                "new-session",
                "-d",
                "-s",
                user_session,
                "-c",
                str(scope.project.resolve()),
                same_socket_shell_command,
            ],
        )
        inside_proc, inside_fd = start_tmux_capture_client(
            scope,
            tmux,
            socket_name,
            [
                "-f",
                "/dev/null",
                "attach-session",
                "-t",
                user_session,
            ],
            cwd=scope.project.resolve(),
            cols=120,
            rows=30,
        )
        inside_client = wait_until(
            lambda: next(
                (
                    item
                    for item in attached_client_rows()
                    if item["session"] == user_session
                ),
                None,
            ),
            timeout=5,
            label="bare aimux inside tmux attached shell client",
        )
        same_socket_go.write_text("go\n")
        inside_dashboard_client = None
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            inside_dashboard_client = next(
                (
                    item
                    for item in attached_client_rows()
                    if item["tty"] == inside_client["tty"] and item["windowName"] == expected_window_name
                ),
                None,
            )
            if inside_dashboard_client:
                break
            time.sleep(0.05)
        if not inside_dashboard_client:
            windows = tmux_cmd_for_socket(
                tmux,
                socket_name,
                ["list-windows", "-a", "-F", "#{session_name}\t#{window_id}\t#{window_index}\t#{window_name}"],
                check=False,
            )
            clients = tmux_cmd_for_socket(
                tmux,
                socket_name,
                ["list-clients", "-F", "#{client_tty}\t#{session_name}\t#{window_id}\t#{window_name}\t#{client_name}"],
                check=False,
            )
            raise LiveResidualFailure(
                "timed out waiting for bare aimux inside tmux to switch client to dashboard:\n"
                + json.dumps({
                    "insideClient": inside_client,
                    "insideOutput": drain_fd_now(inside_fd)[-2000:],
                    "managedWindows": windows.stdout[-2000:],
                    "managedClients": clients.stdout[-2000:],
                    "managedClientError": clients.stderr[-1000:],
                    "managedWindowDebug": managed_window_debug(),
                    "aimuxLog": same_socket_log.read_text(errors="replace")[-2000:]
                    if same_socket_log.exists()
                    else "",
                    "insideProcess": inside_proc.poll(),
                }, indent=2)
            )
        if inside_dashboard_client["session"] == user_session:
            raise LiveResidualFailure(
                "bare aimux inside tmux stayed in the launching shell session:\n"
                + json.dumps({
                    "client": inside_dashboard_client,
                    "output": drain_fd_now(inside_fd)[-2000:],
                    "clients": attached_client_rows(),
                }, indent=2)
            )
        tmux_cmd_for_socket(tmux, socket_name, ["detach-client", "-t", inside_client["tty"]], check=False)
        terminate_process(inside_proc)
        wait_until(
            lambda: not any(item["tty"] == inside_client["tty"] for item in attached_client_rows()),
            timeout=5,
            label="bare aimux same-socket dashboard client detached before cross-socket case",
        )

        tmux_cmd_for_socket(tmux, socket_name, ["detach-client", "-t", dashboard_client["tty"]], check=False)
        terminate_process(proc)
        wait_until(
            lambda: not any(item["tty"] == dashboard_client["tty"] for item in attached_client_rows()),
            timeout=5,
            label="bare aimux initial dashboard client detached before cross-socket case",
        )
        existing_dashboard_client_pids: set[str] = set()
        outer_socket_name = f"{socket_name}-outer"
        scope.extra_tmux_socket_names.append(outer_socket_name)
        run([tmux, "-L", outer_socket_name, "kill-server"], env=without_tmux(os.environ.copy()), timeout=10, check=False)
        outer_session = "phase8-outer-shell"
        seed_tmux_socket_environment(tmux, outer_socket_name, scope)
        outer_socket_go = scope.tmp / "outer-socket-go"
        outer_socket_log = scope.tmp / "outer-socket-aimux.log"
        outer_socket_shell_command = (
            "sh"
            if mutation == "bare-dashboard-inline"
            else (
                "sh -lc "
                + shlex.quote(
                    f"while [ ! -f {shlex.quote(str(outer_socket_go))} ]; do sleep 0.05; done; "
                    f"exec env {private_aimux_env} {shlex.quote(str(aimux_bin))}"
                )
            )
        )
        tmux_cmd_for_socket(
            tmux,
            outer_socket_name,
            [
                "new-session",
                "-d",
                "-s",
                outer_session,
                "-c",
                str(scope.project.resolve()),
                outer_socket_shell_command,
            ],
        )

        def outer_attached_client_rows() -> list[dict[str, str]]:
            result = tmux_cmd_for_socket(
                tmux,
                outer_socket_name,
                [
                    "list-clients",
                    "-F",
                    "#{client_tty}\t#{session_name}\t#{window_id}\t#{window_name}\t#{client_name}",
                ],
                check=False,
            )
            if result.returncode != 0:
                return []
            rows = []
            for line in result.stdout.splitlines():
                fields = line.split("\t")
                if len(fields) == 5:
                    rows.append({
                        "tty": fields[0],
                        "session": fields[1],
                        "windowId": fields[2],
                        "windowName": fields[3],
                        "name": fields[4],
                    })
            return rows

        outer_proc, outer_fd = start_tmux_capture_client(
            scope,
            tmux,
            outer_socket_name,
            [
                "-f",
                "/dev/null",
                "attach-session",
                "-t",
                outer_session,
            ],
            cwd=scope.project.resolve(),
            cols=120,
            rows=30,
        )
        wait_until(
            lambda: next(
                (
                    item
                    for item in outer_attached_client_rows()
                    if item["session"] == outer_session
                ),
                None,
            ),
            timeout=5,
            label="bare aimux attached outer tmux shell client on a different socket",
        )
        outer_socket_go.write_text("go\n")
        cross_socket_dashboard_client = None
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            cross_socket_dashboard_client = next(
                (
                    item
                    for item in attached_client_rows()
                    if item["windowName"] == expected_window_name
                    and item["pid"] not in existing_dashboard_client_pids
                ),
                None,
            )
            if cross_socket_dashboard_client:
                break
            time.sleep(0.05)
        if not cross_socket_dashboard_client:
            windows = tmux_cmd_for_socket(
                tmux,
                socket_name,
                ["list-windows", "-a", "-F", "#{session_name}\t#{window_id}\t#{window_index}\t#{window_name}"],
                check=False,
            )
            clients = tmux_cmd_for_socket(
                tmux,
                socket_name,
                ["list-clients", "-F", "#{client_tty}\t#{session_name}\t#{window_id}\t#{window_name}\t#{client_name}"],
                check=False,
            )
            outer_clients = tmux_cmd_for_socket(
                tmux,
                outer_socket_name,
                ["list-clients", "-F", "#{client_tty}\t#{session_name}\t#{window_id}\t#{window_name}\t#{client_name}"],
                check=False,
            )
            raise LiveResidualFailure(
                "timed out waiting for bare aimux inside a different tmux socket to attach the managed dashboard:\n"
                + json.dumps({
                    "outerOutput": drain_fd_now(outer_fd)[-2000:],
                    "managedWindows": windows.stdout[-2000:],
                    "managedClients": clients.stdout[-2000:],
                    "managedClientRows": attached_client_rows(),
                    "existingDashboardClientPids": sorted(existing_dashboard_client_pids),
                    "managedClientError": clients.stderr[-1000:],
                    "outerClients": outer_clients.stdout[-2000:],
                    "outerClientError": outer_clients.stderr[-1000:],
                    "aimuxLog": outer_socket_log.read_text(errors="replace")[-2000:]
                    if outer_socket_log.exists()
                    else "",
                    "outerProcess": outer_proc.poll(),
                }, indent=2)
            )
        outer_output = drain_fd_now(outer_fd)
        if "switch-client" in outer_output or "no current client" in outer_output:
            raise LiveResidualFailure(
                "bare aimux inside a different tmux socket tried switch-client instead of attach:\n"
                + outer_output[-2000:]
            )
        tmux_cmd_for_socket(tmux, socket_name, ["detach-client", "-t", cross_socket_dashboard_client["tty"]], check=False)
        tmux_cmd_for_socket(tmux, outer_socket_name, ["detach-client"], check=False)
        terminate_process(outer_proc)
        return {
            "name": "phase8-live-bare-dashboard-tmux-smoke",
            "privateSocket": socket_name,
            "caught": [
                "bare aimux opens the managed tmux dashboard instead of rendering inline",
                "fresh git repo dashboard mode initializes and attaches a real tmux client",
                "dashboard window is active after bare aimux",
                "bare aimux inside an existing tmux client switches to the dashboard",
                "bare aimux inside a tmux client on a different socket attaches the managed dashboard",
            ],
            "notCaught": [
                "host terminal emulator behavior outside the private PTY",
                "manual mosh transport quirks outside tmux's attached client state",
            ],
        }


def run_daily_loop_smoke(aimux_bin: Path, mutation: str | None) -> dict[str, Any]:
    tmux = find_tmux()
    with Scope("daily-loop", aimux_bin) as scope:
        socket_name = f"aimux-daily-loop-{os.getpid()}-{time.time_ns()}"
        scope.tmux_socket_name = socket_name
        install_tmux_socket_wrapper(scope, tmux, socket_name)
        run([tmux, "-L", socket_name, "kill-server"], env=without_tmux(os.environ.copy()), timeout=10, check=False)
        scope.init_git_project()
        seed_initial_commit(scope)
        run([str(aimux_bin), "init"], cwd=scope.project, env=scope.env, timeout=30)
        install_agent_tool_config(scope, "claude")
        install_agent_tool_config(scope, "codex")
        install_agent_tool_config(scope, "aider")
        project_root = scope.project.resolve()

        proc, client_fd = start_process_capture_client(
            scope,
            [str(aimux_bin)],
            cwd=project_root,
            cols=120,
            rows=30,
        )

        def attached_client_rows() -> list[dict[str, str]]:
            result = tmux_cmd_for_socket(
                tmux,
                socket_name,
                [
                    "list-clients",
                    "-F",
                    "#{client_tty}\t#{session_name}\t#{window_id}\t#{window_name}\t#{client_name}\t#{client_pid}\t#{client_width}\t#{client_height}",
                ],
                check=False,
            )
            if result.returncode != 0:
                return []
            rows = []
            for line in result.stdout.splitlines():
                fields = line.split("\t")
                if len(fields) == 8:
                    rows.append({
                        "tty": fields[0],
                        "session": fields[1],
                        "windowId": fields[2],
                        "windowName": fields[3],
                        "name": fields[4],
                        "pid": fields[5],
                        "width": fields[6],
                        "height": fields[7],
                    })
            return rows

        def client_for_tty(client_tty: str) -> dict[str, str] | None:
            return next((item for item in attached_client_rows() if item["tty"] == client_tty), None)

        def capture_client_window() -> str:
            item = client_for_tty(client_tty)
            if not item:
                return ""
            result = tmux_cmd_for_socket(
                tmux,
                socket_name,
                ["capture-pane", "-p", "-J", "-t", item["windowId"]],
                check=False,
            )
            return result.stdout if result.returncode == 0 else ""

        def write_client_keys(*chunks: bytes) -> None:
            for chunk in chunks:
                os.write(client_fd, chunk)
                time.sleep(0.05)

        def wait_dashboard(label: str, timeout: float = 10) -> str:
            return wait_until(
                lambda: (
                    frame
                    if "agent multiplexer" in (frame := capture_client_window())
                    and "Main Checkout" in frame
                    else None
                ),
                timeout=timeout,
                label=label,
            )

        def wait_client_dashboard(label: str, timeout: float = 8) -> dict[str, str]:
            return wait_until(
                lambda: (
                    item
                    if (item := client_for_tty(client_tty))
                    and item["windowName"] == "dashboard"
                    else None
                ),
                timeout=timeout,
                label=label,
            )

        dashboard_client = wait_until(
            lambda: next(
                (
                    item
                    for item in attached_client_rows()
                    if item["windowName"] == "dashboard"
                ),
                None,
            ),
            timeout=90,
            label="daily loop bare aimux attaches managed dashboard",
        )
        client_tty = dashboard_client["tty"]
        wait_dashboard("daily loop initial dashboard frame")
        inline_output = drain_fd_now(client_fd)
        if "agent multiplexer" in inline_output and not attached_client_rows():
            raise LiveResidualFailure(f"daily loop rendered dashboard inline:\n{inline_output[-2000:]}")
        if proc.poll() is not None:
            raise LiveResidualFailure(
                "daily loop bare aimux did not hold a real attached tmux client:\n"
                + json.dumps({"returncode": proc.returncode, "output": inline_output[-2000:]}, indent=2)
            )

        write_client_keys(b"n")
        wait_until(
            lambda: frame if "SELECT TOOL" in (frame := capture_client_window()) else None,
            timeout=5,
            label="daily loop tool picker opens from n",
        )
        if mutation != "daily-loop-spawn-missing":
            write_client_keys(b"\r")
        _, session = wait_until(
            lambda: ps_session_for_tool(scope, aimux_bin, "claude"),
            timeout=12,
            label="daily loop spawned claude session in ps",
        )
        session_id = str(session.get("id") or "")
        if not session_id:
            raise LiveResidualFailure(f"daily loop spawned session has no id: {session}")
        wait_dashboard("daily loop dashboard after spawn", timeout=12)

        shell_window_ids = {
            fields[1]
            for line in tmux_cmd_for_socket(
                tmux,
                socket_name,
                ["list-windows", "-a", "-F", "#{window_name}\t#{window_id}"],
            ).stdout.splitlines()
            if (fields := line.split("\t")) and fields[0] in {"claude", "/bin/sh"}
        }
        shell_window_ids.discard("")
        if not shell_window_ids:
            raise LiveResidualFailure("daily loop spawned agent has no tmux window")

        focused = None
        for _ in range(3):
            focused = client_for_tty(client_tty)
            if focused:
                if focused["windowId"] in shell_window_ids:
                    break
                focused = None
            write_client_keys(b"\r")
            deadline = time.monotonic() + 4
            while time.monotonic() < deadline:
                focused = client_for_tty(client_tty)
                if focused and focused["windowId"] in shell_window_ids:
                    break
                time.sleep(0.05)
            if focused and focused["windowId"] in shell_window_ids:
                break
        else:
            raise LiveResidualFailure(
                "daily loop Enter never focused the selected agent:\n"
                + json.dumps({
                    "clientTty": client_tty,
                    "clients": attached_client_rows(),
                    "agentWindowIds": sorted(shell_window_ids),
                    "windows": tmux_cmd_for_socket(
                        tmux,
                        socket_name,
                        ["list-windows", "-a", "-F", "#{session_name}\t#{window_id}\t#{window_index}\t#{window_name}"],
                    ).stdout,
                    "capture": capture_all_tmux(scope)[-2000:],
                }, indent=2)
            )

        if mutation != "daily-loop-return-missing":
            write_client_keys(b"\x01", b"d")
        wait_client_dashboard("daily loop prefix+d returns to dashboard")
        wait_dashboard("daily loop dashboard frame after agent return")

        worktree = run(
            [str(aimux_bin), "worktree", "add", "feat/daily-loop", "--json"],
            cwd=scope.project,
            env=scope.env,
            timeout=45,
        )
        parse_json_stdout(worktree.stdout, "daily loop worktree add")
        worktree_list = run(
            [str(aimux_bin), "worktree", "list"],
            cwd=scope.project,
            env=scope.env,
            timeout=30,
        ).stdout
        if "feat/daily-loop" not in worktree_list:
            raise LiveResidualFailure(f"daily loop worktree add did not appear in list:\n{worktree_list}")
        write_client_keys(b"2")
        wait_until(
            lambda: (
                frame
                if "feat/daily-loop" in (frame := capture_client_window())
                else None
            ),
            timeout=8,
            label="daily loop dashboard shows second worktree",
        )

        for key, anchor in [
            (b"c", "coordination"),
            (b"p", "project"),
            (b"L", "library"),
            (b"t", "topology"),
            (b"g", "graveyard"),
        ]:
            write_client_keys(key)
            wait_until(
                lambda expected=anchor: (
                    frame
                    if expected in (frame := capture_client_window()).lower()
                    else None
                ),
                timeout=8,
                label=f"daily loop opens {anchor} screen",
            )
            write_client_keys(b"\x1b")
            wait_dashboard(f"daily loop returns from {anchor} screen")

        stop = run(
            [str(aimux_bin), "stop", session_id, "--json"],
            cwd=scope.project,
            env=scope.env,
            timeout=30,
        )
        stop_payload = parse_json_stdout(stop.stdout, "daily loop agent stop")
        if stop_payload.get("status") != "graveyard":
            raise LiveResidualFailure(f"daily loop stop did not graveyard the agent: {stop_payload}")
        wait_until(
            lambda: (
                payload
                if graveyard_contains_session((payload := graveyard_payload(scope, aimux_bin)), session_id)
                else None
            ),
            timeout=10,
            label="daily loop stopped agent appears in graveyard",
        )
        resurrect = run(
            [str(aimux_bin), "graveyard", "resurrect", session_id, "--json"],
            cwd=scope.project,
            env=scope.env,
            timeout=30,
        )
        resurrect_payload = parse_json_stdout(resurrect.stdout, "daily loop graveyard resurrect")
        if resurrect_payload.get("status") != "offline":
            raise LiveResidualFailure(f"daily loop resurrect returned wrong status: {resurrect_payload}")
        stamp_backend_session(scope, session_id, "backend-daily-loop")
        run_top_level_tool_restore(scope, aimux_bin, tmux, socket_name, project_root, session_id, "claude")
        wait_until(
            lambda: ps_contains_session(scope, aimux_bin, session_id),
            timeout=10,
            label="daily loop restored agent is running again",
        )
        write_client_keys(b"\x01", b"d")
        wait_client_dashboard("daily loop primary client returns to dashboard after restore")
        wait_dashboard("daily loop dashboard after restore")

        drain_fd_now(client_fd)
        set_pty_size(client_fd, 100, 26)
        os.kill(proc.pid, signal.SIGWINCH)
        dashboard_before_resize = wait_client_dashboard("daily loop client is on dashboard before resize")
        if dashboard_before_resize:
            tmux_cmd_for_socket(tmux, socket_name, ["resize-window", "-t", dashboard_before_resize["windowId"], "-x", "100", "-y", "26"])
            tmux_cmd_for_socket(tmux, socket_name, ["resize-pane", "-t", dashboard_before_resize["windowId"], "-x", "100", "-y", "26"])
            tmux_cmd_for_socket(tmux, socket_name, ["refresh-client", "-t", client_tty, "-S"], check=False)
        resized = wait_until(
            lambda: (
                frame
                if "agent multiplexer" in (frame := capture_client_window())
                and frame_reaches_width(frame, 100)
                else None
            ),
            timeout=10,
            label="daily loop dashboard repaints after resize without input",
        )
        assert_frame_width(resized, 100, "daily loop resized dashboard")
        try:
            wait_client_dashboard("daily loop client remains on dashboard after resize")
        except LiveResidualFailure as error:
            raise LiveResidualFailure(
                f"{error}\n"
                + json.dumps({
                    "clientTty": client_tty,
                    "client": client_for_tty(client_tty),
                    "clients": attached_client_rows(),
                    "windows": tmux_cmd_for_socket(
                        tmux,
                        socket_name,
                        ["list-windows", "-a", "-F", "#{session_name}\t#{window_id}\t#{window_index}\t#{window_name}\t#{pane_current_command}\t#{pane_dead}"],
                        check=False,
                    ).stdout,
                    "clientCapture": capture_client_window()[-2000:],
                    "allCapture": capture_all_tmux(scope)[-2000:],
                }, indent=2)
            ) from error

        dashboard_before_quit = wait_client_dashboard("daily loop client is on dashboard before quit")
        dashboard_window_before_quit = dashboard_before_quit["windowId"]
        write_client_keys(b"q")
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            client_after_quit = client_for_tty(client_tty)
            live_window_ids = {
                fields[0]
                for line in tmux_cmd_for_socket(
                    tmux,
                    socket_name,
                    ["list-windows", "-a", "-F", "#{window_id}"],
                    check=False,
                ).stdout.splitlines()
                if (fields := line.split("\t")) and fields[0]
            }
            if (
                proc.poll() is not None
                or not client_after_quit
                or (
                    client_after_quit["windowName"] != "dashboard"
                    and dashboard_window_before_quit not in live_window_ids
                )
            ):
                break
            time.sleep(0.05)
        else:
            raise LiveResidualFailure(
                "daily loop dashboard did not quit cleanly:\n"
                + json.dumps({
                    "returncode": proc.poll(),
                    "client": client_for_tty(client_tty),
                    "clients": attached_client_rows(),
                    "windows": tmux_cmd_for_socket(
                        tmux,
                        socket_name,
                        ["list-windows", "-a", "-F", "#{session_name}\t#{window_id}\t#{window_index}\t#{window_name}\t#{pane_current_command}\t#{pane_dead}"],
                    ).stdout,
                    "clientCapture": capture_client_window()[-2000:],
                    "allCapture": capture_all_tmux(scope)[-2000:],
                    "rawTail": drain_fd_now(client_fd)[-2000:],
                }, indent=2)
            )
        return {
            "name": "phase8-daily-loop-smoke",
            "privateSocket": socket_name,
            "sessionId": session_id,
            "caught": [
                "fresh git repo bare aimux opens a managed tmux dashboard through a real PTY",
                "dashboard n opens the tool picker and spawns a configured agent",
                "Enter focuses the selected agent and prefix+d returns to dashboard",
                "worktree add appears in the dashboard loop",
                "coordination/project/library/topology/graveyard screens open and return",
                "stop moves an agent into graveyard and restore makes it running again",
                "dashboard repaints after resize without another input key",
                "dashboard quits cleanly",
            ],
            "notCaught": [
                "real Claude/Codex credentials",
                "manual mosh transport outside the private PTY",
                "multi-hour agent output churn",
            ],
        }


def run_expose_interaction_smoke(aimux_bin: Path, mutation: str | None) -> dict[str, Any]:
    tmux = find_tmux()
    with Scope("expose-interaction", aimux_bin) as scope:
        socket_name = f"aimux-expose-{os.getpid()}-{time.time_ns()}"
        scope.tmux_socket_name = socket_name
        install_tmux_socket_wrapper(scope, tmux, socket_name)
        run([tmux, "-L", socket_name, "kill-server"], env=without_tmux(os.environ.copy()), timeout=10, check=False)
        scope.init_git_project()
        seed_initial_commit(scope)
        run([str(aimux_bin), "init"], cwd=scope.project, env=scope.env, timeout=30)
        install_shell_tool_config(scope)
        config_path = scope.project / ".aimux" / "config.json"
        config = json.loads(config_path.read_text())
        config["tools"]["shell"]["args"] = ["-lc", "printf 'phase8-agent-tool-ready\\n'; sleep 90"]
        config["tools"]["shell"]["promptPatterns"] = ["phase8-agent-tool-ready"]
        config_path.write_text(json.dumps(config, indent=2) + "\n")

        first = parse_json_stdout(
            run(
                [str(aimux_bin), "spawn", "--tool", "shell", "--no-open", "--json"],
                cwd=scope.project,
                env=scope.env,
                timeout=30,
            ).stdout,
            "expose first shell spawn",
        )
        second = parse_json_stdout(
            run(
                [str(aimux_bin), "spawn", "--tool", "shell", "--no-open", "--json"],
                cwd=scope.project,
                env=scope.env,
                timeout=30,
            ).stdout,
            "expose second shell spawn",
        )
        first_target = first.get("tmuxTarget")
        second_target = second.get("tmuxTarget")
        if not isinstance(first_target, dict) or not isinstance(second_target, dict):
            raise LiveResidualFailure(f"expose spawn targets missing: {first} {second}")
        shell_window_ids = {
            str(first_target.get("windowId") or ""),
            str(second_target.get("windowId") or ""),
        }
        shell_window_ids.discard("")
        host_session_name = str(first_target.get("sessionName") or "")
        if len(shell_window_ids) < 2 or not host_session_name:
            raise LiveResidualFailure(f"expose spawn returned incomplete targets: {first} {second}")
        wait_for_project_service_endpoint(scope)

        def expose_socket_ready() -> Path | None:
            for state_dir in sorted((scope.aimux_home / "projects").glob("*")):
                path_file = state_dir / "expose.sock.path"
                candidates = []
                if path_file.exists():
                    candidates.extend(
                        Path(line.strip())
                        for line in path_file.read_text(errors="replace").splitlines()
                        if line.strip()
                    )
                candidates.append(state_dir / "expose.sock")
                for candidate in candidates:
                    if candidate.exists():
                        return candidate
            return None

        expose_socket = wait_until(
            expose_socket_ready,
            timeout=10,
            label="project-service expose socket",
        )

        run([str(aimux_bin), "dashboard-reload"], cwd=scope.project, env=scope.env, timeout=30)
        project_root = scope.project.resolve()
        proc, client_fd = start_tmux_capture_client(
            scope,
            tmux,
            socket_name,
            [
                "-f",
                "/dev/null",
                "attach-session",
                "-t",
                f"{host_session_name}:0",
            ],
            cwd=project_root,
            cols=120,
            rows=30,
        )

        wait_until(
            lambda: capture_all_tmux(scope)
            if "agent multiplexer" in capture_all_tmux(scope) and "Main Checkout" in capture_all_tmux(scope)
            else None,
            timeout=10,
            label="expose dashboard attach",
        )

        def attached_client_rows() -> list[dict[str, str]]:
            raw = tmux_cmd_for_socket(
                tmux,
                socket_name,
                [
                    "list-clients",
                    "-F",
                    "#{client_tty}\t#{session_name}\t#{window_id}\t#{window_name}\t#{client_name}\t#{client_width}\t#{client_height}",
                ],
            ).stdout
            rows = []
            for line in raw.splitlines():
                fields = line.split("\t")
                if len(fields) == 7:
                    rows.append({
                        "tty": fields[0],
                        "session": fields[1],
                        "windowId": fields[2],
                        "windowName": fields[3],
                        "name": fields[4],
                        "width": fields[5],
                        "height": fields[6],
                    })
            return rows

        client = wait_until(
            lambda: (rows[0] if (rows := attached_client_rows()) else None),
            timeout=5,
            label="expose attached tmux client",
        )
        client_tty = client["tty"]

        def write_client_keys(*chunks: bytes) -> None:
            for chunk in chunks:
                os.write(client_fd, chunk)
                time.sleep(0.05)

        def wait_for_client_screen(
            predicate: Any,
            *,
            cols: int,
            rows: int,
            timeout: float,
            label: str,
        ) -> str:
            deadline = time.monotonic() + timeout
            raw = ""
            last_screen = ""
            while time.monotonic() < deadline:
                raw += drain_fd_now(client_fd)
                last_screen = terminal_screen_from_output(raw, cols, rows, label)
                if predicate(last_screen):
                    return last_screen
                time.sleep(0.05)
            raise LiveResidualFailure(
                f"timed out waiting for {label}:\n"
                + json.dumps({
                    "client": next(
                        (item for item in attached_client_rows() if item["tty"] == client_tty),
                        None,
                    ),
                    "screen": last_screen,
                    "rawTail": raw[-2000:],
                    "paneCapture": capture_all_tmux(scope)[-2000:],
                }, indent=2)
            )

        def attached_client_size() -> str:
            row = next(
                (item for item in attached_client_rows() if item["tty"] == client_tty),
                None,
            )
            if not row:
                return ""
            return f"{row['width']}x{row['height']}"

        def open_expose(label: str, *, cols: int = 120, rows: int = 30) -> str:
            drain_fd_now(client_fd)
            if mutation != "expose-entry-missing":
                write_client_keys(b"\x01", b"g")
            return wait_for_client_screen(
                lambda screen: "Exposé" in screen and "1-9 open" in screen,
                cols=cols,
                rows=rows,
                timeout=8,
                label=label,
            )

        write_client_keys(b"\r")
        wait_until(
            lambda: capture_all_tmux(scope)
            if any(marker in capture_all_tmux(scope) for marker in ["▸ ●", "▸ ◆", "▸ ◇", "> ●", "> ◆", "> ◇"])
            else None,
            timeout=5,
            label="expose dashboard session selection",
        )
        write_client_keys(b"\r")
        current_agent = wait_until(
            lambda: next(
                (
                    item
                    for item in attached_client_rows()
                    if item["tty"] == client_tty and item["windowId"] in shell_window_ids
                ),
                None,
            ),
            timeout=8,
            label="expose dashboard focuses first agent",
        )
        open_expose("managed prefix+g opens expose")
        if mutation != "expose-exit-missing":
            write_client_keys(b"q")
        exited_client = wait_until(
            lambda: next(
                (
                    item
                    for item in attached_client_rows()
                    if item["tty"] == client_tty and item["windowId"] == current_agent["windowId"]
                ),
                None,
            ),
            timeout=5,
            label="expose q exits to the launch window",
        )

        write_client_keys(b"\x01", b"d")
        wait_until(
            lambda: next(
                (
                    item
                    for item in attached_client_rows()
                    if item["tty"] == client_tty and item["windowName"] == "dashboard"
                ),
                None,
            ),
            timeout=5,
            label="expose returns to dashboard before navigation",
        )
        open_expose("managed expose reopens for navigation from dashboard")
        wait_for_client_screen(
            lambda screen: "Exposé" in screen and "(2)" in screen,
            cols=120,
            rows=30,
            timeout=8,
            label="expose loads project tiles before navigation",
        )
        drain_fd_now(client_fd)
        if mutation != "expose-navigation-inert":
            write_client_keys(b"n")
        time.sleep(0.2)
        screen_after_move = terminal_screen_from_output(drain_fd_now(client_fd), 120, 30, "expose after n")
        write_client_keys(b"\r")
        focused_agent = None
        focus_deadline = time.monotonic() + 8
        while time.monotonic() < focus_deadline:
            focused_agent = next(
                (
                    item
                    for item in attached_client_rows()
                    if item["tty"] == client_tty
                    and item["windowId"] in shell_window_ids
                    and item["windowId"] == second_target["windowId"]
                ),
                None,
            )
            if focused_agent:
                break
            time.sleep(0.05)
        if not focused_agent:
            raise LiveResidualFailure(
                "timed out waiting for expose enter focuses selected tile:\n"
                + json.dumps({
                    "previousWindowId": exited_client["windowId"],
                    "expectedWindowId": second_target["windowId"],
                    "screenAfterMove": screen_after_move,
                    "clients": attached_client_rows(),
                    "windows": tmux_cmd_for_socket(
                        tmux,
                        socket_name,
                        ["list-windows", "-a", "-F", "#{session_name}\t#{window_id}\t#{window_index}\t#{window_name}"],
                    ).stdout,
                    "paneCapture": capture_all_tmux(scope)[-2000:],
                }, indent=2)
            )

        open_expose("managed expose opens before resize")
        drain_fd_now(client_fd)
        if mutation != "expose-resize-stale":
            set_pty_size(client_fd, 100, 26)
            os.kill(proc.pid, signal.SIGWINCH)
            tmux_cmd_for_socket(tmux, socket_name, ["resize-window", "-t", focused_agent["windowId"], "-x", "100", "-y", "26"])
            tmux_cmd_for_socket(tmux, socket_name, ["resize-pane", "-t", focused_agent["windowId"], "-x", "100", "-y", "26"])
            tmux_cmd_for_socket(tmux, socket_name, ["refresh-client", "-t", client_tty, "-S"], check=False)
        wait_until(
            lambda: attached_client_size() == "100x26",
            timeout=5,
            label="expose attached client resized to 100x26",
        )
        resized_screen = wait_for_client_screen(
            lambda screen: "1-9 open" in screen and frame_reaches_width(screen, 100),
            cols=100,
            rows=26,
            timeout=10,
            label="expose repaints after client resize",
        )
        assert_frame_width(resized_screen, 100, "resized expose popup")
        write_client_keys(b"q")
        terminate_process(proc)

        return {
            "name": "phase8-live-expose-interaction-smoke",
            "privateSocket": socket_name,
            "exposeSocket": str(expose_socket),
            "caught": [
                "managed prefix+g opens Exposé from the dashboard",
                "Exposé q exits back to the dashboard",
                "Exposé n moves selection between tiles",
                "Exposé Enter focuses the selected tile",
                "Exposé relaunches/repaints after client resize",
            ],
            "notCaught": [
                "host terminal behavior outside a private tmux client",
                "long-running capture refresh under sustained agent output",
            ],
        }


def run_dashboard_spawn_smoke(aimux_bin: Path, mutation: str | None) -> dict[str, Any]:
    tmux = find_tmux()
    with Scope("dashboard-spawn", aimux_bin) as scope:
        socket_name = f"aimux-phase8-dashboard-spawn-{os.getpid()}-{int(time.time() * 1000)}"
        scope.tmux_socket_name = socket_name
        install_tmux_socket_wrapper(scope, tmux, socket_name)
        run([tmux, "-L", socket_name, "kill-server"], env=without_tmux(os.environ.copy()), timeout=10, check=False)
        scope.init_git_project()
        run([str(aimux_bin), "init"], cwd=scope.project, env=scope.env, timeout=30)
        install_agent_tool_config(scope, "claude")
        install_agent_tool_config(scope, "codex")
        install_agent_tool_config(scope, "aider")

        dashboard_session = "phase8-dashboard-spawn"
        project_root = scope.project.resolve()
        command = (
            f"cd {shlex.quote(str(project_root))} && "
            f"{shlex.quote(str(aimux_bin))}; "
            "code=$?; printf '\\n__AIMUX_DASHBOARD_SPAWN_EXIT:%s\\n' \"$code\"; sleep 30"
        )
        proc = subprocess.Popen(
            [
                "script",
                "-q",
                "/dev/null",
                tmux,
                "-L",
                socket_name,
                "-f",
                "/dev/null",
                "new-session",
                "-s",
                dashboard_session,
                "-x",
                "100",
                "-y",
                "30",
                "sh",
                "-lc",
                command,
            ],
            cwd=str(project_root),
            env=scope.env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        scope.procs.append(proc)
        required = "agent multiplexer"
        wait_until(
            lambda: (
                current
                if required in (current := capture_tmux(scope, dashboard_session))
                else None
            ),
            timeout=10,
            label="dashboard spawn first frame",
        )
        tmux_cmd(scope, ["send-keys", "-t", f"{dashboard_session}:0", "n"])
        picker_output = wait_until(
            lambda: (
                current
                if "SELECT TOOL" in (current := capture_tmux(scope, dashboard_session))
                else None
            ),
            timeout=5,
            label="dashboard spawn tool picker",
        )
        if "claude" not in picker_output:
            raise LiveResidualFailure(f"dashboard spawn picker did not include claude:\n{picker_output}")
        tmux_cmd(scope, ["send-keys", "-t", f"{dashboard_session}:0", "Enter"])

        lookup_tool = "claude"
        if mutation == "dashboard-spawn-missing-session":
            lookup_tool = "phase8-dashboard-spawn-mutation-missing"
        ps_payload, session = wait_until(
            lambda: ps_session_for_tool(scope, aimux_bin, lookup_tool),
            timeout=12,
            label=f"{lookup_tool} dashboard-spawn session in aimux ps",
        )
        session_id = str(session.get("id") or "")
        if not session_id:
            raise LiveResidualFailure(f"dashboard-spawn session has no id: {session}")
        windows = tmux_cmd_for_socket(
            tmux,
            socket_name,
            ["list-windows", "-a", "-F", "#{session_name}\t#{window_name}"],
        ).stdout
        if "\tclaude" not in windows and "\t/bin/sh" not in windows:
            raise LiveResidualFailure(f"dashboard-spawn tmux window missing for {session_id}:\n{windows}")

        stop = run(
            [str(aimux_bin), "stop", session_id, "--json"],
            cwd=scope.project,
            env=scope.env,
            timeout=30,
        )
        parse_json_stdout(stop.stdout, "dashboard-spawn agent stop")
        wait_until(
            lambda: not ps_contains_session(scope, aimux_bin, session_id),
            timeout=10,
            label="dashboard-spawn session removed from aimux ps",
        )
        tmux_cmd(scope, ["send-keys", "-t", f"{dashboard_session}:0", "q"])
        final_output = ""
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            final_output = capture_all_tmux(scope)
            if "__AIMUX_DASHBOARD_SPAWN_EXIT:0" in final_output:
                break
            time.sleep(0.05)
        else:
            raise LiveResidualFailure(f"dashboard-spawn dashboard did not quit:\n{final_output}")
        return {
            "name": "phase8-dashboard-spawn-smoke",
            "sessionId": session_id,
            "psAfterSpawn": ps_payload,
            "caught": [
                "native dashboard tool picker creating an agent through the real binary",
                "dashboard action execution reaching POST /agents/spawn",
                "spawned dashboard agent appears in aimux ps",
                "spawned dashboard agent tmux window exists",
                "dashboard remains responsive after spawning an agent",
            ],
            "notCaught": [
                "real Claude CLI availability",
                "tool picker launch option editing before spawn",
            ],
        }


def run_command_resolution_smoke(aimux_bin: Path, mutation: str | None) -> dict[str, Any]:
    tmux = find_tmux()
    with Scope("command-resolution", aimux_bin) as scope:
        socket_name = f"aimux-phase8-command-{os.getpid()}-{int(time.time() * 1000)}"
        scope.tmux_socket_name = socket_name
        install_tmux_socket_wrapper(scope, tmux, socket_name)
        run([tmux, "-L", socket_name, "kill-server"], env=without_tmux(os.environ.copy()), timeout=10, check=False)
        scope.init_git_project()
        seed_initial_commit(scope)
        run([str(aimux_bin), "init"], cwd=scope.project, env=scope.env, timeout=30)
        run([str(aimux_bin), "serve"], cwd=scope.project, env=scope.env, timeout=30)

        help_output = run([str(aimux_bin), "--help"], cwd=scope.project, env=scope.env, timeout=10).stdout
        commands = parse_help_commands(help_output)
        if not commands:
            raise LiveResidualFailure(f"could not parse aimux --help commands:\n{help_output}")

        probes: list[tuple[str, list[str]]] = [(command, [command, "--help"]) for command in commands]
        probes.extend(command_resolution_regression_probes())
        alias_baselines = {
            "loop-list": ("aimux ps", run([str(aimux_bin), "ps"], cwd=scope.project, env=scope.env, timeout=30).stdout),
            "overseer-status": ("aimux ps", run([str(aimux_bin), "ps"], cwd=scope.project, env=scope.env, timeout=30).stdout),
            "scribe-status": ("aimux ps", run([str(aimux_bin), "ps"], cwd=scope.project, env=scope.env, timeout=30).stdout),
            "review-list": (
                "aimux task list",
                run([str(aimux_bin), "task", "list"], cwd=scope.project, env=scope.env, timeout=30).stdout,
            ),
        }
        failures = []
        for index, (name, args) in enumerate(probes):
            result = run([str(aimux_bin), *args], cwd=scope.project, env=scope.env, timeout=30, check=False)
            combined = result.stdout + "\n" + result.stderr
            if mutation == "command-unsupported" and index == 0:
                combined += "\nunsupported or invalid aimux command: phase8 mutation"
            if has_unsupported_command_error(combined):
                failures.append({
                    "name": name,
                    "args": args,
                    "code": result.returncode,
                    "stdout": result.stdout[-600:],
                    "stderr": result.stderr[-600:],
                })
                continue
            if mutation == "command-silent-alias" and name in alias_baselines:
                result = subprocess.CompletedProcess(
                    result.args,
                    result.returncode,
                    stdout=alias_baselines[name][1],
                    stderr=result.stderr,
                )
            if name in alias_baselines and result.returncode == 0:
                baseline_label, baseline_stdout = alias_baselines[name]
                if result.stdout == baseline_stdout:
                    failures.append({
                        "name": name,
                        "args": args,
                        "code": result.returncode,
                        "stdout": result.stdout[-600:],
                        "stderr": result.stderr[-600:],
                        "aliasBaseline": baseline_label,
                    })
        if failures:
            raise LiveResidualFailure("command resolution regressions:\n" + json.dumps(failures, indent=2))
        return {
            "name": "phase8-command-resolution-smoke",
            "helpCommands": commands,
            "probes": len(probes),
            "caught": [
                "advertised command missing from native root dispatch",
                "valid subcommand rejected as unsupported",
                "Clap fallback unrecognized-subcommand regressions",
                "command groups silently aliasing ps or task-list output",
            ],
            "notCaught": [
                "exact command output formatting",
                "remote relay behavior",
                "commands that intentionally fail for domain reasons after routing",
            ],
        }


def parse_help_commands(help_output: str) -> list[str]:
    commands: list[str] = []
    in_commands = False
    for line in help_output.splitlines():
        if line.strip() == "Commands:":
            in_commands = True
            continue
        if not in_commands:
            continue
        if not line.startswith("  "):
            continue
        command = line.strip().split()[0]
        if command:
            commands.append(command)
    return commands


def command_resolution_regression_probes() -> list[tuple[str, list[str]]]:
    return [
        ("dashboard-reload-json", ["dashboard-reload", "--json"]),
        ("restart-runtime-json", ["restart-runtime", "--json"]),
        ("stop-project-json", ["stop", "--json"]),
        ("overseer-status", ["overseer", "status"]),
        ("scribe-status", ["scribe", "status"]),
        ("loop-list", ["loop", "list"]),
        ("review-list", ["review", "list"]),
        ("worktree-add", ["worktree", "add", "phase8-command-smoke", "--json"]),
        ("graveyard-bare", ["graveyard"]),
        ("graveyard-bare-json", ["graveyard", "--json"]),
    ]


def has_unsupported_command_error(output: str) -> bool:
    return (
        "unsupported or invalid aimux command" in output
        or "unrecognized subcommand" in output
        or "unsupported core command" in output
    )


def run_agent_shell_spawn_smoke(aimux_bin: Path, mutation: str | None) -> dict[str, Any]:
    tmux = find_tmux()
    with Scope("agent-shell", aimux_bin) as scope:
        socket_name = f"aimux-phase8-agent-{os.getpid()}-{int(time.time() * 1000)}"
        scope.tmux_socket_name = socket_name
        install_tmux_socket_wrapper(scope, tmux, socket_name)
        run([tmux, "-L", socket_name, "kill-server"], env=without_tmux(os.environ.copy()), timeout=10, check=False)
        scope.init_git_project()
        run([str(aimux_bin), "init"], cwd=scope.project, env=scope.env, timeout=30)
        install_shell_tool_config(scope)
        result = run(
            [str(aimux_bin), "spawn", "--tool", "shell", "--no-open", "--json"],
            cwd=scope.project,
            env=scope.env,
            timeout=30,
        )
        payload = parse_json_stdout(result.stdout, "shell spawn")
        session_id = str(payload.get("sessionId") or "")
        if not session_id:
            raise LiveResidualFailure(f"shell spawn did not return a sessionId: {payload}")
        target = payload.get("tmuxTarget")
        if not isinstance(target, dict):
            raise LiveResidualFailure(f"shell spawn did not return a tmuxTarget: {payload}")
        session_name = str(target.get("sessionName") or "")
        window_name = str(target.get("windowName") or "")
        if mutation == "agent-shell-missing-window":
            window_name = "phase8-agent-shell-mutation-missing"

        ps_payload = wait_until(
            lambda: ps_contains_session(scope, aimux_bin, session_id),
            timeout=10,
            label="shell session in aimux ps",
        )
        windows = tmux_cmd_for_socket(tmux, socket_name, ["list-windows", "-a", "-F", "#{session_name}\t#{window_name}"]).stdout
        if session_name not in windows or window_name not in windows:
            raise LiveResidualFailure(f"shell tmux window missing for {session_id}:\n{windows}")

        stop = run(
            [str(aimux_bin), "stop", session_id, "--json"],
            cwd=scope.project,
            env=scope.env,
            timeout=30,
        )
        parse_json_stdout(stop.stdout, "shell stop")
        wait_until(
            lambda: not ps_contains_session(scope, aimux_bin, session_id),
            timeout=10,
            label="shell session removed from aimux ps",
        )
        return {
            "name": "phase8-agent-shell-spawn-smoke",
            "sessionId": session_id,
            "psAfterSpawn": ps_payload,
            "caught": [
                "native spawn executor reaches project-service",
                "agent spawn bootstraps an empty tmux server",
                "spawned shell session appears in aimux ps",
                "spawned shell tmux window exists",
                "agent stop removes the spawned session",
            ],
            "notCaught": [
                "external agent CLI availability",
                "LLM API credentials",
                "long-running interactive shell usage",
            ],
        }


def run_shell_service_smoke(aimux_bin: Path, mutation: str | None) -> dict[str, Any]:
    tmux = find_tmux()
    with Scope("shell-service", aimux_bin) as scope:
        socket_name = f"aimux-phase8-shell-service-{os.getpid()}-{int(time.time() * 1000)}"
        scope.tmux_socket_name = socket_name
        install_tmux_socket_wrapper(scope, tmux, socket_name)
        run([tmux, "-L", socket_name, "kill-server"], env=without_tmux(os.environ.copy()), timeout=10, check=False)
        scope.init_git_project()
        run([str(aimux_bin), "init"], cwd=scope.project, env=scope.env, timeout=30)
        result = run(
            [str(aimux_bin), "shell"],
            cwd=scope.project,
            env=scope.env,
            timeout=30,
        )
        prefix = "service "
        suffix = " running"
        line = result.stdout.strip()
        if not (line.startswith(prefix) and line.endswith(suffix)):
            raise LiveResidualFailure(f"aimux shell returned unexpected output:\n{result.stdout}\n{result.stderr}")
        service_id = line[len(prefix):-len(suffix)]
        expected_window = "shell"
        if mutation == "shell-service-missing-window":
            expected_window = "phase8-shell-service-mutation-missing"
        windows = wait_until(
            lambda: tmux_cmd_for_socket(
                tmux,
                socket_name,
                ["list-windows", "-a", "-F", "#{session_name}\t#{window_name}"],
            ).stdout,
            timeout=10,
            label="shell service tmux window inventory",
        )
        if f"\t{expected_window}" not in windows:
            raise LiveResidualFailure(f"shell service tmux window missing for {service_id}:\n{windows}")
        return {
            "name": "phase8-shell-service-smoke",
            "serviceId": service_id,
            "caught": [
                "top-level aimux shell reaches service create",
                "service create bootstraps an empty tmux server",
                "shell service creates a tmux window",
            ],
            "notCaught": [
                "long-running interactive shell usage",
                "manual attach focus behavior after service creation",
            ],
        }


def run_top_level_tool_restore(
    scope: Scope,
    aimux_bin: Path,
    tmux: str,
    socket_name: str,
    project_root: Path,
    session_id: str,
    tool: str,
) -> str:
    launcher_session = f"phase8-restore-{tool}-{int(time.time() * 1000)}"
    command = (
        f"cd {shlex.quote(str(project_root))} && "
        f"{shlex.quote(str(aimux_bin))} --restore {shlex.quote(tool)}; "
        f"code=$?; printf '\\n__AIMUX_RESTORE_{tool}_EXIT:%s\\n' \"$code\"; sleep 30"
    )
    proc = subprocess.Popen(
        [
            "script",
            "-q",
            "/dev/null",
            tmux,
            "-L",
            socket_name,
            "-f",
            "/dev/null",
            "new-session",
            "-s",
            launcher_session,
            "-x",
            "100",
            "-y",
            "30",
            "sh",
            "-lc",
            command,
        ],
        cwd=str(project_root),
        env=scope.env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    scope.procs.append(proc)
    deadline = time.monotonic() + 20
    output = ""
    while time.monotonic() < deadline:
        try:
            output = capture_all_tmux(scope)
        except LiveResidualFailure:
            output = ""
        if has_unsupported_command_error(output) or "tool is required" in output:
            raise LiveResidualFailure(f"{tool} restore dispatch failed:\n{output}")
        if ps_contains_session(scope, aimux_bin, session_id):
            break
        time.sleep(0.05)
    else:
        raise LiveResidualFailure(
            f"timed out waiting for restored {tool} session {session_id}:\n"
            f"{output}\nstdout:\n{read_pipe(proc.stdout)}\nstderr:\n{read_pipe(proc.stderr)}"
        )
    tmux_cmd(scope, ["send-keys", "-t", f"{launcher_session}:0", "q"])
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        output = capture_all_tmux(scope)
        if f"__AIMUX_RESTORE_{tool}_EXIT:0" in output:
            break
        time.sleep(0.05)
    else:
        raise LiveResidualFailure(f"{tool} restore dashboard did not quit:\n{output}")
    return session_id


def run_graveyard_lifecycle_smoke(aimux_bin: Path, mutation: str | None) -> dict[str, Any]:
    tmux = find_tmux()
    with Scope("graveyard", aimux_bin) as scope:
        socket_name = f"aimux-phase8-graveyard-{os.getpid()}-{int(time.time() * 1000)}"
        scope.tmux_socket_name = socket_name
        install_tmux_socket_wrapper(scope, tmux, socket_name)
        run([tmux, "-L", socket_name, "kill-server"], env=without_tmux(os.environ.copy()), timeout=10, check=False)
        scope.init_git_project()
        run([str(aimux_bin), "init"], cwd=scope.project, env=scope.env, timeout=30)
        install_shell_tool_config(scope)
        project_root = scope.project.resolve()
        spawn = run(
            [str(aimux_bin), "spawn", "--tool", "shell", "--no-open", "--json"],
            cwd=scope.project,
            env=scope.env,
            timeout=30,
        )
        session_id = str(parse_json_stdout(spawn.stdout, "graveyard shell spawn").get("sessionId") or "")
        if not session_id:
            raise LiveResidualFailure(f"graveyard shell spawn did not return a session id: {spawn.stdout}")
        wait_until(
            lambda: ps_contains_session(scope, aimux_bin, session_id),
            timeout=10,
            label="graveyard spawned shell in aimux ps",
        )
        fork = run(
            [str(aimux_bin), "fork", session_id, "--json"],
            cwd=scope.project,
            env=scope.env,
            timeout=30,
        )
        fork_payload = parse_json_stdout(fork.stdout, "graveyard shell fork")
        fork_session_id = str(fork_payload.get("sessionId") or "")
        if not fork_session_id:
            raise LiveResidualFailure(f"graveyard shell fork did not return a session id: {fork.stdout}")
        if mutation == "graveyard-fork-missing-session":
            fork_session_id = "phase8-missing-fork-session"
        wait_until(
            lambda: ps_contains_session(scope, aimux_bin, fork_session_id),
            timeout=10,
            label="forked shell in aimux ps",
        )
        stop_fork = run(
            [str(aimux_bin), "stop", fork_session_id, "--json"],
            cwd=scope.project,
            env=scope.env,
            timeout=30,
        )
        parse_json_stdout(stop_fork.stdout, "graveyard forked shell stop")
        stop = run(
            [str(aimux_bin), "stop", session_id, "--json"],
            cwd=scope.project,
            env=scope.env,
            timeout=30,
        )
        stop_payload = parse_json_stdout(stop.stdout, "graveyard shell stop")
        if stop_payload.get("status") != "graveyard":
            raise LiveResidualFailure(f"graveyard shell stop should return graveyard status: {stop_payload}")
        graveyard_after_stop = wait_until(
            lambda: (
                payload
                if graveyard_contains_session((payload := graveyard_payload(scope, aimux_bin)), session_id)
                else None
            ),
            timeout=10,
            label="stopped shell in graveyard list",
        )
        if mutation == "graveyard-stop-missing-entry":
            graveyard_after_stop["entries"] = [
                entry
                for entry in graveyard_after_stop.get("entries", [])
                if isinstance(entry, dict) and entry.get("id") != session_id
            ]
        if not graveyard_contains_session(graveyard_after_stop, session_id):
            raise LiveResidualFailure(
                f"stop did not move {session_id} into graveyard:\n"
                + json.dumps(graveyard_after_stop, indent=2)
            )

        resurrect = run(
            [str(aimux_bin), "graveyard", "resurrect", session_id, "--json"],
            cwd=scope.project,
            env=scope.env,
            timeout=30,
        )
        resurrect_payload = parse_json_stdout(resurrect.stdout, "graveyard shell resurrect")
        if resurrect_payload.get("status") != "offline":
            raise LiveResidualFailure(f"graveyard resurrect should return offline status: {resurrect_payload}")
        resurrected_session = wait_until(
            lambda: ps_session_by_id(scope, aimux_bin, session_id),
            timeout=10,
            label="resurrected shell in aimux ps",
        )
        if resurrected_session.get("status") != "offline":
            raise LiveResidualFailure(f"resurrected shell should be offline, got: {resurrected_session}")
        stamp_backend_session(scope, session_id, "backend-phase8-shell")
        restored = run_top_level_tool_restore(scope, aimux_bin, tmux, socket_name, project_root, session_id, "shell")
        kill = run(
            [str(aimux_bin), "kill", restored, "--json"],
            cwd=scope.project,
            env=scope.env,
            timeout=30,
        )
        parse_json_stdout(kill.stdout, "graveyard restored shell kill")
        graveyard_after_kill = wait_until(
            lambda: (
                payload
                if graveyard_contains_session((payload := graveyard_payload(scope, aimux_bin)), restored)
                else None
            ),
            timeout=10,
            label="killed restored shell in graveyard list",
        )
        return {
            "name": "phase8-graveyard-lifecycle-smoke",
            "sessionId": session_id,
            "forkSessionId": fork_session_id,
            "graveyardAfterKill": graveyard_after_kill,
            "caught": [
                "bare aimux graveyard routes to graveyard list",
                "fork on a running agent succeeds without an explicit tool flag",
                "stop moves a session into recoverable graveyard",
                "graveyard resurrect returns the session to offline ps",
                "root --restore relaunches the resurrected session",
                "kill keeps a restored session in graveyard",
            ],
            "notCaught": [
                "graveyard cleanup retention timing",
            ],
        }


def run_top_level_agent_tool_smoke(aimux_bin: Path, mutation: str | None) -> dict[str, Any]:
    tmux = find_tmux()
    with Scope("top-level-agent", aimux_bin) as scope:
        socket_name = f"aimux-phase8-top-level-agent-{os.getpid()}-{int(time.time() * 1000)}"
        scope.tmux_socket_name = socket_name
        install_tmux_socket_wrapper(scope, tmux, socket_name)
        run([tmux, "-L", socket_name, "kill-server"], env=without_tmux(os.environ.copy()), timeout=10, check=False)
        scope.init_git_project()
        run([str(aimux_bin), "init"], cwd=scope.project, env=scope.env, timeout=30)
        install_agent_tool_config(scope, "codex")
        install_agent_tool_config(scope, "claude")
        install_agent_tool_config(scope, "aider")
        project_root = scope.project.resolve()
        launched: list[str] = []

        def launch_and_stop(label: str, args: list[str], expected_tool: str) -> tuple[str, dict[str, Any]]:
            launcher_session = f"phase8-top-level-agent-{label}"
            command = (
                f"cd {shlex.quote(str(project_root))} && "
                f"{' '.join([shlex.quote(str(aimux_bin)), *map(shlex.quote, args)])}; "
                f"code=$?; printf '\\n__AIMUX_TOP_LEVEL_AGENT_{label}_EXIT:%s\\n' \"$code\"; sleep 30"
            )
            proc = subprocess.Popen(
                [
                    "script",
                    "-q",
                    "/dev/null",
                    tmux,
                    "-L",
                    socket_name,
                    "-f",
                    "/dev/null",
                    "new-session",
                    "-s",
                    launcher_session,
                    "-x",
                    "100",
                    "-y",
                    "30",
                    "sh",
                    "-lc",
                    command,
                ],
                cwd=str(project_root),
                env=scope.env,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            scope.procs.append(proc)
            output = ""
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                try:
                    output = capture_all_tmux(scope)
                except LiveResidualFailure:
                    output = ""
                if has_unsupported_command_error(output) or "tool is required" in output:
                    raise LiveResidualFailure(f"{label} top-level agent tool dispatch failed:\n{output}")
                if f"__AIMUX_TOP_LEVEL_AGENT_{label}_EXIT:0" in output:
                    break
                time.sleep(0.05)
            else:
                raise LiveResidualFailure(
                    f"timed out waiting for {label} top-level agent tool dispatch:\n"
                    f"{output}\nstdout:\n{read_pipe(proc.stdout)}\nstderr:\n{read_pipe(proc.stderr)}"
                )

            lookup_tool = expected_tool
            if mutation == "top-level-agent-missing-session" and not launched:
                lookup_tool = "phase8-agent-tool-mutation-missing"
            ps_payload, session = wait_until(
                lambda: ps_session_for_tool(scope, aimux_bin, lookup_tool),
                timeout=10,
                label=f"{lookup_tool} session in aimux ps",
            )
            session_id = str(session.get("id") or "")
            if not session_id:
                raise LiveResidualFailure(f"{label} top-level agent session has no id: {session}")
            windows = tmux_cmd_for_socket(
                tmux,
                socket_name,
                ["list-windows", "-a", "-F", "#{session_name}\t#{window_name}"],
            ).stdout
            if f"\t{expected_tool}" not in windows and "\t/bin/sh" not in windows:
                raise LiveResidualFailure(f"{label} top-level agent tmux window missing for {session_id}:\n{windows}")

            stop = run(
                [str(aimux_bin), "stop", session_id, "--json"],
                cwd=scope.project,
                env=scope.env,
                timeout=30,
            )
            parse_json_stdout(stop.stdout, f"{label} top-level agent stop")
            wait_until(
                lambda: not ps_contains_session(scope, aimux_bin, session_id),
                timeout=10,
                label=f"{label} top-level agent session removed from aimux ps",
            )
            launched.append(f"{label}:{session_id}")
            return session_id, ps_payload

        def resume_or_restore_and_stop(label: str, mode: str, tool: str, session_id: str) -> None:
            launcher_session = f"phase8-top-level-agent-{label}"
            command = (
                f"cd {shlex.quote(str(project_root))} && "
                f"{shlex.quote(str(aimux_bin))} --{mode} {shlex.quote(tool)}; "
                f"code=$?; printf '\\n__AIMUX_TOP_LEVEL_AGENT_{label}_EXIT:%s\\n' \"$code\"; sleep 30"
            )
            proc = subprocess.Popen(
                [
                    "script",
                    "-q",
                    "/dev/null",
                    tmux,
                    "-L",
                    socket_name,
                    "-f",
                    "/dev/null",
                    "new-session",
                    "-s",
                    launcher_session,
                    "-x",
                    "100",
                    "-y",
                    "30",
                    "sh",
                    "-lc",
                    command,
                ],
                cwd=str(project_root),
                env=scope.env,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            scope.procs.append(proc)
            deadline = time.monotonic() + 20
            output = ""
            while time.monotonic() < deadline:
                try:
                    output = capture_all_tmux(scope)
                except LiveResidualFailure:
                    output = ""
                if has_unsupported_command_error(output) or "tool is required" in output:
                    raise LiveResidualFailure(f"{label} root restore dispatch failed:\n{output}")
                if ps_contains_session(scope, aimux_bin, session_id):
                    break
                time.sleep(0.05)
            else:
                raise LiveResidualFailure(
                    f"timed out waiting for {label} {mode} session {session_id}:\n"
                    f"{output}\nstdout:\n{read_pipe(proc.stdout)}\nstderr:\n{read_pipe(proc.stderr)}"
                )
            tmux_cmd(scope, ["send-keys", "-t", f"{launcher_session}:0", "q"])
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                output = capture_all_tmux(scope)
                if f"__AIMUX_TOP_LEVEL_AGENT_{label}_EXIT:0" in output:
                    break
                time.sleep(0.05)
            else:
                raise LiveResidualFailure(f"{label} {mode} dashboard did not quit:\n{output}")
            stop = run(
                [str(aimux_bin), "stop", session_id, "--json"],
                cwd=scope.project,
                env=scope.env,
                timeout=30,
            )
            parse_json_stdout(stop.stdout, f"{label} {mode} agent stop")
            wait_until(
                lambda: not ps_contains_session(scope, aimux_bin, session_id),
                timeout=10,
                label=f"{label} {mode} session removed from aimux ps",
            )
            launched.append(f"{label}:{session_id}")

        session_id, ps_payload = launch_and_stop("codex-bare", ["codex"], "codex")
        stamp_backend_session(scope, session_id, "backend-phase8-codex")
        resume_or_restore_and_stop("codex-resume", "resume", "codex", session_id)
        resume_or_restore_and_stop("codex-restore", "restore", "codex", session_id)
        launch_and_stop("codex-args", ["codex", "hello"], "codex")
        launch_and_stop("claude-bare", ["claude"], "claude")
        launch_and_stop("aider-args", ["aider", "--help"], "aider")
        return {
            "name": "phase8-top-level-agent-tool-smoke",
            "sessionId": session_id,
            "launched": launched,
            "psAfterSpawn": ps_payload,
            "caught": [
                "bare top-level agent tool dispatch through the real binary",
                "built-in codex and claude tool names through the real binary",
                "tool argument pass-through before Clap fallback",
                "root --resume tool filter exact-resuming a saved backend session",
                "root --restore tool filter relaunching a saved session",
                "spawn executor implementation behind resolved dispatch",
                "foreground target opening from an attached tmux client",
            ],
            "notCaught": [
                "real aider CLI availability",
                "Claude/Codex credentials or network access",
            ],
        }


def run_lazy_read_start_smoke(aimux_bin: Path, mutation: str | None) -> dict[str, Any]:
    tmux = find_tmux()
    with Scope("lazy-read", aimux_bin) as scope:
        socket_name = f"aimux-phase8-read-{os.getpid()}-{int(time.time() * 1000)}"
        scope.tmux_socket_name = socket_name
        install_tmux_socket_wrapper(scope, tmux, socket_name)
        run([tmux, "-L", socket_name, "kill-server"], env=without_tmux(os.environ.copy()), timeout=10, check=False)
        scope.init_git_project()
        seed_initial_commit(scope)
        run([str(aimux_bin), "init"], cwd=scope.project, env=scope.env, timeout=30)
        run([str(aimux_bin), "daemon", "status", "--json"], cwd=scope.project, env=scope.env, timeout=30)

        probes = [
            ("ps-json", ["ps", "--json"]),
            ("list-json", ["list", "--json"]),
            ("worktree-list-json", ["worktree", "list", "--json"]),
            ("threads-json", ["threads", "--json"]),
            ("task-list-json", ["task", "list", "--json"]),
        ]
        failures = []
        for name, args in probes:
            run([str(aimux_bin), "host", "stop", "--json"], cwd=scope.project, env=scope.env, timeout=15, check=False)
            result = run([str(aimux_bin), *args], cwd=scope.project, env=scope.env, timeout=30, check=False)
            combined = result.stdout + "\n" + result.stderr
            if mutation == "lazy-read-service-unavailable" and name == "ps-json":
                combined += "\nError: project service unavailable for phase8 mutation"
            if result.returncode != 0 or "project service unavailable" in combined:
                failures.append({
                    "name": name,
                    "args": args,
                    "code": result.returncode,
                    "stdout": result.stdout[-600:],
                    "stderr": result.stderr[-600:],
                })
        if failures:
            raise LiveResidualFailure("lazy read start regressions:\n" + json.dumps(failures, indent=2))
        return {
            "name": "phase8-lazy-read-start-smoke",
            "probes": len(probes),
            "caught": [
                "fresh-project read commands waking a cold project service",
                "project service unavailable regressions on ps/list/thread/task/worktree reads",
            ],
            "notCaught": [
                "all-project catalog reads that intentionally stay daemon-only",
                "long-running idle service shutdown policy",
            ],
        }


def run_restart_current_project_smoke(aimux_bin: Path, mutation: str | None) -> dict[str, Any]:
    tmux = find_tmux()
    with Scope("restart-current", aimux_bin) as scope:
        socket_name = f"aimux-phase8-restart-{os.getpid()}-{int(time.time() * 1000)}"
        scope.tmux_socket_name = socket_name
        install_tmux_socket_wrapper(scope, tmux, socket_name)
        run([tmux, "-L", socket_name, "kill-server"], env=without_tmux(os.environ.copy()), timeout=10, check=False)
        scope.init_git_project()
        seed_initial_commit(scope)
        run([str(aimux_bin), "init"], cwd=scope.project, env=scope.env, timeout=30)
        run([str(aimux_bin), "daemon", "status", "--json"], cwd=scope.project, env=scope.env, timeout=30)

        result = run(
            [str(aimux_bin), "restart", "--json"],
            cwd=scope.project,
            env=scope.env,
            timeout=45,
        )
        payload = parse_json_stdout(result.stdout, "restart current project")
        summary_projects = payload.get("summary", {}).get("projects")
        if mutation == "restart-current-zero-projects":
            summary_projects = 0
        projects = payload.get("projects")
        project_roots = [
            item.get("projectRoot")
            for item in projects
            if isinstance(item, dict)
        ] if isinstance(projects, list) else []
        if summary_projects != 1 or str(scope.project.resolve()) not in project_roots:
            raise LiveResidualFailure(
                "restart did not include current project:\n"
                + json.dumps({
                    "summaryProjects": summary_projects,
                    "projectRoots": project_roots,
                    "payload": payload,
                }, indent=2)
            )
        return {
            "name": "phase8-restart-current-project-smoke",
            "caught": [
                "bare aimux restart ignoring an unregistered current checkout",
                "restart summary reporting zero projects while current project exists",
            ],
            "notCaught": [
                "fleet-wide daemon restart across many catalog projects",
                "manual install restart behavior outside the temp root",
            ],
        }


def run_restart_missing_dashboard_smoke(aimux_bin: Path, mutation: str | None) -> dict[str, Any]:
    tmux = find_tmux()
    with Scope("restart-missing-dashboard", aimux_bin) as scope:
        socket_name = f"aimux-phase8-restart-missing-dashboard-{os.getpid()}-{int(time.time() * 1000)}"
        scope.tmux_socket_name = socket_name
        install_tmux_socket_wrapper(scope, tmux, socket_name)
        run([tmux, "-L", socket_name, "kill-server"], env=without_tmux(os.environ.copy()), timeout=10, check=False)
        scope.init_git_project()
        seed_initial_commit(scope)
        run([str(aimux_bin), "init"], cwd=scope.project, env=scope.env, timeout=30)
        run([str(aimux_bin), "shell"], cwd=scope.project, env=scope.env, timeout=30)

        inventory = wait_until(
            lambda: tmux_cmd_for_socket(
                tmux,
                socket_name,
                ["list-windows", "-a", "-F", "#{session_name}\t#{window_id}\t#{window_index}\t#{window_name}"],
            ).stdout,
            timeout=10,
            label="managed tmux window inventory before dashboard removal",
        )
        dashboard_rows = [
            row.split("\t")
            for row in inventory.splitlines()
            if row.endswith("\tdashboard")
        ]
        if not dashboard_rows:
            raise LiveResidualFailure(f"expected an initial dashboard window before removal:\n{inventory}")
        dashboard_session, dashboard_window_id = dashboard_rows[0][0], dashboard_rows[0][1]
        tmux_cmd_for_socket(tmux, socket_name, ["kill-window", "-t", dashboard_window_id])
        without_dashboard = tmux_cmd_for_socket(
            tmux,
            socket_name,
            ["list-windows", "-a", "-F", "#{session_name}\t#{window_id}\t#{window_index}\t#{window_name}"],
        ).stdout
        if "\tdashboard" in without_dashboard:
            raise LiveResidualFailure(f"failed to create missing-dashboard precondition:\n{without_dashboard}")

        result = run(
            [str(aimux_bin), "restart", "--json"],
            cwd=scope.home,
            env=scope.env,
            timeout=75,
        )
        payload = parse_json_stdout(result.stdout, "global restart missing-dashboard repair")
        projects = payload.get("projects")
        project = next(
            (
                item
                for item in projects
                if isinstance(item, dict) and item.get("projectRoot") == str(scope.project.resolve())
            ),
            None,
        ) if isinstance(projects, list) else None
        if not isinstance(project, dict):
            raise LiveResidualFailure(
                "global restart did not include registered project:\n"
                + json.dumps({"projectRoot": str(scope.project.resolve()), "payload": payload}, indent=2)
            )
        dashboard = project.get("dashboard")
        target = dashboard.get("target") if isinstance(dashboard, dict) else None
        if not isinstance(target, dict) or dashboard.get("status") != "reloaded":
            raise LiveResidualFailure(
                "global restart did not report a reloaded dashboard target:\n"
                + json.dumps({"dashboard": dashboard, "payload": payload}, indent=2)
            )
        reported_session = str(target.get("sessionName") or "")
        reported_window_id = str(target.get("windowId") or "")
        if mutation == "restart-missing-dashboard-target-mismatch":
            reported_window_id = "@phase8-missing-dashboard-mutated"

        repaired_inventory = wait_until(
            lambda: tmux_cmd_for_socket(
                tmux,
                socket_name,
                ["list-windows", "-a", "-F", "#{session_name}\t#{window_id}\t#{window_index}\t#{window_name}"],
            ).stdout,
            timeout=10,
            label="managed tmux window inventory after global restart",
        )
        matching_reported_target = False
        matching_dashboard_window = False
        expected_window_name = "dashboard"
        if mutation == "restart-missing-dashboard-window-missing":
            expected_window_name = "phase8-dashboard-mutation-missing"
        for row in repaired_inventory.splitlines():
            session_name, window_id, _window_index, window_name = (row.split("\t") + ["", "", "", ""])[:4]
            if session_name == reported_session and window_id == reported_window_id:
                matching_reported_target = True
            if session_name == dashboard_session and window_name == expected_window_name:
                matching_dashboard_window = True
        if not matching_reported_target:
            raise LiveResidualFailure(
                "global restart reported a dashboard target that does not exist in tmux:\n"
                + json.dumps({"reported": target, "windows": repaired_inventory}, indent=2)
            )
        if not matching_dashboard_window:
            raise LiveResidualFailure(
                "global restart did not recreate the missing dashboard window:\n"
                + json.dumps({"session": dashboard_session, "windows": repaired_inventory}, indent=2)
            )
        return {
            "name": "phase8-restart-missing-dashboard-smoke",
            "privateSocket": socket_name,
            "reportedTarget": target,
            "caught": [
                "global aimux restart from a non-project cwd skipping registered projects with missing dashboard windows",
                "restart reporting a dashboard window id that does not exist in tmux",
                "install-time repair claiming dashboard reload success for a transient dead window",
            ],
            "notCaught": [
                "scripts/install.sh output formatting",
                "remote-machine install permissions outside the temp root",
            ],
        }


def run_non_git_project_smoke(aimux_bin: Path, mutation: str | None) -> dict[str, Any]:
    with Scope("non-git", aimux_bin) as scope:
        expected = (
            f"{scope.project.resolve()} is not a git repository. "
            "Run `git init` first, or cd into a repo."
        )
        probes = [
            ("init", ["init"]),
            ("ps", ["ps"]),
            ("dashboard", []),
        ]
        messages: dict[str, str] = {}
        failures = []
        for name, args in probes:
            result = run([str(aimux_bin), *args], cwd=scope.project, env=scope.env, timeout=15, check=False)
            combined = (result.stderr or result.stdout).strip()
            if mutation == "non-git-message-mismatch" and name == "ps":
                combined = combined.replace("is not a git repository", "is not registered with the daemon")
            messages[name] = combined
            if result.returncode == 0 or combined != expected:
                failures.append({
                    "name": name,
                    "args": args,
                    "code": result.returncode,
                    "message": combined,
                    "expected": expected,
                })
        if mutation == "non-git-init-created-aimux":
            (scope.project / ".aimux").mkdir(exist_ok=True)
        if (scope.project / ".aimux").exists():
            failures.append({
                "name": "init",
                "code": 0,
                "message": "aimux init created .aimux in a non-git directory",
                "expected": "no .aimux directory",
            })
        if failures:
            raise LiveResidualFailure("non-git project front-door regressions:\n" + json.dumps(failures, indent=2))
        return {
            "name": "phase8-non-git-project-smoke",
            "messages": messages,
            "caught": [
                "aimux init refusing non-git directories before creating .aimux",
                "aimux ps matching dashboard project eligibility",
                "bare aimux returning the same actionable non-git message",
            ],
            "notCaught": [
                "nested git-worktree path discovery",
                "daemon registry state for previously valid projects",
            ],
        }


def seed_initial_commit(scope: Scope) -> None:
    readme = scope.project / "README.md"
    readme.write_text("phase8 command resolution smoke\n")
    run(["git", "add", "README.md"], cwd=scope.project, env=scope.env, timeout=10)
    run(["git", "commit", "-q", "-m", "initial"], cwd=scope.project, env=scope.env, timeout=10)


def install_shell_tool_config(scope: Scope) -> None:
    install_agent_tool_config(scope, "shell")


def install_agent_tool_config(scope: Scope, tool: str) -> None:
    config_path = scope.project / ".aimux" / "config.json"
    config = json.loads(config_path.read_text())
    tools = config.setdefault("tools", {})
    tools[tool] = {
        "command": "/bin/sh",
        "args": ["-lc", "printf 'phase8-agent-tool-ready\\n'; sleep 30"],
        "enabled": True,
        "wrapperEnabled": False,
        "resumeArgs": ["--resume", "{sessionId}"],
        "resumeByBackendSessionId": True,
        "promptPatterns": ["^[$#] "],
        "turnPatterns": [],
    }
    config_path.write_text(json.dumps(config, indent=2) + "\n")


def stamp_backend_session(scope: Scope, session_id: str, backend_session_id: str) -> None:
    endpoint = wait_for_project_service_endpoint(scope)
    http_json(
        endpoint,
        "POST",
        "/agents/record-backend-session",
        {
            "sessionId": session_id,
            "backendSessionId": backend_session_id,
        },
    )


def parse_json_stdout(stdout: str, label: str) -> dict[str, Any]:
    try:
        value = json.loads(stdout)
    except json.JSONDecodeError as error:
        raise LiveResidualFailure(f"{label} returned non-JSON stdout:\n{stdout}") from error
    if not isinstance(value, dict):
        raise LiveResidualFailure(f"{label} returned non-object JSON: {value!r}")
    return value


def ps_contains_session(scope: Scope, aimux_bin: Path, session_id: str) -> dict[str, Any] | None:
    result = run([str(aimux_bin), "ps", "--json"], cwd=scope.project, env=scope.env, timeout=15, check=False)
    if result.returncode != 0:
        return None
    try:
        payload: Any = json.loads(result.stdout)
    except json.JSONDecodeError:
        return None
    sessions = payload.get("sessions") if isinstance(payload, dict) else payload
    if not isinstance(sessions, list):
        return None
    for session in sessions:
        if isinstance(session, dict) and session.get("id") == session_id:
            if session.get("status") not in ("starting", "running", "idle"):
                return None
            return payload if isinstance(payload, dict) else {"sessions": payload}
    return None


def ps_session_by_id(scope: Scope, aimux_bin: Path, session_id: str) -> dict[str, Any] | None:
    result = run([str(aimux_bin), "ps", "--json"], cwd=scope.project, env=scope.env, timeout=15, check=False)
    if result.returncode != 0:
        return None
    try:
        payload: Any = json.loads(result.stdout)
    except json.JSONDecodeError:
        return None
    sessions = payload.get("sessions") if isinstance(payload, dict) else payload
    if not isinstance(sessions, list):
        return None
    for session in sessions:
        if isinstance(session, dict) and session.get("id") == session_id:
            return session
    return None


def ps_session_for_tool(scope: Scope, aimux_bin: Path, tool: str) -> tuple[dict[str, Any], dict[str, Any]] | None:
    result = run([str(aimux_bin), "ps", "--json"], cwd=scope.project, env=scope.env, timeout=15, check=False)
    if result.returncode != 0:
        return None
    try:
        payload: Any = json.loads(result.stdout)
    except json.JSONDecodeError:
        return None
    sessions = payload.get("sessions") if isinstance(payload, dict) else payload
    if not isinstance(sessions, list):
        return None
    for session in sessions:
        if not isinstance(session, dict):
            continue
        if session.get("tool") != tool and session.get("toolConfigKey") != tool:
            continue
        if session.get("status") in ("starting", "running", "idle"):
            return payload if isinstance(payload, dict) else {"sessions": payload}, session
    return None


def graveyard_payload(scope: Scope, aimux_bin: Path) -> dict[str, Any]:
    result = run(
        [str(aimux_bin), "graveyard", "--json"],
        cwd=scope.project,
        env=scope.env,
        timeout=30,
    )
    return parse_json_stdout(result.stdout, "graveyard list")


def graveyard_contains_session(payload: dict[str, Any], session_id: str) -> bool:
    entries = payload.get("entries")
    if not isinstance(entries, list):
        return False
    return any(isinstance(entry, dict) and entry.get("id") == session_id for entry in entries)


def tmux_cmd_for_socket(
    tmux: str,
    socket_name: str,
    args: list[str],
    *,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    return run([tmux, "-L", socket_name, *args], env=without_tmux(os.environ.copy()), timeout=10, check=check)


def tmux_cmd(scope: Scope, args: list[str]) -> subprocess.CompletedProcess[str]:
    tmux = scope.real_tmux or find_tmux()
    return run([tmux, "-L", scope.tmux_socket_name or "aimux-phase8", *args], env=scope.env, timeout=10)


def seed_tmux_socket_environment(tmux: str, socket_name: str, scope: Scope) -> None:
    for key in TMUX_SESSION_ENV_KEYS:
        value = scope.env.get(key)
        if value:
            tmux_cmd_for_socket(tmux, socket_name, ["set-environment", "-g", key, value], check=False)
    for key in ("TMUX", "TMUX_PANE"):
        tmux_cmd_for_socket(tmux, socket_name, ["set-environment", "-gu", key], check=False)


def start_tmux_pty_client(
    scope: Scope,
    tmux: str,
    socket_name: str,
    args: list[str],
    *,
    cwd: Path,
) -> None:
    master_fd, slave_fd = pty.openpty()
    scope.fds.append(master_fd)
    def make_controlling_tty() -> None:
        os.setsid()
        fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)

    proc = subprocess.Popen(
        [tmux, "-L", socket_name, *args],
        cwd=str(cwd),
        env=scope.env,
        stdin=slave_fd,
        stdout=slave_fd,
        stderr=slave_fd,
        close_fds=True,
        preexec_fn=make_controlling_tty,
    )
    os.close(slave_fd)
    scope.procs.append(proc)
    threading.Thread(target=drain_fd, args=(master_fd,), daemon=True).start()


def start_tmux_capture_client(
    scope: Scope,
    tmux: str,
    socket_name: str,
    args: list[str],
    *,
    cwd: Path,
    cols: int,
    rows: int,
) -> tuple[subprocess.Popen[Any], int]:
    master_fd, slave_fd = pty.openpty()
    set_pty_size(slave_fd, cols, rows)
    scope.fds.append(master_fd)

    def make_controlling_tty() -> None:
        os.setsid()
        fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)

    proc = subprocess.Popen(
        [tmux, "-L", socket_name, *args],
        cwd=str(cwd),
        env=scope.env,
        stdin=slave_fd,
        stdout=slave_fd,
        stderr=slave_fd,
        close_fds=True,
        preexec_fn=make_controlling_tty,
    )
    os.close(slave_fd)
    scope.procs.append(proc)
    return proc, master_fd


def start_process_capture_client(
    scope: Scope,
    args: list[str],
    *,
    cwd: Path,
    cols: int,
    rows: int,
) -> tuple[subprocess.Popen[Any], int]:
    master_fd, slave_fd = pty.openpty()
    set_pty_size(slave_fd, cols, rows)
    scope.fds.append(master_fd)

    def make_controlling_tty() -> None:
        os.setsid()
        fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)

    proc = subprocess.Popen(
        args,
        cwd=str(cwd),
        env=scope.env,
        stdin=slave_fd,
        stdout=slave_fd,
        stderr=slave_fd,
        close_fds=True,
        preexec_fn=make_controlling_tty,
    )
    os.close(slave_fd)
    scope.procs.append(proc)
    return proc, master_fd


def set_pty_size(fd: int, cols: int, rows: int) -> None:
    winsize = struct.pack("HHHH", rows, cols, 0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)


def drain_fd(fd: int) -> None:
    while True:
        try:
            if not os.read(fd, 4096):
                return
        except OSError:
            return


def drain_fd_now(fd: int) -> str:
    try:
        flags = fcntl.fcntl(fd, fcntl.F_GETFL)
        fcntl.fcntl(fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)
        chunks: list[bytes] = []
        while True:
            try:
                chunk = os.read(fd, 4096)
            except BlockingIOError:
                break
            if not chunk:
                break
            chunks.append(chunk)
        return b"".join(chunks).decode(errors="replace")
    except Exception:
        return ""


def capture_tmux(scope: Scope, session: str) -> str:
    result = tmux_cmd(scope, ["capture-pane", "-p", "-J", "-t", f"{session}:0"])
    return result.stdout


def capture_all_tmux(scope: Scope) -> str:
    sessions = tmux_cmd(scope, ["list-sessions", "-F", "#{session_name}"]).stdout.splitlines()
    captures: list[str] = []
    for session in sessions:
        session = session.strip()
        if not session:
            continue
        try:
            captures.append(capture_tmux(scope, session))
        except LiveResidualFailure:
            pass
    return "\n".join(captures)


def strip_ansi(text: str) -> str:
    return ANSI_ESCAPE_RE.sub("", text)


def assert_frame_width(frame: str, width: int, label: str) -> None:
    for line_no, line in enumerate(frame.splitlines(), start=1):
        visible = strip_ansi(line)
        if len(visible) > width:
            raise LiveResidualFailure(
                f"{label} line {line_no} exceeds width {width}: "
                f"visible={len(visible)} line={visible!r}"
            )


def frame_reaches_width(frame: str, width: int) -> bool:
    return max((len(strip_ansi(line)) for line in frame.splitlines()), default=0) >= width - 1


def assert_frame_reaches_width(frame: str, width: int, label: str) -> None:
    if not frame_reaches_width(frame, width):
        max_width = max((len(strip_ansi(line)) for line in frame.splitlines()), default=0)
        raise LiveResidualFailure(
            f"{label} did not repaint to width {width}: max visible line width={max_width}"
        )


def install_tmux_socket_wrapper(scope: Scope, real_tmux: str, socket_name: str) -> None:
    bin_dir = scope.root / "bin"
    bin_dir.mkdir(parents=True, exist_ok=True)
    wrapper = bin_dir / "tmux"
    wrapper.write_text(
        "#!/bin/sh\n"
        f"case \"$TMUX\" in\n"
        f"  {shlex.quote('/private/tmp/tmux-' + str(os.getuid()) + '/' + socket_name)},*) exec {shlex.quote(real_tmux)} \"$@\" ;;\n"
        f"  {shlex.quote('/tmp/tmux-' + str(os.getuid()) + '/' + socket_name)},*) exec {shlex.quote(real_tmux)} \"$@\" ;;\n"
        f"  *) unset TMUX TMUX_PANE; exec {shlex.quote(real_tmux)} -L {shlex.quote(socket_name)} \"$@\" ;;\n"
        f"esac\n"
    )
    wrapper.chmod(0o755)
    scope.real_tmux = real_tmux
    scope.env["PATH"] = f"{bin_dir}{os.pathsep}{scope.env.get('PATH', '')}"


def run_sse_stress(aimux_bin: Path, mutation: str | None) -> dict[str, Any]:
    with Scope("sse", aimux_bin) as scope:
        scope.init_git_project()
        proc = scope.popen([
            str(aimux_bin),
            "__project-service-internal",
            "--project-id",
            f"phase8-sse-{os.getpid()}",
            "--project-root",
            str(scope.project),
        ])
        endpoint = wait_for_project_service_endpoint(scope)
        health = http_json(endpoint, "GET", "/health")
        if health.get("ok") is not True:
            raise LiveResidualFailure(f"project-service health failed: {health}")

        connected = threading.Barrier(SSE_CLIENT_COUNT + 1)
        results: list[list[str] | None] = [None] * SSE_CLIENT_COUNT
        errors: list[str] = []
        threads = [
            threading.Thread(
                target=sse_client,
                args=(endpoint, index, connected, results, errors),
                daemon=True,
            )
            for index in range(SSE_CLIENT_COUNT)
        ]
        for thread in threads:
            thread.start()
        connected.wait(timeout=10)

        order = list(range(SSE_EVENT_COUNT))
        if mutation == "sse-reorder":
            order[20], order[21] = order[21], order[20]
        for event_index in order:
            title = f"phase8-sse-{event_index:03d}"
            http_json(
                endpoint,
                "POST",
                "/notify",
                {
                    "kind": "notification",
                    "sessionId": "codex-sse",
                    "title": title,
                    "body": title,
                    "force": True,
                },
            )
        for thread in threads:
            thread.join(timeout=20)
        if proc.poll() is not None:
            raise LiveResidualFailure(
                f"project-service exited during SSE stress: {proc.returncode}\n"
                f"stdout:\n{read_pipe(proc.stdout)}\nstderr:\n{read_pipe(proc.stderr)}"
            )
        if errors:
            raise LiveResidualFailure("SSE client errors:\n" + "\n".join(errors))
        expected = [f"phase8-sse-{index:03d}" for index in range(SSE_EVENT_COUNT)]
        for index, titles in enumerate(results):
            if titles != expected:
                raise LiveResidualFailure(
                    f"SSE client {index} saw wrong alert order/count\n"
                    f"expected first/last/count: {expected[:3]} ... {expected[-3:]} / {len(expected)}\n"
                    f"actual first/last/count: {(titles or [])[:3]} ... {(titles or [])[-3:]} / {len(titles or [])}"
                )
        return {
            "name": "phase8-sse-stress",
            "clients": SSE_CLIENT_COUNT,
            "eventsPerClient": SSE_EVENT_COUNT,
            "caught": [
                "project-service SSE wakeups",
                "multi-client event fanout",
                "alert frame ordering",
                "missing or duplicated alert frames",
            ],
            "notCaught": [
                "network partitions outside loopback",
                "minutes-long idle keepalive behavior",
                "browser EventSource implementation differences",
            ],
        }


def read_pipe(pipe: Any) -> str:
    if pipe is None:
        return ""
    try:
        return pipe.read() or ""
    except Exception:
        return ""


def terminal_screen_from_output(output: str, cols: int, rows: int, label: str) -> str:
    screen = [[" " for _ in range(cols)] for _ in range(rows)]
    row = 0
    col = 0
    index = 0
    while index < len(output):
        char = output[index]
        if char == "\x1b":
            if index + 2 < len(output) and output[index + 1] in "()":
                index += 3
                continue
            match = ANSI_ESCAPE_RE.match(output, index)
            if match:
                params = match.group(0)[2:-1]
                command = match.group(0)[-1]
                if command in ("H", "f"):
                    parts = [part for part in params.split(";") if part and not part.startswith("?")]
                    next_row = int(parts[0]) if len(parts) >= 1 and parts[0].isdigit() else 1
                    next_col = int(parts[1]) if len(parts) >= 2 and parts[1].isdigit() else 1
                    row = min(rows - 1, max(0, next_row - 1))
                    col = min(cols - 1, max(0, next_col - 1))
                elif command == "J" and params in ("2", "3"):
                    screen = [[" " for _ in range(cols)] for _ in range(rows)]
                    row = 0
                    col = 0
                elif command == "K":
                    if 0 <= row < rows:
                        for clear_col in range(col, cols):
                            screen[row][clear_col] = " "
                index = match.end()
                continue
            index += 1
            continue
        if char == "\r":
            col = 0
        elif char == "\n":
            row = min(row + 1, rows - 1)
        elif ord(char) >= 32:
            if 0 <= row < rows and 0 <= col < cols:
                screen[row][col] = char
            col += 1
            if col >= cols:
                col = 0
                row = min(row + 1, rows - 1)
        index += 1
    return "\n".join("".join(line) for line in screen)


def wait_for_project_service_endpoint(scope: Scope) -> str:
    def probe() -> str | None:
        for path in glob.glob(str(scope.aimux_home / "projects" / "*" / "metadata-api.txt")):
            text = Path(path).read_text().strip()
            if text:
                return text
        return None

    return wait_until(probe, timeout=10, label="metadata-api.txt")


def http_json(endpoint: str, method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
    parsed = urlparse(endpoint)
    conn = http.client.HTTPConnection(parsed.hostname, parsed.port, timeout=5)
    raw_body = None if body is None else json.dumps(body).encode()
    headers = {"accept": "application/json"}
    if raw_body is not None:
        headers["content-type"] = "application/json"
    conn.request(method, path, body=raw_body, headers=headers)
    response = conn.getresponse()
    payload = response.read()
    conn.close()
    try:
        parsed_payload = json.loads(payload.decode() or "{}")
    except json.JSONDecodeError as error:
        raise LiveResidualFailure(f"{method} {path} returned non-JSON {response.status}: {payload!r}") from error
    if not (200 <= response.status < 300):
        raise LiveResidualFailure(f"{method} {path} returned {response.status}: {parsed_payload}")
    return parsed_payload


def sse_client(
    endpoint: str,
    index: int,
    connected: threading.Barrier,
    results: list[list[str] | None],
    errors: list[str],
) -> None:
    parsed = urlparse(endpoint)
    conn = http.client.HTTPConnection(parsed.hostname, parsed.port, timeout=1)
    titles: list[str] = []
    try:
        conn.putrequest("GET", "/events?intervalMs=100")
        conn.putheader("Accept", "text/event-stream")
        conn.endheaders()
        response = conn.getresponse()
        if response.status != 200:
            errors.append(f"client {index}: expected 200, got {response.status}")
            connected.abort()
            return
        event_name: str | None = None
        data_lines: list[str] = []
        ready_seen = False
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline and len(titles) < SSE_EVENT_COUNT:
            try:
                raw = response.fp.readline()
            except TimeoutError:
                continue
            except socket.timeout:
                continue
            if raw == b"":
                errors.append(f"client {index}: stream closed after {len(titles)} alerts")
                return
            line = raw.decode(errors="replace").rstrip("\r\n")
            if line == "":
                if event_name:
                    payload = "\n".join(data_lines)
                    if event_name == "ready" and not ready_seen:
                        ready_seen = True
                        connected.wait(timeout=10)
                    elif event_name == "alert":
                        value = json.loads(payload)
                        titles.append(str(value.get("title", "")))
                event_name = None
                data_lines = []
            elif line.startswith("event:"):
                event_name = line.split(":", 1)[1].strip()
            elif line.startswith("data:"):
                data_lines.append(line.split(":", 1)[1].strip())
        if not ready_seen:
            errors.append(f"client {index}: ready event not received")
            return
        results[index] = titles
    except Exception as error:
        errors.append(f"client {index}: {error}")
        try:
            connected.abort()
        except Exception:
            pass
    finally:
        conn.close()


def run_process_race_smoke(aimux_bin: Path, mutation: str | None) -> dict[str, Any]:
    with Scope("process", aimux_bin) as scope:
        scope.init_git_project()
        daemon_dir = scope.aimux_home / "daemon"
        lock_dir = scope.aimux_home / "locks" / "daemon-start"
        daemon_dir.mkdir(parents=True, exist_ok=True)
        lock_dir.mkdir(parents=True, exist_ok=True)
        (daemon_dir / "daemon.json").write_text(
            json.dumps({
                "pid": 999999,
                "port": int(scope.env["AIMUX_DAEMON_PORT"]),
                "startedAt": "1970-01-01T00:00:00.000Z",
                "updatedAt": "1970-01-01T00:00:00.000Z",
            })
            + "\n"
        )
        (lock_dir / "owner.json").write_text('{"pid":"not-an-int"}\n')

        try:
            commands = [
                subprocess.Popen(
                    [str(aimux_bin), "serve"],
                    cwd=str(scope.project),
                    env=scope.env,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                )
                for _ in range(4)
            ]
            for proc in commands:
                scope.procs.append(proc)
            outputs = []
            for proc in commands:
                stdout, stderr = proc.communicate(timeout=30)
                outputs.append((proc.returncode, stdout, stderr))
            failures = [output for output in outputs if output[0] != 0]
            if failures:
                raise LiveResidualFailure(f"concurrent serve commands failed: {failures}")

            daemon_info_path = daemon_dir / "daemon.json"
            daemon_info = json.loads(daemon_info_path.read_text())
            daemon_health = http_json(
                f"http://127.0.0.1:{scope.env['AIMUX_DAEMON_PORT']}",
                "GET",
                "/health",
            )
            if daemon_health.get("pid") != daemon_info.get("pid"):
                raise LiveResidualFailure(f"daemon health pid/state mismatch: {daemon_health} vs {daemon_info}")
            state = json.loads((daemon_dir / "state.json").read_text())
            projects = state.get("projects", {})
            if len(projects) != 1:
                raise LiveResidualFailure(f"expected one project service entry, got {len(projects)}: {state}")
            service = next(iter(projects.values()))
            if service.get("status") != "running":
                raise LiveResidualFailure(f"project service did not reach running: {service}")
            endpoint = wait_for_project_service_endpoint(scope)
            if mutation == "process-delete-endpoint":
                for path in glob.glob(str(scope.aimux_home / "projects" / "*" / "metadata-api.txt")):
                    Path(path).unlink()
                endpoint = wait_for_project_service_endpoint(scope)
            health = http_json(endpoint, "GET", "/health")
            if health.get("ok") is not True or health.get("pid") != service.get("pid"):
                raise LiveResidualFailure(f"project-service health/state mismatch: {health} vs {service}")

            return {
                "name": "phase8-process-race-smoke",
                "concurrentServeCommands": len(commands),
                "caught": [
                    "stale daemon info cleanup",
                    "malformed daemon start lock reclamation",
                    "concurrent daemon ensure serialization",
                    "project-service endpoint publication",
                    "daemon/project-service state-health mismatch",
                ],
                "notCaught": [
                    "non-loopback deployment issues",
                    "SIGKILL-only teardown edge cases",
                    "long-running daemon memory or descriptor leaks",
                ],
            }
        finally:
            stop_temp_project_and_daemon(scope, aimux_bin)
            kill_recorded_temp_processes(scope, aimux_bin)


def stop_temp_project_and_daemon(scope: Scope, aimux_bin: Path) -> None:
    run([str(aimux_bin), "host", "stop", "--json"], cwd=scope.project, env=scope.env, timeout=15, check=False)
    run([str(aimux_bin), "daemon", "stop", "--json"], cwd=scope.project, env=scope.env, timeout=15, check=False)


def kill_recorded_temp_processes(scope: Scope, aimux_bin: Path) -> None:
    for pid in recorded_temp_pids(scope):
        command = run(["ps", "-p", str(pid), "-o", "command="], timeout=5, check=False)
        command_line = command.stdout.strip()
        if command.returncode != 0 or not command_line:
            continue
        if str(aimux_bin) not in command_line and str(scope.project) not in command_line:
            continue
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            continue
        except PermissionError:
            continue
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            if run(["ps", "-p", str(pid)], timeout=5, check=False).returncode != 0:
                break
            time.sleep(0.05)
        if run(["ps", "-p", str(pid)], timeout=5, check=False).returncode == 0:
            try:
                os.kill(pid, signal.SIGKILL)
            except Exception:
                pass


def recorded_temp_pids(scope: Scope) -> list[int]:
    pids: list[int] = []
    daemon_info = scope.aimux_home / "daemon" / "daemon.json"
    if daemon_info.exists():
        try:
            value = json.loads(daemon_info.read_text() or "{}")
            if isinstance(value.get("pid"), int):
                pids.append(value["pid"])
        except Exception:
            pass
    state_path = scope.aimux_home / "daemon" / "state.json"
    if state_path.exists():
        try:
            state = json.loads(state_path.read_text() or "{}")
            for service in state.get("projects", {}).values():
                if isinstance(service, dict) and isinstance(service.get("pid"), int):
                    pids.append(service["pid"])
        except Exception:
            pass
    return [pid for pid in sorted(set(pids)) if pid > 1]


def run_one(name: str, aimux_bin: Path, mutation: str | None) -> dict[str, Any]:
    if name == "tmux":
        return run_tmux_live_smoke(aimux_bin, mutation)
    if name == "dashboard" or name == "dashboard-input":
        return run_dashboard_render_smoke(aimux_bin, mutation)
    if name == "dashboard-attach":
        return run_dashboard_attach_smoke(aimux_bin, mutation)
    if name == "bare-dashboard":
        return run_bare_dashboard_tmux_smoke(aimux_bin, mutation)
    if name == "daily-loop":
        return run_daily_loop_smoke(aimux_bin, mutation)
    if name == "dashboard-spawn":
        return run_dashboard_spawn_smoke(aimux_bin, mutation)
    if name == "expose-interaction":
        return run_expose_interaction_smoke(aimux_bin, mutation)
    if name == "command-resolution":
        return run_command_resolution_smoke(aimux_bin, mutation)
    if name == "agent-shell":
        return run_agent_shell_spawn_smoke(aimux_bin, mutation)
    if name == "shell-service":
        return run_shell_service_smoke(aimux_bin, mutation)
    if name == "graveyard":
        return run_graveyard_lifecycle_smoke(aimux_bin, mutation)
    if name == "top-level-agent":
        return run_top_level_agent_tool_smoke(aimux_bin, mutation)
    if name == "lazy-read":
        return run_lazy_read_start_smoke(aimux_bin, mutation)
    if name == "restart-current":
        return run_restart_current_project_smoke(aimux_bin, mutation)
    if name == "restart-missing-dashboard":
        return run_restart_missing_dashboard_smoke(aimux_bin, mutation)
    if name == "non-git":
        return run_non_git_project_smoke(aimux_bin, mutation)
    if name == "sse":
        return run_sse_stress(aimux_bin, mutation)
    if name == "process":
        return run_process_race_smoke(aimux_bin, mutation)
    raise LiveResidualFailure(f"unknown suite: {name}")


def prove_failures(args: argparse.Namespace, aimux_bin: Path) -> list[dict[str, Any]]:
    mutations = [
        ("tmux", "tmux-drop-output"),
        ("dashboard", "dashboard-empty-frame"),
        ("dashboard-input", "dashboard-input-dead"),
        ("dashboard-attach", "dashboard-attach-terminal-error"),
        ("dashboard-attach", "dashboard-attach-focus-target-missing"),
        ("dashboard-attach", "dashboard-attach-return-missing"),
        ("dashboard-attach", "dashboard-attach-digit-target-missing"),
        ("bare-dashboard", "bare-dashboard-inline"),
        ("daily-loop", "daily-loop-return-missing"),
        ("dashboard", "dashboard-resize-width-overflow"),
        ("expose-interaction", "expose-entry-missing"),
        ("expose-interaction", "expose-navigation-inert"),
        ("expose-interaction", "expose-resize-stale"),
        ("dashboard-spawn", "dashboard-spawn-missing-session"),
        ("command-resolution", "command-unsupported"),
        ("command-resolution", "command-silent-alias"),
        ("agent-shell", "agent-shell-missing-window"),
        ("shell-service", "shell-service-missing-window"),
        ("graveyard", "graveyard-stop-missing-entry"),
        ("graveyard", "graveyard-fork-missing-session"),
        ("top-level-agent", "top-level-agent-missing-session"),
        ("lazy-read", "lazy-read-service-unavailable"),
        ("restart-current", "restart-current-zero-projects"),
        ("restart-missing-dashboard", "restart-missing-dashboard-target-mismatch"),
        ("restart-missing-dashboard", "restart-missing-dashboard-window-missing"),
        ("non-git", "non-git-message-mismatch"),
        ("non-git", "non-git-init-created-aimux"),
        ("sse", "sse-reorder"),
        ("process", "process-delete-endpoint"),
    ]
    selected_mutations = [
        (suite, mutation)
        for suite, mutation in mutations
        if args.only == "all" or suite == args.only
    ]
    proof = []
    for suite, mutation in selected_mutations:
        command = [
            sys.executable,
            str(Path(__file__).resolve()),
            "--only",
            suite,
            "--mutation",
            mutation,
            "--aimux-bin",
            str(aimux_bin),
            "--skip-build",
        ]
        try:
            result = run(command, timeout=90, check=False)
        except subprocess.TimeoutExpired as error:
            proof.append({
                "suite": suite,
                "mutation": mutation,
                "status": "PROVEN-FAILS",
                "failureExcerpt": f"mutation timed out after {error.timeout} seconds",
            })
            continue
        if result.returncode == 0:
            raise LiveResidualFailure(f"{suite} mutation {mutation} unexpectedly passed")
        proof.append({
            "suite": suite,
            "mutation": mutation,
            "status": "PROVEN-FAILS",
            "failureExcerpt": first_failure_excerpt(result.stdout, result.stderr),
        })
    return proof


def first_failure_excerpt(stdout: str, stderr: str) -> str:
    combined = (stdout + "\n" + stderr).strip().splitlines()
    for line in combined:
        if "FAILED:" in line or "timed out" in line or "wrong" in line or "mismatch" in line:
            return line.strip()
    return (combined[-1].strip() if combined else "mutation failed")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--aimux-bin", help="native aimux binary to test")
    parser.add_argument("--skip-build", action="store_true", help="reuse the existing target binary")
    parser.add_argument(
        "--only",
        choices=[
            "all",
            "tmux",
            "dashboard",
            "dashboard-input",
            "dashboard-attach",
            "bare-dashboard",
            "daily-loop",
            "dashboard-spawn",
            "expose-interaction",
            "command-resolution",
            "agent-shell",
            "shell-service",
            "graveyard",
            "top-level-agent",
            "lazy-read",
            "restart-current",
            "restart-missing-dashboard",
            "non-git",
            "sse",
            "process",
        ],
        default="all",
    )
    parser.add_argument("--prove-fails", action="store_true", help="run intentional-fault checks and require failure")
    parser.add_argument("--mutation", choices=[
        "tmux-drop-output",
        "tmux-wrong-resize",
        "dashboard-empty-frame",
        "dashboard-resize-width-overflow",
        "dashboard-input-dead",
        "dashboard-attach-terminal-error",
        "dashboard-attach-focus-target-missing",
        "dashboard-attach-return-missing",
        "dashboard-attach-digit-target-missing",
        "bare-dashboard-inline",
        "daily-loop-spawn-missing",
        "daily-loop-return-missing",
        "expose-entry-missing",
        "expose-navigation-inert",
        "expose-resize-stale",
        "dashboard-spawn-missing-session",
        "command-unsupported",
        "command-silent-alias",
        "agent-shell-missing-window",
        "shell-service-missing-window",
        "graveyard-stop-missing-entry",
        "graveyard-fork-missing-session",
        "top-level-agent-missing-session",
        "lazy-read-service-unavailable",
        "restart-current-zero-projects",
        "restart-missing-dashboard-target-mismatch",
        "restart-missing-dashboard-window-missing",
        "non-git-message-mismatch",
        "non-git-init-created-aimux",
        "sse-reorder",
        "process-delete-endpoint",
    ])
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    default_listener = None
    try:
        default_listener = default_daemon_listener_snapshot()
        aimux_bin = build_aimux(args)
        suites = [
            "tmux",
            "dashboard",
            "dashboard-attach",
            "bare-dashboard",
            "dashboard-spawn",
            "expose-interaction",
            "command-resolution",
            "agent-shell",
            "shell-service",
            "graveyard",
            "top-level-agent",
            "lazy-read",
            "restart-current",
            "restart-missing-dashboard",
            "non-git",
            "sse",
            "process",
        ] if args.only == "all" else [args.only]
        results = []
        for suite in suites:
            results.append(run_one(suite, aimux_bin, args.mutation))
        proof = prove_failures(args, aimux_bin) if args.prove_fails and not args.mutation else []
        print(json.dumps({
            "ok": True,
            "aimuxBin": str(aimux_bin),
            "results": results,
            "proof": proof,
        }, indent=2))
        return 0
    except Exception as error:
        print(f"FAILED: {error}", file=sys.stderr)
        return 1
    finally:
        if default_listener is not None:
            assert_default_daemon_listener_unchanged(default_listener)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
