#!/usr/bin/env python3
"""Run the async-cutover local-install readiness gate.

This is intentionally not wired into yarn verify. It needs a real remote host,
installs a release asset there, and proves both ordinary behavior and failure
visibility against the versioned native binary identified by BUILD_STAMP.
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
import tarfile
import tempfile
import textwrap
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PR = 376
REMOTE_OBSERVABILITY_DRIVER = r'''
from __future__ import annotations

import argparse
import http.client
import importlib.util
import json
import os
import re
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlparse


class GateFailure(Exception):
    pass


def load_phase8(path: Path) -> Any:
    spec = importlib.util.spec_from_file_location("phase8_live_residuals", path)
    if spec is None or spec.loader is None:
        raise GateFailure(f"cannot load phase8 helper from {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run(args: list[str], *, cwd: Path | None = None, env: dict[str, str] | None = None, timeout: float = 30, check: bool = False) -> subprocess.CompletedProcess[str]:
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
        raise GateFailure(
            f"command failed ({result.returncode}): {' '.join(args)}\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )
    return result


def http_request_json(url: str, *, timeout: float = 5) -> tuple[int, dict[str, Any], str]:
    parsed = urlparse(url)
    conn = http.client.HTTPConnection(parsed.hostname, parsed.port, timeout=timeout)
    path = parsed.path or "/"
    if parsed.query:
        path += "?" + parsed.query
    conn.request("GET", path)
    response = conn.getresponse()
    raw = response.read().decode(errors="replace")
    conn.close()
    try:
        body = json.loads(raw or "{}")
    except json.JSONDecodeError:
        body = {}
    return response.status, body, raw


def read_embedded_build_stamp(aimux_bin: Path) -> str:
    prefix = b"AIMUX_EMBEDDED_BUILD_STAMP="
    data = aimux_bin.read_bytes()
    start = data.find(prefix)
    if start < 0:
        raise GateFailure(f"{aimux_bin} is missing embedded BUILD_STAMP witness")
    remainder = data[start + len(prefix):]
    ends = [index for index in (remainder.find(b"\0"), remainder.find(b"\n"), remainder.find(b"\r")) if index >= 0]
    raw = remainder[: min(ends)] if ends else remainder
    match = re.match(rb"[0-9A-Za-z_.:+/-]+", raw)
    stamp = match.group(0).decode(errors="replace") if match else ""
    if not stamp:
        raise GateFailure(f"{aimux_bin} has an empty embedded BUILD_STAMP witness")
    return stamp


def assert_build_stamp(aimux_bin: Path, expected_build_stamp: str) -> None:
    actual = read_embedded_build_stamp(aimux_bin)
    if actual != expected_build_stamp:
        raise GateFailure(
            "observability gate build stamp mismatch; refusing to inspect unknown binary\n"
            + json.dumps(
                {
                    "aimuxBin": str(aimux_bin),
                    "expectedBuildStamp": expected_build_stamp,
                    "installedBinaryBuildStamp": actual,
                },
                indent=2,
                sort_keys=True,
            )
        )


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


def find_paths(value: Any, predicate: Any, path: str = "$") -> list[tuple[str, Any]]:
    found: list[tuple[str, Any]] = []
    if predicate(path, value):
        found.append((path, value))
    if isinstance(value, dict):
        for key, child in value.items():
            found.extend(find_paths(child, predicate, f"{path}.{key}"))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            found.extend(find_paths(child, predicate, f"{path}[{index}]"))
    return found


def numeric_descendants(value: Any) -> list[float]:
    if isinstance(value, bool):
        return []
    if isinstance(value, (int, float)):
        return [float(value)]
    if isinstance(value, dict):
        out: list[float] = []
        for child in value.values():
            out.extend(numeric_descendants(child))
        return out
    if isinstance(value, list):
        out = []
        for child in value:
            out.extend(numeric_descendants(child))
        return out
    return []


def has_per_task_health_counters(payloads: list[tuple[str, Any]]) -> list[str]:
    matches: list[str] = []

    def predicate(path: str, value: Any) -> bool:
        if not isinstance(value, dict):
            return False
        periodic_tasks = value.get("periodicTasks")
        if not isinstance(periodic_tasks, list) or not periodic_tasks:
            return False
        for task in periodic_tasks:
            if not isinstance(task, dict) or not task.get("name"):
                continue
            counters = [
                task.get("totalRuns"),
                task.get("consecutiveFailures"),
                task.get("consecutiveTimeouts"),
                task.get("totalTimeouts"),
                task.get("lastDurationMs"),
                task.get("p95DurationMs"),
            ]
            if any(
                isinstance(counter, (int, float)) and not isinstance(counter, bool)
                for counter in counters
            ):
                return True
        return False

    for label, payload in payloads:
        matches.extend(f"{label}:{path}" for path, _value in find_paths(payload, predicate))
    return matches


def has_bounded_buffer_metrics(payloads: list[tuple[str, Any]]) -> list[str]:
    matches: list[str] = []

    def predicate(_path: str, value: Any) -> bool:
        if not isinstance(value, dict):
            return False
        keys = {str(key).replace("-", "").replace("_", "").lower(): key for key in value.keys()}
        depth_key = keys.get("depth") or keys.get("currentdepth") or keys.get("queued") or keys.get("len")
        high_key = keys.get("highwater") or keys.get("highwatermark") or keys.get("maxdepth")
        if not depth_key or not high_key:
            return False
        depth = value.get(depth_key)
        high = value.get(high_key)
        return (
            isinstance(depth, (int, float))
            and not isinstance(depth, bool)
            and isinstance(high, (int, float))
            and not isinstance(high, bool)
            and high >= depth
        )

    for label, payload in payloads:
        matches.extend(f"{label}:{path}" for path, _value in find_paths(payload, predicate))
    return matches


def has_stability_verdict(payload: Any) -> bool:
    if not isinstance(payload, dict):
        return False
    paths = find_paths(
        payload,
        lambda _path, value: isinstance(value, dict)
        and any(key in value for key in ("verdict", "stable", "stability", "status"))
        and any(
            key in value
            for key in (
                "snapshot",
                "snapshotPath",
                "history",
                "historyPath",
                "historySpanMs",
                "window",
                "samples",
                "sampleCount",
            )
        ),
    )
    return bool(paths)


def snapshot_candidates(state_dir: Path, since: float) -> list[tuple[Path, Any]]:
    candidates: list[tuple[Path, Any]] = []
    for path in sorted(
        [
            candidate
            for pattern in ("*.json", "*.jsonl")
            for candidate in state_dir.rglob(pattern)
        ]
    ):
        try:
            if path.stat().st_mtime + 0.001 < since:
                continue
            text = path.read_text(errors="replace")
            if path.suffix == ".jsonl":
                payload = [json.loads(line) for line in text.splitlines() if line.strip()]
            else:
                payload = json.loads(text)
        except Exception:
            continue
        name = path.name.lower()
        if not any(word in name for word in ("observ", "stability", "stable", "health", "snapshot", "doctor")):
            continue
        candidates.append((path, payload))
    return candidates


def log_tail(scope: Any, state_dir: Path) -> dict[str, str]:
    logs: dict[str, str] = {}
    for path in [
        state_dir / "logs" / "aimux.jsonl",
        state_dir / "logs" / "project-service-stdio.log",
        scope.aimux_home / "daemon" / "logs" / "daemon.jsonl",
        scope.aimux_home / "daemon" / "logs" / "daemon-stdio.log",
    ]:
        try:
            logs[str(path)] = path.read_text(errors="replace")[-2000:] if path.exists() else "<missing>"
        except Exception as error:
            logs[str(path)] = f"<read failed: {error}>"
    return logs


def safe_http_json(scope: Any, state_dir: Path, label: str, url: str, evidence: dict[str, Any]) -> tuple[int, dict[str, Any], str]:
    try:
        return http_request_json(url, timeout=5)
    except Exception as error:
        evidence.setdefault("httpFailures", []).append(
            {
                "label": label,
                "url": url,
                "error": str(error),
                "logs": log_tail(scope, state_dir),
            }
        )
        return 0, {}, str(error)


def snapshot_is_reporting(path: Path, payload: Any) -> bool:
    if isinstance(payload, list):
        return any(snapshot_is_reporting(path, item) for item in payload)
    if not isinstance(payload, dict):
        return False
    has_time = bool(
        find_paths(
            payload,
            lambda _path, value: isinstance(value, dict)
            and any(
                key in value
                for key in (
                    "updatedAt",
                    "savedAt",
                    "capturedAt",
                    "createdAt",
                    "recordedAtMs",
                    "generatedAtMs",
                )
            ),
        )
    )
    has_signal = (
        bool(has_per_task_health_counters([(str(path), payload)]))
        or bool(has_bounded_buffer_metrics([(str(path), payload)]))
        or has_stability_verdict(payload)
    )
    return has_time and has_signal


def main() -> int:
    parser = argparse.ArgumentParser(description="Remote observability reporter check")
    parser.add_argument("--aimux-bin", required=True)
    parser.add_argument("--phase8-helper", required=True)
    parser.add_argument("--expected-build-stamp", required=True)
    args = parser.parse_args()

    aimux_bin = Path(args.aimux_bin).expanduser()
    assert_build_stamp(aimux_bin, args.expected_build_stamp)
    phase8 = load_phase8(Path(args.phase8_helper))
    tmux = phase8.find_tmux()
    started_at = time.time()

    failures: list[str] = []
    evidence: dict[str, Any] = {
        "aimuxBin": str(aimux_bin),
        "verifiedBuildStamp": args.expected_build_stamp,
    }

    with phase8.Scope("local-install-observability", aimux_bin) as scope:
        socket_name = f"aimux-local-install-observability-{os.getpid()}-{time.time_ns()}"
        scope.tmux_socket_name = socket_name
        phase8.install_tmux_socket_wrapper(scope, tmux, socket_name)
        phase8.run([tmux, "-L", socket_name, "kill-server"], env=phase8.without_tmux(os.environ.copy()), timeout=10, check=False)
        scope.init_git_project()
        phase8.run([str(aimux_bin), "init"], cwd=scope.project, env=scope.env, timeout=30)
        phase8.install_shell_tool_config(scope)
        spawn = phase8.parse_json_stdout(
            phase8.run([str(aimux_bin), "spawn", "--tool", "shell", "--no-open", "--json"], cwd=scope.project, env=scope.env, timeout=30).stdout,
            "local-install observability spawn",
        )
        session_id = str(spawn.get("sessionId") or "")
        if not session_id:
            raise GateFailure(f"spawn returned no session id: {spawn}")
        phase8.wait_until(
            lambda: phase8.ps_session_by_id(scope, aimux_bin, session_id),
            timeout=10,
            label=f"observability session {session_id} in aimux ps",
        )
        endpoint = phase8.wait_for_project_service_endpoint(scope)
        state_dir = phase8.project_service_state_dir(scope)
        evidence.update(
            {
                "sessionId": session_id,
                "endpoint": endpoint,
                "projectStateDir": str(state_dir),
            }
        )
        for index in range(3):
            safe_http_json(
                scope,
                state_dir,
                f"/agents/output warmup {index + 1}",
                f"{endpoint}/agents/output?sessionId={quote(session_id)}",
                evidence,
            )
        desktop_status, desktop, desktop_raw = safe_http_json(
            scope,
            state_dir,
            "/desktop-state?includePreview=1",
            f"{endpoint}/desktop-state?includePreview=1",
            evidence,
        )
        observability_status, observability, observability_raw = safe_http_json(
            scope,
            state_dir,
            "/project-observability",
            f"{endpoint}/project-observability",
            evidence,
        )
        doctor_tasks = run([str(aimux_bin), "doctor", "tasks", "--json"], cwd=scope.project, env=scope.env, timeout=20)
        doctor_stability = run([str(aimux_bin), "doctor", "stability", "--project", str(scope.project), "--json"], cwd=scope.project, env=scope.env, timeout=20)
        parsed_doctor_tasks: Any = {}
        parsed_doctor_stability: Any = {}
        try:
            parsed_doctor_tasks = json.loads(doctor_tasks.stdout or "{}")
        except json.JSONDecodeError:
            pass
        try:
            parsed_doctor_stability = json.loads(doctor_stability.stdout or "{}")
        except json.JSONDecodeError:
            pass

        payloads = [
            ("desktop-state", desktop if desktop_status == 200 else {"status": desktop_status, "raw": desktop_raw[:500]}),
            ("project-observability", observability if observability_status == 200 else {"status": observability_status, "raw": observability_raw[:500]}),
            ("doctor-tasks", parsed_doctor_tasks),
            ("doctor-stability", parsed_doctor_stability),
        ]

        snapshot_matches = snapshot_candidates(state_dir, started_at)
        snapshot_payloads = [(str(path), payload) for path, payload in snapshot_matches]
        searched_payloads = payloads + snapshot_payloads
        health_matches = has_per_task_health_counters(searched_payloads)
        buffer_matches = has_bounded_buffer_metrics(searched_payloads)
        reporting_snapshots = [str(path) for path, payload in snapshot_matches if snapshot_is_reporting(path, payload)]
        stability_ok = doctor_stability.returncode == 0 and has_stability_verdict(parsed_doctor_stability)

        if not health_matches:
            failures.append(
                "per-task health counters are not reporting; looked in /desktop-state, /project-observability, and doctor tasks"
            )
        if evidence.get("httpFailures"):
            failures.append(
                "project observability probe could not read every required route; see labelled httpFailures"
            )
        if not buffer_matches:
            failures.append(
                "bounded-buffer depth/high-water metrics are not reporting; no object with numeric depth and high-water was found"
            )
        if not reporting_snapshots:
            failures.append(
                "on-disk observability/stability snapshot is not being written with reportable data"
            )
        if not stability_ok:
            failures.append(
                "doctor stability did not render a verdict from snapshot history"
            )

        evidence.update(
            {
                "projectObservabilityStatus": observability_status,
                "projectObservabilityTopKeys": sorted(observability.keys()) if isinstance(observability, dict) else [],
                "doctorTasks": {
                    "returncode": doctor_tasks.returncode,
                    "stdoutPrefix": doctor_tasks.stdout[:800],
                    "stderrPrefix": doctor_tasks.stderr[:800],
                },
                "doctorStability": {
                    "returncode": doctor_stability.returncode,
                    "stdoutPrefix": doctor_stability.stdout[:800],
                    "stderrPrefix": doctor_stability.stderr[:800],
                },
                "healthCounterMatches": health_matches[:10],
                "boundedBufferMatches": buffer_matches[:10],
                "snapshotCandidates": [str(path) for path, _payload in snapshot_matches[:20]],
                "reportingSnapshots": reporting_snapshots[:20],
            }
        )

    result = {"status": "pass" if not failures else "fail", "failures": failures, "evidence": evidence}
    print("OBSERVABILITY_GATE " + json.dumps(result, sort_keys=True))
    return 0 if not failures else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print("OBSERVABILITY_GATE " + json.dumps({"status": "fail", "error": str(error)}, sort_keys=True))
        raise SystemExit(1)
'''


@dataclass
class StepResult:
    name: str
    status: str
    returncode: int
    evidence: dict[str, Any]


def run_command(
    name: str,
    args: list[str],
    *,
    env: dict[str, str] | None = None,
    timeout: float | None = None,
) -> StepResult:
    started = time.monotonic()
    print(f"\n==> {name}: {' '.join(shlex.quote(arg) for arg in args)}", flush=True)
    try:
        result = subprocess.run(
            args,
            cwd=str(ROOT),
            env=env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            check=False,
        )
        if result.stdout:
            print(result.stdout, end="", flush=True)
        if result.stderr:
            print(result.stderr, end="", file=sys.stderr, flush=True)
        status = "pass" if result.returncode == 0 else "fail"
        return StepResult(
            name=name,
            status=status,
            returncode=result.returncode,
            evidence={
                "ms": int((time.monotonic() - started) * 1000),
                "stdoutTail": result.stdout[-4000:],
                "stderrTail": result.stderr[-4000:],
            },
        )
    except subprocess.TimeoutExpired as error:
        stdout = (error.stdout or "")
        stderr = (error.stderr or "")
        if isinstance(stdout, bytes):
            stdout = stdout.decode(errors="replace")
        if isinstance(stderr, bytes):
            stderr = stderr.decode(errors="replace")
        return StepResult(
            name=name,
            status="fail",
            returncode=124,
            evidence={
                "ms": int((time.monotonic() - started) * 1000),
                "error": f"timed out after {timeout}s",
                "stdoutTail": stdout[-4000:],
                "stderrTail": stderr[-4000:],
            },
        )


def cargo_env() -> dict[str, str]:
    env = os.environ.copy()
    env["CARGO_INCREMENTAL"] = "0"
    session_id = env.get("AIMUX_SESSION_ID") or "local-install-gate"
    env.setdefault("CARGO_TARGET_DIR", f"/tmp/aimux-cargo-target-{session_id}")
    return env


def text_from_asset(asset: Path, member: str) -> str:
    with tarfile.open(asset, "r:gz") as archive:
        file = archive.extractfile(member)
        if file is None:
            raise FileNotFoundError(f"{asset} is missing {member}")
        return file.read().decode().strip()


def newest_asset() -> Path:
    candidates = sorted((ROOT / "release").glob("aimux-*.tar.gz"), key=lambda path: path.stat().st_mtime, reverse=True)
    if not candidates:
        raise FileNotFoundError("no release/aimux-*.tar.gz asset exists")
    return candidates[0]


def platform_arch_from_asset(asset: Path) -> str:
    with tarfile.open(asset, "r:gz") as archive:
        matches = [
            name
            for name in archive.getnames()
            if name.startswith("aimux/native/") and name.endswith("/aimux")
        ]
    if len(matches) != 1:
        raise RuntimeError(f"expected exactly one native/*/aimux entry in {asset}, found {matches}")
    return matches[0].split("/")[2]


def build_asset() -> tuple[StepResult, Path | None]:
    short_head = subprocess.check_output(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, text=True).strip()
    env = cargo_env()
    env["AIMUX_RELEASE_VERSION"] = f"local-{short_head}-async-install-gate"
    result = run_command("build release asset", ["yarn", "release:asset"], env=env)
    if result.returncode != 0:
        return result, None
    return result, newest_asset()


def check_ci(pr: int) -> StepResult:
    started = time.monotonic()
    print(f"\n==> ci status: gh pr view {pr}", flush=True)
    result = subprocess.run(
        [
            "gh",
            "pr",
            "view",
            str(pr),
            "--json",
            "number,state,headRefName,headRefOid,statusCheckRollup,url",
        ],
        cwd=str(ROOT),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.stdout:
        print(result.stdout, flush=True)
    if result.stderr:
        print(result.stderr, file=sys.stderr, flush=True)
    evidence: dict[str, Any] = {
        "ms": int((time.monotonic() - started) * 1000),
        "stdoutTail": result.stdout[-4000:],
        "stderrTail": result.stderr[-4000:],
    }
    if result.returncode != 0:
        return StepResult("ci status", "fail", result.returncode, evidence)
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        evidence["error"] = f"failed to parse gh JSON: {error}"
        return StepResult("ci status", "fail", 1, evidence)
    failing: list[dict[str, Any]] = []
    pending: list[dict[str, Any]] = []
    for item in payload.get("statusCheckRollup", []):
        kind = item.get("__typename")
        name = item.get("name") or item.get("context") or "<unnamed>"
        if kind == "CheckRun":
            status = item.get("status")
            conclusion = item.get("conclusion")
            if status != "COMPLETED":
                pending.append({"name": name, "status": status, "detailsUrl": item.get("detailsUrl")})
            elif conclusion != "SUCCESS":
                failing.append({"name": name, "conclusion": conclusion, "detailsUrl": item.get("detailsUrl")})
        elif kind == "StatusContext":
            state = item.get("state")
            if state != "SUCCESS":
                failing.append({"name": name, "state": state, "targetUrl": item.get("targetUrl")})
    evidence.update(
        {
            "pr": pr,
            "url": payload.get("url"),
            "headRefName": payload.get("headRefName"),
            "headRefOid": payload.get("headRefOid"),
            "failing": failing,
            "pending": pending,
            "checkCount": len(payload.get("statusCheckRollup", [])),
        }
    )
    status = "pass" if not failing and not pending else "fail"
    return StepResult("ci status", status, 0 if status == "pass" else 1, evidence)


def ssh_base(host: str, connect_timeout: int) -> list[str]:
    return [
        "ssh",
        "-o",
        f"ConnectTimeout={connect_timeout}",
        "-o",
        "BatchMode=yes",
        host,
    ]


def scp_base(connect_timeout: int) -> list[str]:
    return ["scp", "-o", f"ConnectTimeout={connect_timeout}", "-o", "BatchMode=yes"]


def run_observability_gate(args: argparse.Namespace, asset: Path) -> StepResult:
    version = text_from_asset(asset, "aimux/VERSION")
    build_stamp = text_from_asset(asset, "aimux/BUILD_STAMP")
    platform_arch = platform_arch_from_asset(asset)
    remote_aimux = f"~/.aimux/native/{version}/native/{platform_arch}/aimux"
    remote_dir = f"/tmp/aimux-local-install-observability-{int(time.time())}"
    remote_driver = f"{remote_dir}/observability-driver.py"
    remote_phase8 = f"{remote_dir}/phase8-live-residuals.py"
    handle = tempfile.NamedTemporaryFile("w", prefix="aimux-observability-driver-", suffix=".py", delete=False)
    local_driver = Path(handle.name)
    try:
        handle.write(REMOTE_OBSERVABILITY_DRIVER)
        handle.close()
        prep = run_command(
            "observability remote prep",
            [*ssh_base(args.host, args.connect_timeout), "mkdir", "-p", shlex.quote(remote_dir)],
            timeout=60,
        )
        if prep.returncode != 0:
            return prep
        copy = run_command(
            "observability copy driver",
            [
                *scp_base(args.connect_timeout),
                str(local_driver),
                f"{args.host}:{shlex.quote(remote_driver)}",
            ],
            timeout=120,
        )
        if copy.returncode != 0:
            return copy
        copy_helper = run_command(
            "observability copy helper",
            [
                *scp_base(args.connect_timeout),
                str(ROOT / "scripts" / "phase8-live-residuals.py"),
                f"{args.host}:{shlex.quote(remote_phase8)}",
            ],
            timeout=120,
        )
        if copy_helper.returncode != 0:
            return copy_helper
        return run_command(
            "observability reporting",
            [
                *ssh_base(args.host, args.connect_timeout),
                "python3",
                shlex.quote(remote_driver),
                "--aimux-bin",
                shlex.quote(remote_aimux),
                "--phase8-helper",
                shlex.quote(remote_phase8),
                "--expected-build-stamp",
                shlex.quote(build_stamp),
            ],
            timeout=120,
        )
    finally:
        try:
            local_driver.unlink()
        except OSError:
            pass


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run the async-cutover local-install readiness gate against a remote host.",
    )
    parser.add_argument("host", help="Remote host to install and live-drive, for example sam-mbp2")
    parser.add_argument("--asset", type=Path, default=None, help="Existing release asset. Defaults to building a fresh asset.")
    parser.add_argument("--pr", type=int, default=DEFAULT_PR, help="GitHub PR number whose CI must be green.")
    parser.add_argument("--connect-timeout", type=int, default=5)
    parser.add_argument("--retries", type=int, default=3)
    parser.add_argument("--skip-verify-full", action="store_true", help="Development only: skip yarn verify:full.")
    parser.add_argument("--skip-async-gates", action="store_true", help="Development only: skip explicit async seam/blocking gates.")
    parser.add_argument("--skip-ci", action="store_true", help="Development only: skip PR CI check.")
    parser.add_argument("--skip-live-drive", action="store_true", help="Development only: skip remote live drive.")
    parser.add_argument("--skip-observability", action="store_true", help="Development only: skip remote observability assertions.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    results: list[StepResult] = []
    env = cargo_env()

    if args.skip_verify_full:
        results.append(StepResult("verify:full", "skip", 0, {"reason": "--skip-verify-full"}))
    else:
        results.append(run_command("verify:full", ["yarn", "verify:full"], env=env))

    if args.skip_async_gates:
        results.append(StepResult("async gates", "skip", 0, {"reason": "--skip-async-gates"}))
    else:
        results.append(run_command("async blocking gate", ["yarn", "audit:async-blocking"], env=env))
        results.append(run_command("async seam gate", ["yarn", "audit:async-seams"], env=env))

    if args.skip_ci:
        results.append(StepResult("ci status", "skip", 0, {"reason": "--skip-ci"}))
    else:
        results.append(check_ci(args.pr))

    asset = args.asset
    if asset is None:
        build_result, built_asset = build_asset()
        results.append(build_result)
        asset = built_asset
    if asset is None:
        results.append(
            StepResult(
                "release asset provenance",
                "fail",
                1,
                {"error": "release asset build failed; refusing to reuse an older asset"},
            )
        )
        summary = {
            "status": "fail",
            "failures": [
                {
                    "name": result.name,
                    "status": result.status,
                    "returncode": result.returncode,
                    "evidence": result.evidence,
                }
                for result in results
                if result.status != "pass"
            ],
            "results": [
                {
                    "name": result.name,
                    "status": result.status,
                    "returncode": result.returncode,
                    "evidence": result.evidence,
                }
                for result in results
            ],
        }
        print("\nASYNC_CUTOVER_LOCAL_INSTALL_GATE " + json.dumps(summary, sort_keys=True), flush=True)
        return 1
    asset = asset.resolve()
    asset_evidence: dict[str, Any] = {"asset": str(asset)}
    try:
        asset_evidence.update(
            {
                "version": text_from_asset(asset, "aimux/VERSION"),
                "buildStamp": text_from_asset(asset, "aimux/BUILD_STAMP"),
                "platformArch": platform_arch_from_asset(asset),
            }
        )
        results.append(StepResult("release asset provenance", "pass", 0, asset_evidence))
    except Exception as error:
        asset_evidence["error"] = str(error)
        results.append(StepResult("release asset provenance", "fail", 1, asset_evidence))

    if args.skip_live_drive:
        results.append(StepResult("live drive", "skip", 0, {"reason": "--skip-live-drive"}))
    else:
        results.append(
            run_command(
                "live drive",
                [
                    "python3",
                    "scripts/live-drive-remote.py",
                    args.host,
                    "--asset",
                    str(asset),
                    "--connect-timeout",
                    str(args.connect_timeout),
                    "--retries",
                    str(args.retries),
                ],
                timeout=600,
            )
        )

    if args.skip_observability:
        results.append(StepResult("observability reporting", "skip", 0, {"reason": "--skip-observability"}))
    else:
        results.append(run_observability_gate(args, asset))

    failures = [result for result in results if result.status != "pass"]
    summary = {
        "status": "pass" if not failures else "fail",
        "failures": [
            {
                "name": result.name,
                "status": result.status,
                "returncode": result.returncode,
                "evidence": result.evidence,
            }
            for result in failures
        ],
        "results": [
            {
                "name": result.name,
                "status": result.status,
                "returncode": result.returncode,
                "evidence": result.evidence,
            }
            for result in results
        ],
    }
    print("\nASYNC_CUTOVER_LOCAL_INSTALL_GATE " + json.dumps(summary, sort_keys=True), flush=True)
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
