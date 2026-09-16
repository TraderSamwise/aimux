#!/usr/bin/env python3
"""End-to-end gate for paths that only fail against an installed Aimux runtime."""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
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
CHECKS = ("loop", "input", "liveness", "transcript")
MUTATIONS = (
    "loop-no-enroll",
    "input-drop",
    "liveness-skip-kill",
    "transcript-no-genuine",
)


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


def build_release_asset(work: Path) -> Path:
    release_dir = work / "release"
    env = os.environ.copy()
    env["AIMUX_BUILD_PROFILE"] = "local"
    env["AIMUX_RELEASE_DIR"] = str(release_dir)
    env["AIMUX_RELEASE_VERSION"] = f"0.0.0-installed-gate.{os.getpid()}.{int(time.time())}"
    env.setdefault("CARGO_INCREMENTAL", "0")
    env.setdefault(
        "CARGO_TARGET_DIR",
        f"/tmp/aimux-installed-gate-target-{os.environ.get('AIMUX_SESSION_ID', 'manual')}",
    )
    run(["yarn", "release:asset"], env=env, timeout=900)
    assets = sorted(release_dir.glob("aimux-*.tar.gz"), key=lambda path: path.stat().st_mtime)
    if not assets:
        raise GateFailure(f"release asset was not produced in {release_dir}")
    return assets[-1]


def install_release_asset(asset: Path, work: Path) -> Path:
    install_root = work / "install-root"
    bin_dir = work / "bin"
    env = os.environ.copy()
    env["AIMUX_INSTALL_ROOT"] = str(install_root)
    env["AIMUX_BIN_DIR"] = str(bin_dir)
    env["AIMUX_SKIP_POST_INSTALL_RESTART"] = "1"
    run(["bash", "scripts/install.sh", str(asset)], env=env, timeout=120)
    aimux_bin = bin_dir / "aimux"
    if not aimux_bin.is_file():
        raise GateFailure(f"installed aimux shim missing at {aimux_bin}")
    return aimux_bin


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


def selected_checks(only: str) -> tuple[str, ...]:
    return CHECKS if only == "all" else (only,)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--asset", type=Path, help="install this release asset instead of building one")
    parser.add_argument("--only", choices=("all", *CHECKS), default="all")
    parser.add_argument("--mutate", choices=MUTATIONS, help="deliberately sabotage one check for fail-proofing")
    parser.add_argument("--list-checks", action="store_true", help="print gate check names and exit")
    args = parser.parse_args()

    if args.list_checks:
        print("\n".join(CHECKS))
        return 0

    mutation_check = args.mutate.split("-", 1)[0] if args.mutate else None
    if args.mutate and args.only not in {"all", mutation_check}:
        raise GateFailure(f"--mutate {args.mutate} only applies to --only {mutation_check}")

    phase8 = load_phase8()
    with tempfile.TemporaryDirectory(prefix="aimux-installed-runtime-gate-") as temp:
        work = Path(temp)
        asset = args.asset.resolve() if args.asset else build_release_asset(work)
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
        }
        for name in selected_checks(args.only):
            if mutation_check is not None and name != mutation_check:
                continue
            print(f"\n== installed-runtime-gate:{name} ==")
            runners[name](phase8, aimux_bin, args.mutate)
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
