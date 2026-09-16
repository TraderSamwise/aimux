#!/usr/bin/env python3
"""End-to-end gate for paths that only fail against an installed Aimux runtime."""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import platform
import shutil
import subprocess
import sys
import tempfile
import textwrap
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable


ROOT = Path(__file__).resolve().parents[1]
PHASE8_PATH = ROOT / "scripts" / "phase8-live-residuals.py"
FULL_CHECKS = ("loop", "input", "liveness", "transcript", "git-leak")
LOCAL_CHECKS = ("git-leak", "sensitive-egress")
CHECKS = ("loop", "input", "liveness", "transcript", "git-leak", "sensitive-egress")
SCENARIOS = ("full", "local")
SENSITIVE_STORES = (
    "context",
    "history",
    "attachments",
    "plans",
    "status",
    "tasks",
    "threads",
    "recordings",
    "worktrees",
)
MUTATIONS = (
    "loop-no-enroll",
    "input-drop",
    "liveness-skip-kill",
    "transcript-no-genuine",
    "git-leak-no-outer-ignore",
    "git-leak-no-attachments-rule",
    "sensitive-egress-nonloopback",
)
MUTATION_TO_CHECK = {
    "loop-no-enroll": "loop",
    "input-drop": "input",
    "liveness-skip-kill": "liveness",
    "transcript-no-genuine": "transcript",
    "git-leak-no-outer-ignore": "git-leak",
    "git-leak-no-attachments-rule": "git-leak",
    "sensitive-egress-nonloopback": "sensitive-egress",
}


class GateFailure(Exception):
    pass


def load_phase8() -> Any:
    spec = importlib.util.spec_from_file_location("phase8_live_residuals", PHASE8_PATH)
    if spec is None or spec.loader is None:
        raise GateFailure(f"unable to load {PHASE8_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def run(
    args: list[str],
    *,
    cwd: Path = ROOT,
    env: dict[str, str] | None = None,
    timeout: int = 120,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    print(f"$ {' '.join(args)}")
    result = subprocess.run(
        args,
        cwd=str(cwd),
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
    )
    if result.stdout:
        print(result.stdout, end="" if result.stdout.endswith("\n") else "\n")
    if result.stderr:
        print(result.stderr, end="" if result.stderr.endswith("\n") else "\n", file=sys.stderr)
    print(f"exit={result.returncode}")
    if check and result.returncode != 0:
        raise GateFailure(f"command failed with exit {result.returncode}: {' '.join(args)}")
    return result


def parse_json_stdout(stdout: str, label: str) -> dict[str, Any]:
    try:
        value = json.loads(stdout)
    except json.JSONDecodeError as error:
        raise GateFailure(f"{label} did not return JSON: {error}\n{stdout}") from error
    if not isinstance(value, dict):
        raise GateFailure(f"{label} returned non-object JSON: {value!r}")
    return value


def wait_until(label: str, timeout: float, interval: float, probe: Callable[[], Any]) -> Any:
    deadline = time.monotonic() + timeout
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            value = probe()
            if value:
                return value
        except Exception as error:  # noqa: BLE001 - surfaced on timeout.
            last_error = error
        time.sleep(interval)
    if last_error is not None:
        raise GateFailure(f"timed out waiting for {label}: {last_error}")
    raise GateFailure(f"timed out waiting for {label}")


def build_release_asset(work: Path, variant: str = "full") -> Path:
    release_dir = work / "release"
    env = os.environ.copy()
    env["AIMUX_PACKAGE_PROFILE"] = "minimal"
    env["AIMUX_BUILD_VARIANT"] = variant
    env["AIMUX_RELEASE_DIR"] = str(release_dir)
    env["AIMUX_RELEASE_VERSION"] = f"0.0.0-installed-gate-{variant}.{os.getpid()}.{int(time.time())}"
    env.setdefault("CARGO_INCREMENTAL", "0")
    env.setdefault(
        "CARGO_TARGET_DIR",
        f"/tmp/aimux-installed-gate-target-{os.environ.get('AIMUX_SESSION_ID', 'manual')}",
    )
    run(["yarn", "release:asset"], env=env, timeout=900)
    pattern = "aimux-local-*.tar.gz" if variant == "local" else "aimux-*.tar.gz"
    assets = sorted(
        [
            path
            for path in release_dir.glob(pattern)
            if variant == "local" or not path.name.startswith("aimux-local-")
        ],
        key=lambda path: path.stat().st_mtime,
    )
    if not assets:
        raise GateFailure(f"{variant} release asset was not produced in {release_dir}")
    return assets[-1]


def install_release_asset(asset: Path, work: Path, *, variant: str = "full") -> Path:
    install_root = work / "install-root"
    bin_dir = work / "bin"
    env = os.environ.copy()
    env["AIMUX_INSTALL_ROOT"] = str(install_root)
    env["AIMUX_BIN_DIR"] = str(bin_dir)
    env["AIMUX_SKIP_POST_INSTALL_RESTART"] = "1"
    env["AIMUX_INSTALL_VARIANT"] = variant
    run(["bash", "scripts/install.sh", str(asset)], env=env, timeout=120)
    aimux_bin = bin_dir / "aimux"
    if not aimux_bin.is_file():
        raise GateFailure(f"installed aimux shim missing at {aimux_bin}")
    return aimux_bin


def installed_native_binary(work: Path) -> Path:
    matches = sorted((work / "install-root").glob("*/native/*/aimux"))
    if len(matches) != 1:
        raise GateFailure(f"expected one installed native binary, found {matches}")
    if not matches[0].is_file():
        raise GateFailure(f"installed native binary missing at {matches[0]}")
    return matches[0]


def host_platform_arch() -> str:
    system = platform.system()
    machine = platform.machine().lower()
    if system == "Darwin":
        host_platform = "darwin"
    elif system == "Linux":
        host_platform = "linux"
    else:
        raise GateFailure(f"unsupported platform for local gate: {system}")
    if machine in {"x86_64", "amd64"}:
        arch = "x64"
    elif machine in {"arm64", "aarch64"}:
        arch = "arm64"
    else:
        raise GateFailure(f"unsupported architecture for local gate: {machine}")
    return f"{host_platform}-{arch}"


def write_config(scope: Any) -> None:
    helper = scope.root / "bin" / "gate-shell"
    helper.parent.mkdir(parents=True, exist_ok=True)
    helper.write_text(
        textwrap.dedent(
            """\
            #!/bin/sh
            printf 'GATE_READY:%s\\n' "$AIMUX_SESSION_ID"
            while IFS= read -r line; do
              printf 'GATE_INPUT:%s\\n' "$line"
            done
            """
        ),
        encoding="utf-8",
    )
    helper.chmod(0o755)

    transcript = scope.root / "bin" / "gate-transcript"
    transcript.write_text(
        textwrap.dedent(
            """\
            #!/bin/sh
            root="$(cd "$(dirname "$0")/.." && pwd)"
            count_file="$root/transcript-count"
            count=0
            if [ -f "$count_file" ]; then
              count="$(cat "$count_file" 2>/dev/null || printf 0)"
            fi
            next=$((count + 1))
            printf '%s\\n' "$next" > "$count_file"
            fixture="mixed"
            if [ "$count" -gt 0 ] && [ ! -f "$root/transcript-no-genuine" ]; then
              fixture="genuine"
            fi
            if [ "$fixture" = "genuine" ]; then
              cat <<'EOF'
            claude - installed gate
            Opus 4.8

            ❯ Press up to edit queued messages for this regression test
            ⏺ Acknowledged.
            EOF
            else
              cat <<'EOF'
            claude - installed gate
            Opus 4.8

            ❯ What did Sam ask us to prove?
            ⏺ The installed runtime must project real prompts without turning composer chrome into a user bubble.
            ────────────────────────────────────────────────────────────────────────────────
            ❯ composer suggestion should not become a bubble
            ────────────────────────────────────────────────────────────────────────────────
              user@host ~/project ██░░░░5% Opus 4.8
              ⏵⏵ bypass permissions on (shift+tab to cycle) · Press up to edit queued messages
            EOF
            fi
            sleep 90
            """
        ),
        encoding="utf-8",
    )
    transcript.chmod(0o755)

    scope.aimux_home.mkdir(parents=True, exist_ok=True)
    (scope.aimux_home / "config.json").write_text(
        json.dumps(
            {
                "loop": {
                    "scanIntervalMs": 250,
                    "scanEveryTicks": 1,
                    "stoppedDwellMs": 600,
                    "nudgeCooldownMs": 600,
                    "unchangedReminderTicks": 1,
                },
                "tools": {
                    "shell": {
                        "command": str(helper),
                        "args": [],
                        "enabled": True,
                        "promptPatterns": ["GATE_READY"],
                    },
                    "claude": {
                        "command": str(transcript),
                        "args": [],
                        "enabled": True,
                        "promptPatterns": ["installed gate"],
                    },
                },
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


def create_scope(phase8: Any, aimux_bin: Path, label: str) -> Any:
    tmux = phase8.find_tmux()
    scope = phase8.Scope(f"installed-gate-{label}", aimux_bin)
    socket_name = f"aimux-installed-gate-{label}-{os.getpid()}-{time.time_ns()}"
    scope.tmux_socket_name = socket_name
    phase8.install_tmux_socket_wrapper(scope, tmux, socket_name)
    phase8.run([tmux, "-L", socket_name, "kill-server"], env=phase8.without_tmux(os.environ.copy()), timeout=10, check=False)
    scope.init_git_project()
    write_config(scope)
    return scope


def aimux(scope: Any, args: list[str], *, timeout: int = 60, check: bool = True) -> subprocess.CompletedProcess[str]:
    return run([str(scope.aimux_bin), *args], cwd=scope.project, env=scope.env, timeout=timeout, check=check)


def spawn_session_payload(scope: Any, tool: str = "shell", extra_env: dict[str, str] | None = None) -> dict[str, Any]:
    env = scope.env.copy()
    if extra_env:
        env.update(extra_env)
    result = run(
        [str(scope.aimux_bin), "spawn", "--tool", tool, "--project", str(scope.project), "--no-open", "--json"],
        cwd=scope.project,
        env=env,
        timeout=60,
    )
    payload = parse_json_stdout(result.stdout, f"spawn {tool}")
    session_id = str(payload.get("sessionId") or "")
    if not session_id:
        raise GateFailure(f"spawn {tool} returned no sessionId: {payload}")
    return payload


def spawn_session(scope: Any, tool: str = "shell", extra_env: dict[str, str] | None = None) -> str:
    return str(spawn_session_payload(scope, tool, extra_env).get("sessionId"))


def start_overseer(scope: Any) -> str:
    result = aimux(
        scope,
        ["overseer", "start", "--tool", "shell", "--project", str(scope.project), "--no-open", "--json"],
    )
    payload = parse_json_stdout(result.stdout, "overseer start")
    session_id = str(payload.get("sessionId") or payload.get("overseerSessionId") or "")
    if not session_id:
        raise GateFailure(f"overseer start returned no sessionId: {payload}")
    return session_id


def read_session(scope: Any, session_id: str) -> str:
    result = aimux(scope, ["host", "agent-read", session_id, "--project", str(scope.project)], timeout=30)
    return result.stdout


def wait_for_ready(scope: Any, session_id: str) -> None:
    wait_until(
        f"{session_id} ready output",
        20,
        0.25,
        lambda: "GATE_READY:" in read_session(scope, session_id),
    )


def project_endpoint(phase8: Any, scope: Any) -> str:
    return phase8.wait_for_project_service_endpoint(scope)


def http_json(endpoint: str, method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
    data = None if body is None else json.dumps(body).encode("utf-8")
    url = f"{endpoint}{path}"
    request = urllib.request.Request(url, data=data, method=method)
    request.add_header("content-type", "application/json")
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.loads(response.read().decode("utf-8"))


def set_activity(endpoint: str, session_id: str, activity: str) -> None:
    response = http_json(endpoint, "POST", "/set-activity", {"session": session_id, "activity": activity})
    if response.get("ok") is not True:
        raise GateFailure(f"set-activity failed: {response}")


def ps(scope: Any, *, check: bool = True) -> dict[str, Any]:
    result = aimux(scope, ["ps", "--project", str(scope.project), "--json"], timeout=30, check=check)
    if result.returncode != 0:
        return {"_error": result.stderr + result.stdout, "_exit": result.returncode}
    try:
        value = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise GateFailure(f"ps --json did not return JSON: {error}\n{result.stdout}") from error
    if isinstance(value, list):
        return {"sessions": value}
    if isinstance(value, dict):
        return value
    raise GateFailure(f"ps --json returned unexpected JSON: {value!r}")


def find_session(payload: dict[str, Any], session_id: str) -> dict[str, Any]:
    for session in payload.get("sessions", []):
        if session.get("id") == session_id:
            return session
    raise GateFailure(f"{session_id} missing from ps output: {payload}")


def check_loop_notification(phase8: Any, aimux_bin: Path, mutation: str | None) -> None:
    with create_scope(phase8, aimux_bin, "loop") as scope:
        aimux(scope, ["daemon", "ensure"], timeout=60)
        overseer = start_overseer(scope)
        worker = spawn_session(scope)
        endpoint = project_endpoint(phase8, scope)
        wait_for_ready(scope, overseer)
        wait_for_ready(scope, worker)
        if mutation != "loop-no-enroll":
            aimux(scope, ["loop", "add", worker, "--goal", "installed runtime gate stopped worker", "--project", str(scope.project)])
        set_activity(endpoint, worker, "done")
        wait_until(
            "overseer loop check delivery",
            25,
            0.5,
            lambda: ("[aimux loop check]" in read_session(scope, overseer)) and (worker in read_session(scope, overseer)),
        )
        print(f"loop notification delivered to overseer={overseer} for worker={worker}")


def check_input_delivery(phase8: Any, aimux_bin: Path, mutation: str | None) -> None:
    with create_scope(phase8, aimux_bin, "input") as scope:
        aimux(scope, ["daemon", "ensure"], timeout=60)
        session_id = spawn_session(scope)
        wait_for_ready(scope, session_id)
        marker = f"installed-gate-input-{os.getpid()}"
        if mutation != "input-drop":
            aimux(scope, ["input", session_id, marker, "--project", str(scope.project)])
        wait_until("input marker in target pane", 12, 0.25, lambda: f"GATE_INPUT:{marker}" in read_session(scope, session_id))
        print(f"agent input became visible in session={session_id}")


def check_liveness(phase8: Any, aimux_bin: Path, mutation: str | None) -> None:
    with create_scope(phase8, aimux_bin, "liveness") as scope:
        aimux(scope, ["daemon", "ensure"], timeout=60)
        spawned = spawn_session_payload(scope)
        session_id = str(spawned.get("sessionId"))
        wait_for_ready(scope, session_id)
        live = find_session(ps(scope), session_id)
        status = str(live.get("status") or "")
        if status not in {"starting", "running", "idle"}:
            raise GateFailure(f"expected live session status, got {status}: {live}")
        target = spawned.get("tmuxTarget") or {}
        window_id = str(target.get("windowId") or "")
        if not window_id:
            raise GateFailure(f"spawned live session has no tmux window target: {spawned}")
        if mutation != "liveness-skip-kill":
            real_tmux = phase8.find_tmux()
            phase8.run([real_tmux, "-L", scope.tmux_socket_name, "kill-window", "-t", window_id], env=phase8.without_tmux(os.environ.copy()), timeout=10)
        wait_until(
            "ps to report killed window offline",
            15,
            0.4,
            lambda: find_session(ps(scope), session_id).get("status") == "offline",
        )

        unreadable_session = spawn_session(scope)
        wait_for_ready(scope, unreadable_session)
        tmux_wrapper = scope.root / "bin" / "tmux"
        tmux_wrapper.write_text("#!/bin/sh\necho installed-gate forced tmux failure >&2\nexit 77\n", encoding="utf-8")
        tmux_wrapper.chmod(0o755)
        unreadable = ps(scope, check=False)
        if int(unreadable.get("_exit") or 0) == 0:
            raise GateFailure(f"expected ps to fail when tmux is unqueryable, got success: {unreadable}")
        if "tmux" not in str(unreadable.get("_error", "")).lower():
            raise GateFailure(f"unqueryable runtime error did not name tmux: {unreadable}")
        print(f"ps liveness covered live, window gone, and tmux unqueryable for session={session_id}")


def message_texts(payload: dict[str, Any], role: str | None = None) -> list[str]:
    texts: list[str] = []
    for message in payload.get("messages", []):
        if role is not None and message.get("role") != role:
            continue
        text = message.get("text")
        if isinstance(text, str):
            texts.append(text)
    return texts


def agent_output(endpoint: str, session_id: str) -> dict[str, Any]:
    quoted = urllib.parse.quote(session_id, safe="")
    return http_json(endpoint, "GET", f"/agents/output?sessionId={quoted}&mode=chat")


def check_transcript_projection(phase8: Any, aimux_bin: Path, mutation: str | None) -> None:
    with create_scope(phase8, aimux_bin, "transcript") as scope:
        aimux(scope, ["daemon", "ensure"], timeout=60)
        chrome_session = spawn_session(scope, "claude")
        if mutation == "transcript-no-genuine":
            (scope.root / "transcript-no-genuine").write_text("1\n", encoding="utf-8")
        genuine_session = spawn_session(scope, "claude")
        endpoint = project_endpoint(phase8, scope)
        wait_until("chrome transcript output", 10, 0.25, lambda: "What did Sam ask us to prove?" in read_session(scope, chrome_session))
        wait_until("genuine transcript output", 10, 0.25, lambda: "Press up to edit queued messages" in read_session(scope, genuine_session))
        chrome_payload = agent_output(endpoint, chrome_session)
        genuine_payload = agent_output(endpoint, genuine_session)
        chrome_user = "\n".join(message_texts(chrome_payload, "user"))
        genuine_user = "\n".join(message_texts(genuine_payload, "user"))
        if "What did Sam ask us to prove?" not in chrome_user:
            raise GateFailure(f"real prompt missing from chrome fixture messages: {chrome_payload}")
        if "Press up to edit queued messages" in chrome_user:
            raise GateFailure(f"composer chrome leaked into GUI user messages: {chrome_payload}")
        if "Press up to edit queued messages for this regression test" not in genuine_user:
            raise GateFailure(f"genuine prompt missing from GUI user messages: {genuine_payload}")
        print(f"transcript projection filtered chrome and preserved genuine prompt for sessions={chrome_session},{genuine_session}")


def root_gitignore_has_aimux_entry(contents: str) -> bool:
    for line in contents.splitlines():
        pattern = line.split("#", 1)[0].strip()
        if pattern in {".aimux/", "/.aimux/", ".aimux", "/.aimux"}:
            return True
    return False


def remove_gitignore_line(path: Path, expected: str) -> None:
    contents = path.read_text(encoding="utf-8")
    lines = [line for line in contents.splitlines() if line.strip() != expected]
    path.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")


def sensitive_store_fixture_paths(project: Path) -> list[Path]:
    return [
        project / ".aimux" / "context" / "gate-session" / "summary.md",
        project / ".aimux" / "history" / "gate-session.jsonl",
        project / ".aimux" / "attachments" / "gate-attachment.txt",
        project / ".aimux" / "plans" / "gate-session.md",
        project / ".aimux" / "status" / "gate-session.md",
        project / ".aimux" / "tasks" / "gate-task.json",
        project / ".aimux" / "threads" / "gate-thread.jsonl",
        project / ".aimux" / "recordings" / "gate-session.cast",
        project / ".aimux" / "worktrees" / "gate-worktree" / "sensitive.txt",
    ]


def seed_sensitive_store_fixtures(project: Path) -> list[Path]:
    paths = sensitive_store_fixture_paths(project)
    for path in paths:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"installed-runtime-gate sensitive fixture for {path}\n", encoding="utf-8")
    return paths


def assert_git_add_cannot_stage(scope: Any, paths: list[Path]) -> None:
    relative_paths = [str(path.relative_to(scope.project)) for path in paths]
    result = run(["git", "add", "-n", *relative_paths], cwd=scope.project, env=scope.env, timeout=30, check=False)
    combined = f"{result.stdout}\n{result.stderr}"
    staged = [line for line in result.stdout.splitlines() if line.startswith("add ")]
    if result.returncode == 0 or staged:
        raise GateFailure(
            "sensitive .aimux data could be staged by git add -n "
            f"exit={result.returncode} staged={staged} output={combined}"
        )
    if "ignored" not in combined.lower():
        raise GateFailure(f"git add -n rejected sensitive data without proving ignore coverage: {combined}")


def assert_sensitive_gitignore_rules(project: Path) -> None:
    root_gitignore = project / ".gitignore"
    inner_gitignore = project / ".aimux" / ".gitignore"
    root_contents = root_gitignore.read_text(encoding="utf-8")
    inner_contents = inner_gitignore.read_text(encoding="utf-8")
    if not root_gitignore_has_aimux_entry(root_contents):
        raise GateFailure(f"{root_gitignore} does not contain a root .aimux/ ignore entry")
    missing = [store for store in SENSITIVE_STORES if f"{store}/" not in inner_contents]
    if missing:
        raise GateFailure(f"{inner_gitignore} is missing sensitive store ignore rules: {missing}")


def check_git_leak(phase8: Any, aimux_bin: Path, mutation: str | None) -> None:
    with create_scope(phase8, aimux_bin, "git-leak") as scope:
        run(["git", "config", "core.excludesFile", "/dev/null"], cwd=scope.project, env=scope.env, timeout=10)
        aimux(scope, ["init"], timeout=60)
        root_gitignore = scope.project / ".gitignore"
        inner_gitignore = scope.project / ".aimux" / ".gitignore"
        if mutation == "git-leak-no-outer-ignore":
            remove_gitignore_line(root_gitignore, ".aimux/")
        if mutation == "git-leak-no-attachments-rule":
            remove_gitignore_line(inner_gitignore, "attachments/")
        assert_sensitive_gitignore_rules(scope.project)
        fixture_paths = seed_sensitive_store_fixtures(scope.project)
        assert_git_add_cannot_stage(scope, fixture_paths)
        print(
            "git leak gate verified first-use root .aimux/ ignore and generated sensitive store rules "
            f"for {len(fixture_paths)} representative paths"
        )


def install_variant_refusal(asset: Path, install_variant: str, expected: str) -> None:
    with tempfile.TemporaryDirectory(prefix=f"aimux-installed-runtime-gate-refusal-{install_variant}-") as temp:
        root = Path(temp)
        env = os.environ.copy()
        env["AIMUX_INSTALL_ROOT"] = str(root / "install-root")
        env["AIMUX_BIN_DIR"] = str(root / "bin")
        env["AIMUX_SKIP_POST_INSTALL_RESTART"] = "1"
        env["AIMUX_INSTALL_VARIANT"] = install_variant
        result = run(["bash", "scripts/install.sh", str(asset)], env=env, timeout=120, check=False)
        if result.returncode == 0:
            raise GateFailure(f"{expected} was accepted unexpectedly by {install_variant} install path")
        combined = f"{result.stdout}\n{result.stderr}"
        if expected not in combined:
            raise GateFailure(
                f"{install_variant} install refusal did not name variant mismatch {expected!r}: {combined}"
            )
        print(f"{install_variant} install path rejected {asset.name}: {expected}")


def string_count(binary: Path, needle: str) -> int:
    print(f"$ strings {binary} | count {needle}")
    result = subprocess.run(
        ["strings", str(binary)],
        cwd=str(ROOT),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=120,
    )
    if result.stderr:
        print(result.stderr, end="" if result.stderr.endswith("\n") else "\n", file=sys.stderr)
    print(f"exit={result.returncode}")
    if result.returncode != 0:
        raise GateFailure(f"strings failed with exit {result.returncode}: {binary}")
    return result.stdout.count(needle)


def assert_no_remote_strings(binary: Path) -> None:
    needles = ("AIMUX_RELAY_URL", "relay.aimux.app", "tokio_tungstenite", "wss://")
    counts = {needle: string_count(binary, needle) for needle in needles}
    for needle, count in counts.items():
        print(f"local strings count {needle}={count}")
    nonzero = {needle: count for needle, count in counts.items() if count != 0}
    if nonzero:
        raise GateFailure(f"local binary contains remote-control strings: {nonzero}")


def assert_no_remote_help(aimux_bin: Path) -> None:
    result = run([str(aimux_bin), "--help"], timeout=30)
    forbidden = {"remote", "hosted", "login", "logout", "whoami", "security"}
    command_lines = []
    for line in result.stdout.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        command = stripped.split()[0]
        if command in forbidden:
            command_lines.append(line)
    print(f"local forbidden help commands found={len(command_lines)}")
    if command_lines:
        raise GateFailure(f"local --help lists remote-control commands: {command_lines}")


def assert_local_cargo_tree_has_no_remote_dependencies() -> None:
    args = ["cargo", "tree", "--manifest-path", "native/Cargo.toml", "-p", "aimux", "--no-default-features"]
    print(f"$ {' '.join(args)}")
    result = subprocess.run(
        args,
        cwd=str(ROOT),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=120,
    )
    if result.stderr:
        print(result.stderr, end="" if result.stderr.endswith("\n") else "\n", file=sys.stderr)
    print(f"exit={result.returncode}")
    if result.returncode != 0:
        raise GateFailure(f"cargo tree failed with exit {result.returncode}")
    forbidden = ("tungstenite", "ureq")
    hits = [line for line in result.stdout.splitlines() if any(name in line for name in forbidden)]
    print(f"local cargo tree remote dependency hits={len(hits)}")
    if hits:
        raise GateFailure(f"local cargo tree contains remote-control dependencies: {hits}")


def assert_sensitive_store_egress_static_boundary() -> None:
    boundary_source = (ROOT / "scripts" / "check-local-build-boundary.sh").read_text(encoding="utf-8")
    required_forbidden_strings = (
        "AIMUX_RELAY_URL",
        "relay[.]aimux[.]app",
        "maybe_host_published_attachment",
        "attachments/hosted",
        "tokio[-_]tungstenite",
        "tungstenite",
        "ureq",
    )
    missing = [needle for needle in required_forbidden_strings if needle not in boundary_source]
    if missing:
        raise GateFailure(f"local boundary script no longer checks remote egress strings: {missing}")
    runtime_source = (ROOT / "native" / "crates" / "aimux" / "src" / "daemon_state.rs").read_text(encoding="utf-8")
    if "AIMUX_DAEMON_HOST must be loopback" not in runtime_source:
        raise GateFailure("daemon host loopback-only guard is missing from daemon_state.rs")
    print(f"sensitive-store egress static boundary covers stores={','.join(SENSITIVE_STORES)}")


def collect_pid_values(value: Any) -> set[int]:
    pids: set[int] = set()
    if isinstance(value, dict):
        for key, child in value.items():
            if key == "pid" and isinstance(child, int) and child > 0:
                pids.add(child)
            else:
                pids.update(collect_pid_values(child))
    elif isinstance(value, list):
        for child in value:
            pids.update(collect_pid_values(child))
    return pids


def live_pid(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def control_plane_pids(scope: Any) -> set[int]:
    pids: set[int] = set()
    for path in [scope.aimux_home / "daemon" / "daemon.json", scope.aimux_home / "daemon" / "state.json"]:
        try:
            pids.update(collect_pid_values(json.loads(path.read_text(encoding="utf-8"))))
        except FileNotFoundError:
            continue
        except json.JSONDecodeError as error:
            raise GateFailure(f"could not parse runtime pid file {path}: {error}") from error
    pids.update(scope.project_service_pids())
    return {pid for pid in pids if live_pid(pid)}


def lsof_tcp_rows_for_pids(pids: set[int]) -> list[str]:
    if not pids:
        return []
    lsof = shutil.which("lsof")
    if not lsof:
        raise GateFailure("lsof is required for sensitive-store egress runtime proof")
    result = subprocess.run(
        [lsof, "-nP", "-a", "-iTCP", "-p", ",".join(str(pid) for pid in sorted(pids))],
        cwd=str(ROOT),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=20,
    )
    if result.stderr:
        print(result.stderr, end="" if result.stderr.endswith("\n") else "\n", file=sys.stderr)
    if result.returncode not in {0, 1}:
        raise GateFailure(f"lsof failed with exit {result.returncode}: {result.stderr}")
    lines = [line for line in result.stdout.splitlines() if line.strip()]
    return lines[1:] if lines and lines[0].startswith("COMMAND") else lines


def lsof_name(row: str) -> str:
    parts = row.split()
    return " ".join(parts[8:]) if len(parts) >= 9 else row


def endpoint_is_loopback(endpoint: str) -> bool:
    lowered = endpoint.lower()
    return (
        "127.0.0.1:" in lowered
        or "localhost:" in lowered
        or "[::1]:" in lowered
        or lowered.startswith("::1:")
    )


def tcp_name_is_loopback_only(name: str) -> bool:
    endpoints = name.split("->")
    return all(endpoint_is_loopback(endpoint.split(" (", 1)[0]) for endpoint in endpoints)


def start_nonloopback_listener(scope: Any) -> int:
    helper = scope.root / "bin" / "nonloopback-listener.py"
    port_file = scope.root / "nonloopback-listener-port"
    helper.write_text(
        textwrap.dedent(
            """\
            import socket
            import sys
            import time
            from pathlib import Path

            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock.bind(("0.0.0.0", 0))
            sock.listen(1)
            Path(sys.argv[1]).write_text(str(sock.getsockname()[1]), encoding="utf-8")
            time.sleep(60)
            """
        ),
        encoding="utf-8",
    )
    proc = scope.popen([sys.executable, str(helper), str(port_file)])
    wait_until("non-loopback mutation listener", 5, 0.1, lambda: port_file.exists())
    return int(proc.pid)


def assert_no_non_loopback_network_surface(scope: Any, extra_pids: set[int] | None = None) -> None:
    pids = wait_until("local control-plane pids", 10, 0.25, lambda: control_plane_pids(scope))
    if extra_pids:
        pids = set(pids) | extra_pids
    rows = lsof_tcp_rows_for_pids(set(pids))
    violations = [row for row in rows if not tcp_name_is_loopback_only(lsof_name(row))]
    print(f"local egress lsof sampled pids={sorted(pids)} tcp_rows={len(rows)} non_loopback={len(violations)}")
    if violations:
        raise GateFailure(
            "local runtime exposed a non-loopback network surface while sensitive stores existed:\n"
            + "\n".join(violations)
        )


def check_sensitive_store_egress(phase8: Any, aimux_bin: Path, mutation: str | None) -> None:
    assert_sensitive_store_egress_static_boundary()
    with create_scope(phase8, aimux_bin, "sensitive-egress") as scope:
        aimux(scope, ["init"], timeout=60)
        fixture_paths = seed_sensitive_store_fixtures(scope.project)
        aimux(scope, ["daemon", "ensure"], timeout=60)
        extra_pids = {start_nonloopback_listener(scope)} if mutation == "sensitive-egress-nonloopback" else None
        assert_no_non_loopback_network_surface(scope, extra_pids)
        session_id = spawn_session(scope)
        wait_for_ready(scope, session_id)
        find_session(ps(scope), session_id)
        for _ in range(3):
            assert_no_non_loopback_network_surface(scope)
            time.sleep(0.5)
        print(
            "sensitive-store egress gate verified local runtime has no non-loopback surface "
            f"while {len(fixture_paths)} sensitive fixtures exist"
        )


def check_local_functioning_runtime(phase8: Any, aimux_bin: Path) -> None:
    with create_scope(phase8, aimux_bin, "local") as scope:
        aimux(scope, ["init"], timeout=60)
        aimux(scope, ["daemon", "ensure"], timeout=60)
        session_id = spawn_session(scope)
        wait_for_ready(scope, session_id)
        live = find_session(ps(scope), session_id)
        status = str(live.get("status") or "")
        if status not in {"starting", "running", "idle"}:
            raise GateFailure(f"local installed runtime spawned session has unexpected status {status}: {live}")
        print(f"local installed runtime initialized project and ps reported session={session_id} status={status}")


def run_local_scenario(phase8: Any, work: Path, only: str, mutation: str | None) -> None:
    platform_arch = host_platform_arch()
    print(f"building full archive for real variant-refusal proof on {platform_arch}")
    full_asset = build_release_asset(work, "full")
    print(f"building local archive through release:asset on {platform_arch}")
    local_asset = build_release_asset(work, "local")

    install_variant_refusal(full_asset, "local", "release archive BUILD_VARIANT mismatch: expected local, got full")
    install_variant_refusal(local_asset, "full", "release archive BUILD_VARIANT mismatch: expected full, got local")

    aimux_bin = install_release_asset(local_asset, work, variant="local")
    native_bin = installed_native_binary(work)
    print(f"installed local runtime under {aimux_bin}")
    print(f"installed local native binary {native_bin}")

    run(
        [
            "bash",
            "scripts/check-local-build-boundary.sh",
            "--archive",
            str(local_asset),
            "--platform-arch",
            platform_arch,
            "--skip-cargo-tree",
        ],
        timeout=120,
    )
    assert_no_remote_strings(native_bin)
    assert_no_remote_help(aimux_bin)
    assert_local_cargo_tree_has_no_remote_dependencies()
    check_local_functioning_runtime(phase8, aimux_bin)
    local_runners = {
        "git-leak": check_git_leak,
        "sensitive-egress": check_sensitive_store_egress,
    }
    for name in selected_checks(only, LOCAL_CHECKS):
        if mutation and MUTATION_TO_CHECK[mutation] != name:
            continue
        print(f"\n== installed-runtime-gate:{name}:local ==")
        local_runners[name](phase8, aimux_bin, mutation)


def selected_checks(only: str, available: tuple[str, ...]) -> tuple[str, ...]:
    if only == "all":
        return available
    return (only,) if only in available else ()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--asset", type=Path, help="install this release asset instead of building one")
    parser.add_argument("--only", choices=("all", *CHECKS), default="all")
    parser.add_argument("--scenario", choices=("all", *SCENARIOS), default="full")
    parser.add_argument("--mutate", choices=MUTATIONS, help="deliberately sabotage one check for fail-proofing")
    parser.add_argument("--list-checks", action="store_true", help="print gate check names and exit")
    parser.add_argument("--list-scenarios", action="store_true", help="print gate scenario names and exit")
    args = parser.parse_args()

    if args.list_checks:
        print("\n".join(CHECKS))
        return 0
    if args.list_scenarios:
        print("\n".join(SCENARIOS))
        return 0
    if args.asset and args.scenario != "full":
        raise GateFailure("--asset is only supported with --scenario full")

    scenario_checks = {
        "full": FULL_CHECKS,
        "local": LOCAL_CHECKS,
        "all": CHECKS,
    }[args.scenario]
    if args.only != "all" and args.only not in scenario_checks:
        raise GateFailure(f"--only {args.only} is not available for --scenario {args.scenario}")

    mutation_check = MUTATION_TO_CHECK.get(args.mutate) if args.mutate else None
    if args.mutate and args.only not in {"all", mutation_check}:
        raise GateFailure(f"--mutate {args.mutate} only applies to --only {mutation_check}")
    if mutation_check and mutation_check not in scenario_checks:
        raise GateFailure(f"--mutate {args.mutate} is not available for --scenario {args.scenario}")

    phase8 = load_phase8()
    with tempfile.TemporaryDirectory(prefix="aimux-installed-runtime-gate-") as temp:
        work = Path(temp)
        if args.scenario in {"full", "all"}:
            asset = args.asset.resolve() if args.asset else build_release_asset(work, "full")
            if not asset.is_file():
                raise GateFailure(f"release asset does not exist: {asset}")
            print(f"using release asset {asset}")
            aimux_bin = install_release_asset(asset, work)
            print(f"installed runtime under {aimux_bin}")

            runners = {
                "loop": check_loop_notification,
                "input": check_input_delivery,
                "liveness": check_liveness,
                "transcript": check_transcript_projection,
                "git-leak": check_git_leak,
            }
            for name in selected_checks(args.only, FULL_CHECKS):
                if mutation_check is not None and name != mutation_check:
                    continue
                print(f"\n== installed-runtime-gate:{name} ==")
                runners[name](phase8, aimux_bin, args.mutate)
        if args.scenario in {"local", "all"}:
            print("\n== installed-runtime-gate:local ==")
            run_local_scenario(phase8, work, args.only, args.mutate)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except GateFailure as error:
        print(f"installed-runtime-gate failed: {error}", file=sys.stderr)
        raise SystemExit(1)
    except subprocess.TimeoutExpired as error:
        print(f"installed-runtime-gate timed out: {error}", file=sys.stderr)
        raise SystemExit(1)
