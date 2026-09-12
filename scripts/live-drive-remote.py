#!/usr/bin/env python3
"""Run the unattended live-drive gate against a remote Aimux host.

This is deliberately not part of yarn verify. It installs a release asset on a
real host, then drives the installed versioned binary directly so a concurrent
install cannot silently change the binary under test.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import subprocess
import sys
import tarfile
import tempfile
import textwrap
import time
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONNECT_TIMEOUT = 5
REMOTE_DRIVER = r'''
from __future__ import annotations

import argparse
import http.client
import importlib.util
import json
import os
import re
import shlex
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlparse


class LiveDriveFailure(Exception):
    pass


def load_phase8(path: Path) -> Any:
    spec = importlib.util.spec_from_file_location("phase8_live_residuals", path)
    if spec is None or spec.loader is None:
        raise LiveDriveFailure(f"cannot load phase8 helper from {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def run(args: list[str], *, cwd: Path | None = None, env: dict[str, str] | None = None, timeout: float = 30, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        args,
        cwd=str(cwd) if cwd else None,
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
        check=False,
    )
    if check and result.returncode != 0:
        raise LiveDriveFailure(
            f"command failed ({result.returncode}): {' '.join(args)}\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )
    return result


def http_request_json(url: str, *, method: str = "GET", headers: dict[str, str] | None = None, body: bytes | None = None, timeout: float = 5) -> tuple[int, dict[str, Any], str]:
    parsed = urlparse(url)
    conn = http.client.HTTPConnection(parsed.hostname, parsed.port, timeout=timeout)
    path = parsed.path or "/"
    if parsed.query:
        path += "?" + parsed.query
    conn.request(method, path, body=body, headers=headers or {})
    response = conn.getresponse()
    raw = response.read().decode(errors="replace")
    conn.close()
    try:
        parsed_body = json.loads(raw or "{}")
    except json.JSONDecodeError:
        parsed_body = {}
    return response.status, parsed_body, raw


def ps_sessions(phase8: Any, scope: Any, aimux_bin: Path) -> list[dict[str, Any]]:
    result = phase8.run([str(aimux_bin), "ps", "--json"], cwd=scope.project, env=scope.env, timeout=15, check=False)
    if result.returncode != 0:
        return []
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError:
        return []
    sessions = payload.get("sessions") if isinstance(payload, dict) else payload
    return sessions if isinstance(sessions, list) else []


def check_version(phase8: Any, aimux_bin: Path) -> dict[str, Any]:
    result = run([str(aimux_bin), "--version"], timeout=10)
    version = result.stdout.strip()
    if not version:
        raise LiveDriveFailure(f"{aimux_bin} returned an empty version")
    return {"aimuxBin": str(aimux_bin), "version": version}


def read_embedded_build_stamp(aimux_bin: Path) -> str:
    prefix = b"AIMUX_EMBEDDED_BUILD_STAMP="
    try:
        data = aimux_bin.read_bytes()
    except OSError as error:
        raise LiveDriveFailure(f"could not read installed aimux binary {aimux_bin}: {error}") from error
    start = data.find(prefix)
    if start < 0:
        raise LiveDriveFailure(
            f"installed aimux binary {aimux_bin} is missing embedded BUILD_STAMP witness"
        )
    remainder = data[start + len(prefix):]
    ends = [
        index
        for index in (
            remainder.find(b"\0"),
            remainder.find(b"\n"),
            remainder.find(b"\r"),
        )
        if index >= 0
    ]
    raw = remainder[: min(ends)] if ends else remainder
    match = re.match(rb"[0-9A-Za-z_.:+/-]+", raw)
    stamp = match.group(0).decode(errors="replace") if match else ""
    if not stamp:
        raise LiveDriveFailure(
            f"installed aimux binary {aimux_bin} has an empty embedded BUILD_STAMP witness"
        )
    return stamp


def verify_build_stamp(aimux_bin: Path, expected_build_stamp: str) -> dict[str, str]:
    actual_build_stamp = read_embedded_build_stamp(aimux_bin)
    if actual_build_stamp != expected_build_stamp:
        raise LiveDriveFailure(
            "live-drive build stamp mismatch before checks; refusing to drive unknown binary\n"
            + json.dumps(
                {
                    "aimuxBin": str(aimux_bin),
                    "expectedBuildStamp": expected_build_stamp,
                    "installedBinaryBuildStamp": actual_build_stamp,
                },
                indent=2,
                sort_keys=True,
            )
        )
    evidence = {
        "aimuxBin": str(aimux_bin),
        "verifiedBuildStamp": actual_build_stamp,
    }
    print("LIVE_DRIVE_BUILD_STAMP " + json.dumps(evidence, sort_keys=True), flush=True)
    return evidence


def check_lifecycle(phase8: Any, aimux_bin: Path) -> dict[str, Any]:
    tmux = phase8.find_tmux()
    with phase8.Scope("live-drive-lifecycle", aimux_bin) as scope:
        socket_name = f"aimux-live-lifecycle-{os.getpid()}-{time.time_ns()}"
        scope.tmux_socket_name = socket_name
        phase8.install_tmux_socket_wrapper(scope, tmux, socket_name)
        phase8.run([tmux, "-L", socket_name, "kill-server"], env=phase8.without_tmux(os.environ.copy()), timeout=10, check=False)
        scope.init_git_project()
        phase8.run([str(aimux_bin), "init"], cwd=scope.project, env=scope.env, timeout=30)
        phase8.install_shell_tool_config(scope)

        spawn = phase8.parse_json_stdout(
            phase8.run([str(aimux_bin), "spawn", "--tool", "shell", "--no-open", "--json"], cwd=scope.project, env=scope.env, timeout=30).stdout,
            "live-drive lifecycle spawn",
        )
        session_id = str(spawn.get("sessionId") or "")
        if not session_id:
            raise LiveDriveFailure(f"spawn returned no sessionId: {spawn}")
        phase8.wait_until(
            lambda: phase8.ps_contains_session(scope, aimux_bin, session_id),
            timeout=10,
            label=f"lifecycle spawned session {session_id} in aimux ps",
        )

        label = "live-drive-renamed"
        rename = phase8.parse_json_stdout(
            phase8.run([str(aimux_bin), "rename", session_id, "--label", label, "--json"], cwd=scope.project, env=scope.env, timeout=30).stdout,
            "live-drive lifecycle rename",
        )
        renamed = phase8.wait_until(
            lambda: (
                session
                if (session := phase8.ps_session_by_id(scope, aimux_bin, session_id))
                and session.get("label") == label
                else None
            ),
            timeout=10,
            label=f"renamed lifecycle session {session_id} label {label!r} in aimux ps",
        )

        stop = phase8.parse_json_stdout(
            phase8.run([str(aimux_bin), "stop", session_id, "--json"], cwd=scope.project, env=scope.env, timeout=30).stdout,
            "live-drive lifecycle stop",
        )
        stopped = phase8.wait_until(
            lambda: (
                session
                if (session := phase8.ps_session_by_id(scope, aimux_bin, session_id))
                and session.get("status") in ("offline", "stopped")
                else None
            ),
            timeout=10,
            label=f"stopped lifecycle session {session_id} to become offline in aimux ps",
        )

        kill = phase8.parse_json_stdout(
            phase8.run([str(aimux_bin), "kill", session_id, "--json"], cwd=scope.project, env=scope.env, timeout=30).stdout,
            "live-drive lifecycle kill",
        )
        graveyard = phase8.wait_until(
            lambda: (
                payload
                if phase8.graveyard_contains_session((payload := phase8.graveyard_payload(scope, aimux_bin)), session_id)
                else None
            ),
            timeout=10,
            label=f"killed lifecycle session {session_id} in graveyard",
        )
        return {
            "sessionId": session_id,
            "rename": rename,
            "renamedStatus": renamed.get("status"),
            "stop": stop,
            "stoppedStatus": stopped.get("status"),
            "kill": kill,
            "graveyardEntries": len(graveyard.get("entries", [])),
        }


def check_dashboard_repaint(phase8: Any, aimux_bin: Path, deadline_seconds: float) -> dict[str, Any]:
    tmux = phase8.find_tmux()
    with phase8.Scope("live-drive-dashboard-repaint", aimux_bin) as scope:
        socket_name = f"aimux-live-repaint-{os.getpid()}-{time.time_ns()}"
        scope.tmux_socket_name = socket_name
        phase8.install_tmux_socket_wrapper(scope, tmux, socket_name)
        phase8.run([tmux, "-L", socket_name, "kill-server"], env=phase8.without_tmux(os.environ.copy()), timeout=10, check=False)
        scope.init_git_project()
        phase8.run([str(aimux_bin), "init"], cwd=scope.project, env=scope.env, timeout=30)
        phase8.install_shell_tool_config(scope)
        config_path = scope.project / ".aimux" / "config.json"
        config = json.loads(config_path.read_text())
        config["tools"]["shell"]["args"] = ["-lc", "printf 'live-drive-repaint-ready\\n'; sleep 90"]
        config["tools"]["shell"]["promptPatterns"] = ["live-drive-repaint-ready"]
        config_path.write_text(json.dumps(config, indent=2) + "\n")
        project_root = scope.project.resolve()

        def client_rows() -> list[dict[str, str]]:
            raw = phase8.tmux_cmd_for_socket(
                tmux,
                socket_name,
                ["list-clients", "-F", "#{client_tty}\t#{session_name}\t#{window_id}\t#{window_name}\t#{client_pid}"],
                check=False,
            ).stdout
            rows = []
            for line in raw.splitlines():
                fields = line.split("\t")
                if len(fields) == 5:
                    rows.append({
                        "tty": fields[0],
                        "session": fields[1],
                        "windowId": fields[2],
                        "windowName": fields[3],
                        "pid": fields[4],
                    })
            return rows

        def capture(window_id: str) -> str:
            return phase8.tmux_cmd_for_socket(
                tmux,
                socket_name,
                ["capture-pane", "-p", "-J", "-t", window_id],
                check=False,
            ).stdout

        existing_client_pids = {row["pid"] for row in client_rows()}
        proc, client_fd = phase8.start_process_capture_client(scope, [str(aimux_bin)], cwd=project_root, cols=120, rows=34)
        try:
            dashboard_client = phase8.wait_until(
                lambda: next(
                    (
                        row
                        for row in client_rows()
                        if row["windowName"] == "dashboard" and row["pid"] not in existing_client_pids
                    ),
                    None,
                ),
                timeout=45,
                label="dashboard repaint managed dashboard client",
            )
            window_id = dashboard_client["windowId"]
            initial = phase8.wait_until(
                lambda: (
                    frame
                    if "agent multiplexer" in (frame := capture(window_id))
                    else None
                ),
                timeout=10,
                label="dashboard repaint first frame",
            )
            spawned = []
            for index in range(3):
                payload = phase8.parse_json_stdout(
                    phase8.run([str(aimux_bin), "spawn", "--tool", "shell", "--no-open", "--json"], cwd=scope.project, env=scope.env, timeout=30).stdout,
                    f"dashboard repaint spawn {index + 1}",
                )
                spawned.append(str(payload.get("sessionId") or ""))
            spawned = [session_id for session_id in spawned if session_id]
            phase8.wait_until(
                lambda: (
                    sessions
                    if len((sessions := ps_sessions(phase8, scope, aimux_bin))) >= len(spawned)
                    else None
                ),
                timeout=12,
                label=f"aimux ps to show {len(spawned)} dashboard repaint sessions",
            )

            observations = []
            deadline = time.monotonic() + deadline_seconds
            final = ""
            while time.monotonic() < deadline:
                time.sleep(0.25)
                frame = capture(window_id)
                text = phase8.strip_ansi(frame)
                matching_ids = sum(1 for session_id in spawned if session_id in text)
                shell_count = text.count("shell")
                agent_three = "Agents: 3" in text
                lines = [
                    line.strip()
                    for line in text.splitlines()
                    if "Agents:" in line or "shell" in line or any(session_id in line for session_id in spawned)
                ]
                observations.append({
                    "elapsedMs": int((deadline_seconds - max(0, deadline - time.monotonic())) * 1000),
                    "matchingIds": matching_ids,
                    "shellCount": shell_count,
                    "agentThree": agent_three,
                    "lines": lines[-8:],
                })
                if matching_ids >= 3 or shell_count >= 3 or agent_three:
                    final = text
                    break
            else:
                final = phase8.strip_ansi(capture(window_id))
                raise LiveDriveFailure(
                    "timed out waiting for dashboard repaint to show three spawned sessions without keypress\n"
                    + json.dumps(
                        {
                            "deadlineSeconds": deadline_seconds,
                            "spawned": spawned,
                            "psSessions": [session.get("id") for session in ps_sessions(phase8, scope, aimux_bin)],
                            "observations": observations,
                            "initialTail": phase8.strip_ansi(initial)[-1200:],
                            "finalTail": final[-2000:],
                        },
                        indent=2,
                    )
                )
            phase8.tmux_cmd_for_socket(tmux, socket_name, ["send-keys", "-t", window_id, "q"], check=False)
            return {
                "spawned": spawned,
                "convergedObservation": observations[-1],
                "finalTail": final[-600:],
            }
        finally:
            phase8.terminate_process(proc)
            try:
                os.close(client_fd)
            except OSError:
                pass


def check_sse(phase8: Any, aimux_bin: Path) -> dict[str, Any]:
    return phase8.run_sse_stress(aimux_bin, None)


def check_expose(phase8: Any, aimux_bin: Path) -> dict[str, Any]:
    return phase8.run_expose_interaction_smoke(aimux_bin, None)


def wait_service_port(phase8: Any, scope: Any, aimux_bin: Path, project: Path) -> int:
    def probe() -> int | None:
        result = phase8.run([str(aimux_bin), "daemon", "projects", "--json"], cwd=project, env=scope.env, timeout=15, check=False)
        if result.returncode != 0:
            return None
        try:
            payload = json.loads(result.stdout)
        except json.JSONDecodeError:
            return None
        projects = payload.get("projects") if isinstance(payload, dict) else None
        if not isinstance(projects, list):
            return None
        project_root = str(project.resolve())
        for item in projects:
            if not isinstance(item, dict):
                continue
            if item.get("root") != project_root and item.get("projectRoot") != project_root:
                continue
            endpoint = item.get("serviceEndpoint")
            if isinstance(endpoint, dict) and isinstance(endpoint.get("port"), int):
                return endpoint["port"]
        for item in projects:
            if isinstance(item, dict):
                endpoint = item.get("serviceEndpoint")
                if isinstance(endpoint, dict) and isinstance(endpoint.get("port"), int):
                    return endpoint["port"]
        return None

    return int(phase8.wait_until(probe, timeout=20, label=f"project service port for hosted A/B project {project}"))


def node_hosted_probe(hosted_port: int, service_port: int, token: str, session_id: str, attempts: int) -> dict[str, Any]:
    script = r"""
const hostedPort = Number(process.env.HOSTED_PORT);
const servicePort = Number(process.env.SERVICE_PORT);
const token = process.env.HOSTED_TOKEN;
const sessionId = process.env.SESSION_ID;
const attempts = Number(process.env.ATTEMPTS || "10");
const path = `/agents/output?sessionId=${encodeURIComponent(sessionId)}`;
const directUrl = `http://127.0.0.1:${servicePort}${path}`;
const hostedUrl = `http://127.0.0.1:${hostedPort}/proxy/127.0.0.1/${servicePort}${path}`;
const result = { directUrl, hostedUrl, attempts: [] };
try {
  const direct = await fetch(directUrl);
  result.direct = {
    status: direct.status,
    contentType: direct.headers.get("content-type"),
    bodyPrefix: (await direct.text()).slice(0, 240),
  };
} catch (error) {
  result.direct = {
    error: String(error && error.message || error),
    cause: error && error.cause && (error.cause.code || error.cause.message || String(error.cause)),
  };
}
for (let index = 0; index < attempts; index += 1) {
  try {
    const response = await fetch(hostedUrl, { headers: { authorization: `Bearer ${token}` } });
    result.attempts.push({
      ok: true,
      status: response.status,
      contentType: response.headers.get("content-type"),
      bodyPrefix: (await response.text()).slice(0, 240),
    });
  } catch (error) {
    result.attempts.push({
      ok: false,
      error: String(error && error.message || error),
      cause: error && error.cause && (error.cause.code || error.cause.message || String(error.cause)),
    });
  }
}
console.log(JSON.stringify(result));
"""
    env = os.environ.copy()
    env.update({
        "HOSTED_PORT": str(hosted_port),
        "SERVICE_PORT": str(service_port),
        "HOSTED_TOKEN": token,
        "SESSION_ID": session_id,
        "ATTEMPTS": str(attempts),
    })
    result = run(["node", "--input-type=module", "-e", script], env=env, timeout=30)
    return json.loads(result.stdout)


def check_hosted_proxy(phase8: Any, aimux_bin: Path, attempts: int) -> dict[str, Any]:
    hosted_port = free_port()
    daemon_port = free_port()
    tmux = phase8.find_tmux()
    with phase8.Scope("live-drive-hosted", aimux_bin) as scope:
        socket_name = f"aimux-live-hosted-{os.getpid()}-{time.time_ns()}"
        scope.tmux_socket_name = socket_name
        phase8.install_tmux_socket_wrapper(scope, tmux, socket_name)
        phase8.run([tmux, "-L", socket_name, "kill-server"], env=phase8.without_tmux(os.environ.copy()), timeout=10, check=False)
        scope.env["AIMUX_DAEMON_PORT"] = str(daemon_port)
        scope.init_git_project()
        (scope.aimux_home / "config.json").write_text(
            json.dumps(
                {
                    "hosted": {
                        "enabled": True,
                        "bindAddress": "127.0.0.1",
                        "port": hosted_port,
                        "maxPromptBytes": 2048,
                        "rateLimit": {"requestsPerMinute": 1000, "maxConcurrent": 16},
                    },
                    "tools": {
                        "shell": {
                            "command": "bash",
                            "args": ["--norc", "-i"],
                            "enabled": True,
                            "promptPatterns": ["[$#] $"],
                        }
                    },
                },
                indent=2,
            )
            + "\n"
        )
        phase8.run([str(aimux_bin), "daemon", "ensure"], cwd=scope.project, env=scope.env, timeout=30)
        spawn = phase8.parse_json_stdout(
            phase8.run([str(aimux_bin), "spawn", "--tool", "shell", "--project", str(scope.project), "--no-open", "--json"], cwd=scope.project, env=scope.env, timeout=30).stdout,
            "hosted A/B spawn",
        )
        session_id = str(spawn.get("sessionId") or "")
        if not session_id:
            raise LiveDriveFailure(f"hosted A/B spawn returned no sessionId: {spawn}")
        service_port = wait_service_port(phase8, scope, aimux_bin, scope.project)
        token_output = phase8.run([str(aimux_bin), "hosted", "token", "create", "--label", "live-drive"], cwd=scope.project, env=scope.env, timeout=30).stdout
        token_match = re.search(r"Token:\s+(\S+)", token_output)
        token = token_match.group(1) if token_match else ""
        if not token:
            raise LiveDriveFailure(f"hosted token create did not print a token:\n{token_output}")
        principals = json.loads(phase8.run([str(aimux_bin), "hosted", "token", "list", "--json"], cwd=scope.project, env=scope.env, timeout=30).stdout)
        principal_id = str(principals[0].get("id") or "")
        if not principal_id:
            raise LiveDriveFailure(f"hosted token list returned no principal id: {principals}")
        phase8.run([str(aimux_bin), "hosted", "grant", principal_id, "--project", str(scope.project), "--session", session_id], cwd=scope.project, env=scope.env, timeout=30)

        phase8.wait_until(
            lambda: (
                payload
                if (payload := node_hosted_probe(hosted_port, service_port, token, session_id, 1)).get("direct", {}).get("status") == 200
                else None
            ),
            timeout=30,
            interval=0.5,
            label=f"direct project-service /agents/output for hosted A/B session {session_id}",
        )
        probe = node_hosted_probe(hosted_port, service_port, token, session_id, attempts)
        direct = probe.get("direct", {})
        hosted_attempts = probe.get("attempts", [])
        hosted_ok = [attempt for attempt in hosted_attempts if attempt.get("ok") and attempt.get("status") == 200]
        if direct.get("status") != 200:
            raise LiveDriveFailure("hosted A/B direct route failed\n" + json.dumps(probe, indent=2))
        if not hosted_ok:
            raise LiveDriveFailure(
                "hosted A/B proxy failed while direct project-service route succeeded\n"
                + json.dumps(
                    {
                        "sessionId": session_id,
                        "hostedPort": hosted_port,
                        "servicePort": service_port,
                        "direct": direct,
                        "hostedAttempts": hosted_attempts,
                    },
                    indent=2,
                )
            )
        return {
            "sessionId": session_id,
            "hostedPort": hosted_port,
            "servicePort": service_port,
            "direct": direct,
            "hostedSuccess": hosted_ok[0],
            "attemptCount": len(hosted_attempts),
        }


def tmux_server_pids(socket_name: str) -> list[int]:
    result = run(["ps", "-axo", "pid=,command="], timeout=10)
    pids: list[int] = []
    for line in result.stdout.splitlines():
        if socket_name not in line or "tmux" not in line:
            continue
        parts = line.strip().split(None, 1)
        if not parts:
            continue
        try:
            pid = int(parts[0])
        except ValueError:
            continue
        if pid != os.getpid():
            pids.append(pid)
    return sorted(set(pids))


def check_wedge(phase8: Any, aimux_bin: Path) -> dict[str, Any]:
    tmux = phase8.find_tmux()
    with phase8.Scope("live-drive-wedge", aimux_bin) as scope:
        socket_name = f"aimux-live-wedge-{os.getpid()}-{time.time_ns()}"
        scope.tmux_socket_name = socket_name
        phase8.install_tmux_socket_wrapper(scope, tmux, socket_name)
        phase8.run([tmux, "-L", socket_name, "kill-server"], env=phase8.without_tmux(os.environ.copy()), timeout=10, check=False)
        scope.init_git_project()
        phase8.run([str(aimux_bin), "init"], cwd=scope.project, env=scope.env, timeout=30)
        phase8.install_shell_tool_config(scope)
        spawn = phase8.parse_json_stdout(
            phase8.run([str(aimux_bin), "spawn", "--tool", "shell", "--no-open", "--json"], cwd=scope.project, env=scope.env, timeout=30).stdout,
            "wedge shell spawn",
        )
        session_id = str(spawn.get("sessionId") or "")
        if not session_id:
            raise LiveDriveFailure(f"wedge spawn returned no sessionId: {spawn}")
        phase8.wait_until(lambda: phase8.ps_contains_session(scope, aimux_bin, session_id), timeout=10, label=f"wedge session {session_id} in aimux ps")
        endpoint = phase8.wait_for_project_service_endpoint(scope)
        pids = phase8.wait_until(lambda: tmux_server_pids(socket_name), timeout=10, label=f"tmux server pid for private socket {socket_name}")
        health_results: list[dict[str, Any]] = []

        def health_probe(index: int) -> None:
            started = time.monotonic()
            try:
                status, body, raw = http_request_json(f"{endpoint}/health", timeout=3)
                health_results.append({"index": index, "status": status, "ms": int((time.monotonic() - started) * 1000), "body": body or raw[:120]})
            except Exception as error:
                health_results.append({"index": index, "error": str(error), "ms": int((time.monotonic() - started) * 1000)})

        try:
            for pid in pids:
                os.kill(pid, signal.SIGSTOP)
            threads = [threading.Thread(target=health_probe, args=(index,), daemon=True) for index in range(6)]
            for thread in threads:
                thread.start()
            started = time.monotonic()
            status, body, raw = http_request_json(f"{endpoint}/agents/output?sessionId={quote(session_id)}", timeout=6)
            output_ms = int((time.monotonic() - started) * 1000)
            for thread in threads:
                thread.join(timeout=4)
        finally:
            for pid in pids:
                try:
                    os.kill(pid, signal.SIGCONT)
                except OSError:
                    pass

        body_text = json.dumps(body) if body else raw
        health_ok = [item for item in health_results if item.get("status") == 200]
        if output_ms > 4500:
            raise LiveDriveFailure(
                "wedged tmux route exceeded bounded deadline\n"
                + json.dumps({"sessionId": session_id, "status": status, "ms": output_ms, "body": body_text, "health": health_results}, indent=2)
            )
        if "tmux list-windows" not in body_text or "timed out after" not in body_text:
            raise LiveDriveFailure(
                "wedged tmux route did not name the timed-out tmux call\n"
                + json.dumps({"sessionId": session_id, "status": status, "ms": output_ms, "body": body_text, "health": health_results}, indent=2)
            )
        if len(health_ok) != 6:
            raise LiveDriveFailure(
                "wedged tmux blocked unrelated health checks\n"
                + json.dumps({"sessionId": session_id, "status": status, "ms": output_ms, "body": body_text, "health": health_results}, indent=2)
            )
        recovered_status, recovered_body, recovered_raw = http_request_json(f"{endpoint}/agents/output?sessionId={quote(session_id)}", timeout=5)
        if recovered_status != 200:
            raise LiveDriveFailure(
                "tmux SIGCONT did not restore /agents/output\n"
                + json.dumps({"status": recovered_status, "body": recovered_body or recovered_raw[:240]}, indent=2)
            )
        return {
            "sessionId": session_id,
            "tmuxPids": pids,
            "wedgedStatus": status,
            "wedgedMs": output_ms,
            "wedgedBody": body_text[:500],
            "health": health_results,
            "recoveredStatus": recovered_status,
        }


def compact_value(value: Any, *, string_limit: int = 1600, list_limit: int = 12, dict_limit: int = 24) -> Any:
    if isinstance(value, str):
        if len(value) <= string_limit:
            return value
        return value[:string_limit] + f"... <truncated {len(value) - string_limit} chars>"
    if isinstance(value, list):
        compacted = [compact_value(item, string_limit=string_limit, list_limit=list_limit, dict_limit=dict_limit) for item in value[:list_limit]]
        if len(value) > list_limit:
            compacted.append(f"... <truncated {len(value) - list_limit} items>")
        return compacted
    if isinstance(value, dict):
        items = list(value.items())
        compacted = {
            key: compact_value(item, string_limit=string_limit, list_limit=list_limit, dict_limit=dict_limit)
            for key, item in items[:dict_limit]
        }
        if len(items) > dict_limit:
            compacted["..."] = f"<truncated {len(items) - dict_limit} keys>"
        return compacted
    return value


def run_check(name: str, fn: Any) -> dict[str, Any]:
    started = time.monotonic()
    try:
        evidence = fn()
        result = {"name": name, "status": "pass", "ms": int((time.monotonic() - started) * 1000), "evidence": evidence}
        print("[PASS] " + name + " " + json.dumps(compact_value(result), sort_keys=True), flush=True)
        return result
    except Exception as error:
        result = {"name": name, "status": "fail", "ms": int((time.monotonic() - started) * 1000), "error": str(error)}
        print("[FAIL] " + name + " " + json.dumps(compact_value(result), sort_keys=True), flush=True)
        return result


def main() -> int:
    parser = argparse.ArgumentParser(description="Remote side of the Aimux live-drive gate")
    parser.add_argument("--aimux-bin", required=True)
    parser.add_argument("--phase8-helper", required=True)
    parser.add_argument("--expected-build-stamp", required=True)
    parser.add_argument("--dashboard-deadline-seconds", type=float, default=6.0)
    parser.add_argument("--hosted-attempts", type=int, default=10)
    args = parser.parse_args()

    aimux_bin = Path(args.aimux_bin).expanduser()
    phase8 = load_phase8(Path(args.phase8_helper))
    try:
        stamp_evidence = verify_build_stamp(aimux_bin, args.expected_build_stamp)
    except Exception as error:
        print("[FAIL] build-stamp " + json.dumps({"status": "fail", "error": str(error)}, sort_keys=True), flush=True)
        print("LIVE_DRIVE_SUMMARY " + json.dumps({"failures": [{"name": "build-stamp", "status": "fail", "error": str(error)}], "results": []}, sort_keys=True), flush=True)
        return 1
    checks = [
        ("versioned-binary", lambda: {**check_version(phase8, aimux_bin), **stamp_evidence}),
        ("lifecycle", lambda: check_lifecycle(phase8, aimux_bin)),
        ("dashboard-repaint", lambda: check_dashboard_repaint(phase8, aimux_bin, args.dashboard_deadline_seconds)),
        ("sse-multiclient", lambda: check_sse(phase8, aimux_bin)),
        ("expose-tile-population", lambda: check_expose(phase8, aimux_bin)),
        ("hosted-proxy-ab", lambda: check_hosted_proxy(phase8, aimux_bin, args.hosted_attempts)),
        ("tmux-sigstop-wedge", lambda: check_wedge(phase8, aimux_bin)),
    ]
    results = [run_check(name, fn) for name, fn in checks]
    failures = [result for result in results if result["status"] != "pass"]
    print("LIVE_DRIVE_SUMMARY " + json.dumps(compact_value({"failures": failures, "results": results}), sort_keys=True), flush=True)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
'''


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Install an Aimux release asset on a remote host and run the live-drive gate.",
    )
    parser.add_argument("host", help="SSH host, for example sam-mbp2")
    parser.add_argument(
        "--asset",
        type=Path,
        default=None,
        help="Release asset to install. Defaults to the newest release/aimux-*.tar.gz.",
    )
    parser.add_argument(
        "--version",
        default=None,
        help="Installed version label. Defaults to aimux/VERSION inside the asset.",
    )
    parser.add_argument(
        "--expected-build-stamp",
        default=None,
        help="Expected BUILD_STAMP. Defaults to aimux/BUILD_STAMP inside the asset.",
    )
    parser.add_argument(
        "--remote-dir",
        default=None,
        help="Remote temp directory. Defaults to /tmp/aimux-live-drive-<timestamp>.",
    )
    parser.add_argument("--connect-timeout", type=int, default=DEFAULT_CONNECT_TIMEOUT)
    parser.add_argument("--retries", type=int, default=3)
    parser.add_argument("--dashboard-deadline-seconds", type=float, default=6.0)
    parser.add_argument("--hosted-attempts", type=int, default=10)
    parser.add_argument(
        "--skip-install",
        action="store_true",
        help="Skip asset install and only run the remote drive against --version.",
    )
    return parser.parse_args()


def newest_asset() -> Path:
    candidates = sorted((ROOT / "release").glob("aimux-*.tar.gz"), key=lambda path: path.stat().st_mtime, reverse=True)
    if not candidates:
        raise SystemExit("no release asset found; build one with AIMUX_RELEASE_VERSION=... yarn release:asset or pass --asset")
    return candidates[0]


def text_from_asset(asset: Path, member_name: str) -> str:
    with tarfile.open(asset, "r:gz") as archive:
        try:
            member = archive.getmember(member_name)
        except KeyError as error:
            raise SystemExit(f"{asset} does not contain {member_name}") from error
        file_obj = archive.extractfile(member)
        if file_obj is None:
            raise SystemExit(f"could not read {member_name} from {asset}")
        value = file_obj.read().decode().strip()
    if not value:
        raise SystemExit(f"{member_name} in {asset} was empty")
    return value


def version_from_asset(asset: Path) -> str:
    version = text_from_asset(asset, "aimux/VERSION")
    if not version:
        raise SystemExit(f"aimux/VERSION in {asset} was empty")
    return version


def build_stamp_from_asset(asset: Path) -> str:
    return text_from_asset(asset, "aimux/BUILD_STAMP")


def ssh_base(args: argparse.Namespace) -> list[str]:
    return [
        "ssh",
        "-o",
        f"ConnectTimeout={args.connect_timeout}",
        "-o",
        "ServerAliveInterval=5",
        "-o",
        "ServerAliveCountMax=2",
        args.host,
    ]


def scp_base(args: argparse.Namespace) -> list[str]:
    return ["scp", "-o", f"ConnectTimeout={args.connect_timeout}"]


def run_with_retries(label: str, command: list[str], *, retries: int, timeout: float | None = None) -> subprocess.CompletedProcess[str]:
    last: subprocess.CompletedProcess[str] | None = None
    for attempt in range(1, retries + 1):
        result = subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout, check=False)
        if result.returncode == 0:
            if result.stdout:
                print(result.stdout, end="", flush=True)
            if result.stderr:
                print(result.stderr, end="", file=sys.stderr, flush=True)
            return result
        last = result
        print(
            f"{label} attempt {attempt}/{retries} failed ({result.returncode}); stdout={result.stdout[-500:]!r} stderr={result.stderr[-500:]!r}",
            file=sys.stderr,
            flush=True,
        )
        if attempt < retries:
            time.sleep(min(2 * attempt, 5))
    assert last is not None
    raise SystemExit(f"{label} failed after {retries} attempts")


def write_remote_driver() -> Path:
    handle = tempfile.NamedTemporaryFile("w", prefix="aimux-live-drive-remote-", suffix=".py", delete=False)
    with handle:
        handle.write(textwrap.dedent(REMOTE_DRIVER).lstrip())
    return Path(handle.name)


def main() -> int:
    args = parse_args()
    asset = args.asset.resolve() if args.asset else None
    if asset is None:
        try:
            asset = newest_asset().resolve()
        except SystemExit:
            if not (args.skip_install and args.version and args.expected_build_stamp):
                raise
    if asset is not None and not asset.exists() and not args.skip_install:
        raise SystemExit(f"asset does not exist: {asset}")
    if asset is not None and not asset.exists() and args.skip_install:
        asset = None
    version = args.version or (version_from_asset(asset) if asset is not None else None)
    if not version:
        raise SystemExit("--version is required when --skip-install is used without an asset")
    expected_build_stamp = args.expected_build_stamp or (
        build_stamp_from_asset(asset) if asset is not None else None
    )
    if not expected_build_stamp:
        raise SystemExit(
            "--expected-build-stamp is required when --skip-install is used without an asset"
        )
    remote_dir = args.remote_dir or f"/tmp/aimux-live-drive-{int(time.time())}"
    remote_asset = f"{remote_dir}/{asset.name}" if asset is not None else None
    remote_install = f"{remote_dir}/install.sh"
    remote_phase8 = f"{remote_dir}/phase8-live-residuals.py"
    remote_driver_path = f"{remote_dir}/live-drive-remote-side.py"
    remote_aimux = f"~/.aimux/native/{version}/bin/aimux"
    local_driver = write_remote_driver()

    try:
        print(f"remote host: {args.host}", flush=True)
        print(f"asset: {asset}", flush=True)
        print(f"version: {version}", flush=True)
        print(f"expected build stamp: {expected_build_stamp}", flush=True)
        print(f"remote versioned binary: {remote_aimux}", flush=True)
        run_with_retries(
            "remote mkdir",
            [*ssh_base(args), "mkdir", "-p", shlex.quote(remote_dir)],
            retries=args.retries,
            timeout=args.connect_timeout + 10,
        )
        run_with_retries(
            "copy live-drive files",
            [
                *scp_base(args),
                str(ROOT / "scripts" / "phase8-live-residuals.py"),
                str(ROOT / "scripts" / "install.sh"),
                str(local_driver),
                f"{args.host}:{shlex.quote(remote_dir)}/",
            ],
            retries=args.retries,
            timeout=60,
        )
        run_with_retries(
            "move remote driver",
            [*ssh_base(args), "mv", shlex.quote(f"{remote_dir}/{local_driver.name}"), shlex.quote(remote_driver_path)],
            retries=args.retries,
            timeout=args.connect_timeout + 10,
        )
        if not args.skip_install:
            assert asset is not None
            assert remote_asset is not None
            run_with_retries(
                "copy release asset",
                [*scp_base(args), str(asset), f"{args.host}:{shlex.quote(remote_asset)}"],
                retries=args.retries,
                timeout=120,
            )
            run_with_retries(
                "install release asset",
                [
                    *ssh_base(args),
                    "AIMUX_SKIP_POST_INSTALL_RESTART=1",
                    "sh",
                    shlex.quote(remote_install),
                    shlex.quote(remote_asset),
                ],
                retries=args.retries,
                timeout=120,
            )

        remote_command = [
            "python3",
            shlex.quote(remote_driver_path),
            "--aimux-bin",
            shlex.quote(remote_aimux),
            "--phase8-helper",
            shlex.quote(remote_phase8),
            "--expected-build-stamp",
            shlex.quote(expected_build_stamp),
            "--dashboard-deadline-seconds",
            str(args.dashboard_deadline_seconds),
            "--hosted-attempts",
            str(args.hosted_attempts),
        ]
        result = subprocess.run(
            [*ssh_base(args), " ".join(remote_command)],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        print(result.stdout, end="", flush=True)
        if result.stderr:
            print(result.stderr, end="", file=sys.stderr, flush=True)
        return result.returncode
    finally:
        try:
            local_driver.unlink()
        except OSError:
            pass


if __name__ == "__main__":
    raise SystemExit(main())
