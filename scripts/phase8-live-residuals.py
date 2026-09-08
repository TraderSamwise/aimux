#!/usr/bin/env python3
"""Phase 8 live residual smoke/stress checks.

This is intentionally not part of the default unit test lane. It starts live
processes and a private tmux server, but every side effect is scoped to temp
HOME/AIMUX_HOME roots, random loopback ports, and a unique tmux -L socket.
"""

from __future__ import annotations

import argparse
import glob
import http.client
import json
import os
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_TARGET_DIR = Path("/tmp/aimux-phase8-live-target")
SSE_EVENT_COUNT = 96
SSE_CLIENT_COUNT = 8


class LiveResidualFailure(Exception):
    pass


class Scope:
    def __init__(self, label: str, aimux_bin: Path):
        self.temp = tempfile.TemporaryDirectory(prefix=f"aimux-phase8-{label}-")
        self.root = Path(self.temp.name)
        self.home = self.root / "home"
        self.aimux_home = self.root / "aimux-home"
        self.project = self.root / "project"
        self.aimux_bin = aimux_bin
        self.procs: list[subprocess.Popen[Any]] = []
        self.tmux_socket_name: str | None = None
        self.real_tmux: str | None = None
        self.env = isolated_env(self.root, self.home, self.aimux_home, aimux_bin)
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
        if self.tmux_socket_name:
            tmux = find_tmux(required=False)
            if tmux:
                subprocess.run(
                    [tmux, "-L", self.tmux_socket_name, "kill-server"],
                    env=without_tmux(os.environ.copy()),
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=5,
                    check=False,
                )
        for proc in reversed(self.procs):
            terminate_process(proc)
        self.temp.cleanup()

    def __enter__(self) -> "Scope":
        return self

    def __exit__(self, _exc_type: Any, _exc: Any, _tb: Any) -> None:
        self.cleanup()


def isolated_env(root: Path, home: Path, aimux_home: Path, aimux_bin: Path) -> dict[str, str]:
    env = os.environ.copy()
    env["HOME"] = str(home)
    env["AIMUX_HOME"] = str(aimux_home)
    env["AIMUX_NATIVE_BIN"] = str(aimux_bin)
    env["AIMUX_CLI_BIN"] = str(aimux_bin)
    env["AIMUX_DAEMON_HOST"] = "127.0.0.1"
    env["AIMUX_DAEMON_PORT"] = str(free_loopback_port())
    env["AIMUX_DASHBOARD_IMPLEMENTATION"] = "native"
    env["TERM"] = "xterm-256color"
    env["TMPDIR"] = str(root / "tmp")
    Path(env["TMPDIR"]).mkdir(parents=True, exist_ok=True)
    return without_tmux(env)


def without_tmux(env: dict[str, str]) -> dict[str, str]:
    env.pop("TMUX", None)
    env.pop("TMUX_PANE", None)
    return env


def free_loopback_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


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
        project_root = scope.project.resolve()
        run([str(aimux_bin), "init"], cwd=scope.project, env=scope.env, timeout=30)
        run([str(aimux_bin), "serve"], cwd=scope.project, env=scope.env, timeout=30)
        endpoint = wait_for_project_service_endpoint(scope)
        health = http_json(endpoint, "GET", "/health")
        if health.get("ok") is not True:
            raise LiveResidualFailure(f"project-service health failed: {health}")

        socket_name = f"aimux-dashboard-{os.getpid()}-{time.time_ns()}"
        scope.tmux_socket_name = socket_name
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
            "100",
            "-y",
            "30",
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
            output = capture_tmux(scope, session)
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
        return {
            "name": "phase8-live-dashboard-render-smoke",
            "privateSocket": socket_name,
            "caught": [
                "native dashboard first paint reaching a real tmux pane",
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
        scope.init_git_project()
        run([str(aimux_bin), "init"], cwd=scope.project, env=scope.env, timeout=30)
        socket_name = f"aimux-attach-{os.getpid()}-{time.time_ns()}"
        scope.tmux_socket_name = socket_name
        install_tmux_socket_wrapper(scope, tmux, socket_name)
        session = "phase8-attach"
        project_root = scope.project.resolve()
        command = (
            f"cd {shlex.quote(str(project_root))} && "
            f"{shlex.quote(str(aimux_bin))}; "
            "code=$?; printf '\\n__AIMUX_ATTACH_EXIT:%s\\n' \"$code\"; sleep 30"
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
                session,
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
        deadline = time.monotonic() + 15
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
                "timed out waiting for bare aimux dashboard attach:\n"
                f"{output}\nstdout:\n{read_pipe(proc.stdout)}\nstderr:\n{read_pipe(proc.stderr)}"
            )
        windows = tmux_cmd(
            scope,
            ["list-windows", "-a", "-F", "#{session_name}\t#{window_name}"],
        ).stdout
        if "dashboard" not in windows:
            raise LiveResidualFailure(f"bare aimux did not create a dashboard window:\n{windows}")
        return {
            "name": "phase8-live-dashboard-attach-smoke",
            "privateSocket": socket_name,
            "caught": [
                "bare aimux terminal attach refusal",
                "foreground dashboard open path inside a real tmux client",
                "dashboard window creation from the root CLI entry point",
            ],
            "notCaught": [
                "host-specific terminal emulator behavior outside tmux",
                "manual detach/reattach navigation after startup",
            ],
        }


def run_command_resolution_smoke(aimux_bin: Path, mutation: str | None) -> dict[str, Any]:
    tmux = find_tmux()
    with Scope("command-resolution", aimux_bin) as scope:
        socket_name = f"aimux-phase8-command-{os.getpid()}-{int(time.time() * 1000)}"
        scope.tmux_socket_name = socket_name
        install_tmux_socket_wrapper(scope, tmux, socket_name)
        run([tmux, "-L", socket_name, "start-server"], env=without_tmux(os.environ.copy()), timeout=10)
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
        run([tmux, "-L", socket_name, "start-server"], env=without_tmux(os.environ.copy()), timeout=10)
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


def seed_initial_commit(scope: Scope) -> None:
    readme = scope.project / "README.md"
    readme.write_text("phase8 command resolution smoke\n")
    run(["git", "add", "README.md"], cwd=scope.project, env=scope.env, timeout=10)
    run(["git", "commit", "-q", "-m", "initial"], cwd=scope.project, env=scope.env, timeout=10)


def install_shell_tool_config(scope: Scope) -> None:
    config_path = scope.project / ".aimux" / "config.json"
    config = json.loads(config_path.read_text())
    tools = config.setdefault("tools", {})
    tools["shell"] = {
        "command": "/bin/sh",
        "args": [],
        "enabled": True,
        "wrapperEnabled": False,
        "promptPatterns": ["^[$#] "],
        "turnPatterns": [],
    }
    config_path.write_text(json.dumps(config, indent=2) + "\n")


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


def tmux_cmd_for_socket(tmux: str, socket_name: str, args: list[str]) -> subprocess.CompletedProcess[str]:
    return run([tmux, "-L", socket_name, *args], env=without_tmux(os.environ.copy()), timeout=10)


def tmux_cmd(scope: Scope, args: list[str]) -> subprocess.CompletedProcess[str]:
    tmux = scope.real_tmux or find_tmux()
    return run([tmux, "-L", scope.tmux_socket_name or "aimux-phase8", *args], env=scope.env, timeout=10)


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


def install_tmux_socket_wrapper(scope: Scope, real_tmux: str, socket_name: str) -> None:
    bin_dir = scope.root / "bin"
    bin_dir.mkdir(parents=True, exist_ok=True)
    wrapper = bin_dir / "tmux"
    wrapper.write_text(
        "#!/bin/sh\n"
        f"exec {shlex.quote(real_tmux)} -L {shlex.quote(socket_name)} \"$@\"\n"
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
    if name == "dashboard":
        return run_dashboard_render_smoke(aimux_bin, mutation)
    if name == "dashboard-attach":
        return run_dashboard_attach_smoke(aimux_bin, mutation)
    if name == "command-resolution":
        return run_command_resolution_smoke(aimux_bin, mutation)
    if name == "agent-shell":
        return run_agent_shell_spawn_smoke(aimux_bin, mutation)
    if name == "sse":
        return run_sse_stress(aimux_bin, mutation)
    if name == "process":
        return run_process_race_smoke(aimux_bin, mutation)
    raise LiveResidualFailure(f"unknown suite: {name}")


def prove_failures(args: argparse.Namespace, aimux_bin: Path) -> list[dict[str, Any]]:
    mutations = {
        "tmux": "tmux-drop-output",
        "dashboard": "dashboard-empty-frame",
        "dashboard-attach": "dashboard-attach-terminal-error",
        "command-resolution": "command-unsupported",
        "agent-shell": "agent-shell-missing-window",
        "sse": "sse-reorder",
        "process": "process-delete-endpoint",
    }
    proof = []
    for suite, mutation in mutations.items():
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
        result = run(command, timeout=90, check=False)
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
            "dashboard-attach",
            "command-resolution",
            "agent-shell",
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
        "dashboard-attach-terminal-error",
        "command-unsupported",
        "agent-shell-missing-window",
        "sse-reorder",
        "process-delete-endpoint",
    ])
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    try:
        aimux_bin = build_aimux(args)
        suites = [
            "tmux",
            "dashboard",
            "dashboard-attach",
            "command-resolution",
            "agent-shell",
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


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
