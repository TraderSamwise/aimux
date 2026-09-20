#!/usr/bin/env python3
"""Gate idle Aimux runtimes against runaway process spawning.

The observable is intentionally outside Aimux. Linux exposes total process
creation in /proc/stat's "processes" field. macOS does not expose an equivalent
counter cheaply, so the fallback samples PID allocation with two short helper
processes; that is the same observable family as the incident probe.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import socket
import subprocess
import sys
import tempfile
import textwrap
import threading
import time
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


DEFAULT_BUDGET_PER_SEC = 8.0
DEFAULT_DURATION_SECONDS = 5.0
DEFAULT_BASELINE_SECONDS = 3.0
DEFAULT_SETTLE_SECONDS = 2.0
DEFAULT_SAMPLE_INTERVAL_SECONDS = 0.10
DEFAULT_DAEMON_PORT = 37373


@dataclass(frozen=True)
class Measurement:
    count: int
    seconds: float
    method: str

    @property
    def rate(self) -> float:
        return self.count / self.seconds if self.seconds else 0.0


@dataclass(frozen=True)
class SpawnSample:
    pid: int
    ppid: int | None
    command: str

    @property
    def label(self) -> str:
        if not self.command:
            return "<unknown>"
        if "aimux-idle-spawn-gate-mutation-child" in self.command:
            return "aimux-idle-spawn-gate-mutation-child"
        if "aimux-idle-spawn-gate-mutation-parent" in self.command:
            return "aimux-idle-spawn-gate-mutation-parent"
        parts = self.command.split()
        if len(parts) >= 3 and parts[0].endswith("python3"):
            return " ".join(parts[:3])
        return " ".join(parts[:2])


class ProcessCreationMeter:
    def __init__(self) -> None:
        self.system = platform.system()

    def measure(self, seconds: float) -> Measurement:
        if self.system == "Linux":
            return self._measure_linux(seconds)
        if self.system == "Darwin":
            return self._measure_darwin(seconds)
        raise RuntimeError(f"unsupported platform for idle process spawn gate: {self.system}")

    def _measure_linux(self, seconds: float) -> Measurement:
        start = _read_linux_processes_counter()
        start_time = time.monotonic()
        time.sleep(seconds)
        end = _read_linux_processes_counter()
        elapsed = time.monotonic() - start_time
        return Measurement(max(0, end - start), elapsed, "/proc/stat processes")

    def _measure_darwin(self, seconds: float) -> Measurement:
        start_pid = _spawn_pid_probe()
        start_time = time.monotonic()
        time.sleep(seconds)
        end_pid = _spawn_pid_probe()
        elapsed = time.monotonic() - start_time
        delta = end_pid - start_pid
        if delta < 0:
            raise RuntimeError(
                f"macOS PID allocation wrapped or moved backwards: {start_pid} -> {end_pid}"
            )
        return Measurement(delta, elapsed, "PID allocation delta")


class ProcessSampler:
    def __init__(self, interval: float) -> None:
        self.system = platform.system()
        self.interval = interval
        self.seen = {sample.pid for sample in self._snapshot()}
        self.samples: list[SpawnSample] = []

    def sample_for(self, seconds: float) -> None:
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            time.sleep(self.interval)
            for sample in self._snapshot():
                if sample.pid in self.seen:
                    continue
                self.seen.add(sample.pid)
                self.samples.append(sample)

    def top(self, limit: int = 8) -> list[tuple[str, int]]:
        counts = Counter(sample.label for sample in self.samples)
        return counts.most_common(limit)

    def _snapshot(self) -> list[SpawnSample]:
        if self.system == "Linux":
            return _linux_process_snapshot()
        if self.system == "Darwin":
            return _darwin_process_snapshot()
        return []


def _read_linux_processes_counter() -> int:
    with open("/proc/stat", "r", encoding="utf-8") as handle:
        for line in handle:
            if line.startswith("processes "):
                return int(line.split()[1])
    raise RuntimeError("/proc/stat did not contain a processes counter")


def _spawn_pid_probe() -> int:
    output = subprocess.check_output(["/bin/sh", "-c", "printf '%s' $$"], text=True)
    return int(output)


def _linux_process_snapshot() -> list[SpawnSample]:
    samples: list[SpawnSample] = []
    proc = Path("/proc")
    for entry in proc.iterdir():
        if not entry.name.isdigit():
            continue
        try:
            stat = (entry / "stat").read_text(encoding="utf-8")
            cmdline = (entry / "cmdline").read_bytes()
            comm = (entry / "comm").read_text(encoding="utf-8").strip()
        except (FileNotFoundError, ProcessLookupError, PermissionError, OSError):
            continue
        parsed = _parse_linux_stat(stat)
        if parsed is None:
            continue
        pid, ppid = parsed
        command = cmdline.replace(b"\0", b" ").decode("utf-8", errors="replace").strip()
        samples.append(SpawnSample(pid=pid, ppid=ppid, command=command or comm))
    return samples


def _parse_linux_stat(stat: str) -> tuple[int, int] | None:
    close = stat.rfind(")")
    open_ = stat.find("(")
    if open_ == -1 or close == -1 or close <= open_:
        return None
    try:
        pid = int(stat[:open_].strip())
        fields = stat[close + 2 :].split()
        ppid = int(fields[1])
    except (IndexError, ValueError):
        return None
    return pid, ppid


def _darwin_process_snapshot() -> list[SpawnSample]:
    try:
        output = subprocess.check_output(
            ["ps", "-axo", "pid=,ppid=,command="],
            stderr=subprocess.DEVNULL,
            text=True,
        )
    except (subprocess.SubprocessError, OSError):
        return []
    samples: list[SpawnSample] = []
    for line in output.splitlines():
        parts = line.strip().split(None, 2)
        if len(parts) < 2:
            continue
        try:
            pid = int(parts[0])
            ppid = int(parts[1])
        except ValueError:
            continue
        command = parts[2] if len(parts) > 2 else ""
        samples.append(SpawnSample(pid=pid, ppid=ppid, command=command))
    return samples


def _free_loopback_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _repo_root_from_script() -> Path:
    return Path(__file__).resolve().parents[1]


def _default_target_dir(repo_root: Path) -> Path:
    if "CARGO_TARGET_DIR" in os.environ:
        return Path(os.environ["CARGO_TARGET_DIR"]).expanduser().resolve()
    if platform.system() == "Linux":
        return Path.home() / ".cache" / "aimux-idle-process-spawn-gate-target"
    return repo_root / "native" / "target"


def _run(
    args: Iterable[str],
    *,
    cwd: Path,
    env: dict[str, str],
    timeout: float,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        list(args),
        cwd=cwd,
        env=env,
        timeout=timeout,
        check=check,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )


def _build_aimux(repo_root: Path, target_dir: Path) -> Path:
    env = os.environ.copy()
    env["CARGO_INCREMENTAL"] = "0"
    env["CARGO_TARGET_DIR"] = str(target_dir)
    _run(
        [
            "cargo",
            "build",
            "--manifest-path",
            str(repo_root / "native" / "Cargo.toml"),
            "-p",
            "aimux",
            "--bin",
            "aimux",
        ],
        cwd=repo_root,
        env=env,
        timeout=300,
    )
    bin_name = "aimux.exe" if platform.system() == "Windows" else "aimux"
    return target_dir / "debug" / bin_name


def _write_test_isolation_marker(aimux_home: Path) -> None:
    aimux_home.mkdir(parents=True, exist_ok=True)
    marker = aimux_home / "test-isolation.json"
    marker.write_text(
        json.dumps({"kind": "idle-process-spawn-gate", "ownerPid": os.getpid()}) + "\n",
        encoding="utf-8",
    )


def _make_scope(root: Path, daemon_port: int) -> tuple[Path, Path, dict[str, str]]:
    aimux_home = root / "aimux-home"
    home = root / "home"
    project = root / "project"
    for path in (aimux_home, home, project):
        path.mkdir(parents=True, exist_ok=True)
    _write_test_isolation_marker(aimux_home)
    subprocess.run(["git", "init", "-q"], cwd=project, check=True)
    (project / "README.md").write_text("# idle-process-spawn-gate\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=project, check=True)
    subprocess.run(
        [
            "git",
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "user.name=Aimux Gate",
            "-c",
            "user.email=aimux-gate@example.invalid",
            "commit",
            "-qm",
            "init",
        ],
        cwd=project,
        check=True,
    )
    env = os.environ.copy()
    env.update(
        {
            "AIMUX_HOME": str(aimux_home),
            "AIMUX_DAEMON_PORT": str(daemon_port),
            "AIMUX_TMUX_SOCKET_PATH": str(root / "tmux.sock"),
            "AIMUX_IDLE_SPAWN_GATE_EXEC_LOG": str(root / "exec.log"),
            "AIMUX_TEST_HARNESS": "cargo-test",
            "HOME": str(home),
        }
    )
    _install_exec_loggers(root, env, ["tmux", "git"])
    return aimux_home, project, env


def _shell_quote(value: str) -> str:
    return "'" + value.replace("'", "'\"'\"'") + "'"


def _install_exec_loggers(root: Path, env: dict[str, str], commands: list[str]) -> None:
    bin_dir = root / "exec-log-bin"
    bin_dir.mkdir(parents=True, exist_ok=True)
    original_path = env.get("PATH", os.environ.get("PATH", ""))
    for command in commands:
        real = shutil.which(command, path=original_path)
        if real is None:
            continue
        var_name = f"AIMUX_IDLE_SPAWN_GATE_REAL_{command.upper()}"
        env[var_name] = real
        wrapper = bin_dir / command
        wrapper.write_text(
            "#!/bin/sh\n"
            f"real=${{{var_name}}}\n"
            "log=${AIMUX_IDLE_SPAWN_GATE_EXEC_LOG:-}\n"
            "if [ -n \"$log\" ]; then\n"
            f"  printf '%s\\t%s\\t%s\\t%s\\n' \"$(date +%s)\" \"$$\" {_shell_quote(command)} \"$*\" >> \"$log\"\n"
            "fi\n"
            "exec \"$real\" \"$@\"\n",
            encoding="utf-8",
        )
        wrapper.chmod(0o755)
    env["PATH"] = str(bin_dir) + os.pathsep + original_path


def _exec_log_top(path: Path, limit: int = 8) -> list[tuple[str, int]]:
    if not path.is_file():
        return []
    counts: Counter[str] = Counter()
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    for line in lines:
        fields = line.split("\t", 3)
        if len(fields) >= 3:
            counts[f"{fields[2]} (isolated PATH exec)"] += 1
    return counts.most_common(limit)


def _reset_exec_log(path: Path) -> None:
    try:
        path.unlink()
    except FileNotFoundError:
        pass


def _start_idle_fleet(aimux_bin: Path, project: Path, env: dict[str, str]) -> None:
    _run([str(aimux_bin), "daemon", "ensure"], cwd=project, env=env, timeout=30)
    _run(
        [str(aimux_bin), "daemon", "project-ensure", "--project", str(project)],
        cwd=project,
        env=env,
        timeout=30,
    )


def _stop_idle_fleet(aimux_bin: Path, project: Path, env: dict[str, str]) -> None:
    _run([str(aimux_bin), "daemon", "stop"], cwd=project, env=env, timeout=15, check=False)
    tmux_socket = env.get("AIMUX_TMUX_SOCKET_PATH")
    if tmux_socket:
        subprocess.run(
            ["tmux", "-S", tmux_socket, "kill-server"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )


def _start_mutation(root: Path) -> subprocess.Popen[str]:
    child = textwrap.dedent(
        """
        import subprocess
        import sys
        import time

        children = []
        while True:
            children = [child for child in children if child.poll() is None]
            children.append(
                subprocess.Popen([
                    sys.executable,
                    "-c",
                    "import time; time.sleep(0.4)",
                    "aimux-idle-spawn-gate-mutation-child",
                ])
            )
            time.sleep(0.025)
        """
    )
    return subprocess.Popen(
        [sys.executable, "-c", child, "aimux-idle-spawn-gate-mutation-parent"],
        cwd=root,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        text=True,
    )


def _terminate(process: subprocess.Popen[str] | None) -> None:
    if process is None or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=3)


def _measure_with_sampler(
    meter: ProcessCreationMeter,
    sampler: ProcessSampler,
    seconds: float,
) -> Measurement:
    thread = threading.Thread(target=sampler.sample_for, args=(seconds,), daemon=True)
    thread.start()
    measurement = meter.measure(seconds)
    thread.join(timeout=max(1.0, seconds + 1.0))
    return measurement


def _print_top_spawners(top: list[tuple[str, int]]) -> None:
    if not top:
        print("top spawners: <none observed during samples>")
        return
    print("top spawners:")
    for label, count in top:
        print(f"  {count:4d}  {label}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=_repo_root_from_script())
    parser.add_argument("--aimux-bin", type=Path)
    parser.add_argument("--target-dir", type=Path)
    parser.add_argument("--budget-per-sec", type=float, default=DEFAULT_BUDGET_PER_SEC)
    parser.add_argument("--duration", type=float, default=DEFAULT_DURATION_SECONDS)
    parser.add_argument("--baseline-duration", type=float, default=DEFAULT_BASELINE_SECONDS)
    parser.add_argument("--settle", type=float, default=DEFAULT_SETTLE_SECONDS)
    parser.add_argument("--sample-interval", type=float, default=DEFAULT_SAMPLE_INTERVAL_SECONDS)
    parser.add_argument("--daemon-port", type=int, default=0)
    parser.add_argument("--keep-temp", action="store_true")
    parser.add_argument(
        "--mutation",
        choices=["busy-spawn"],
        help="Deliberately violate the idle process-spawn budget for proof.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    repo_root = args.repo_root.expanduser().resolve()
    target_dir = (args.target_dir or _default_target_dir(repo_root)).expanduser().resolve()
    aimux_bin = args.aimux_bin.expanduser().resolve() if args.aimux_bin else None
    if aimux_bin is None:
        aimux_bin = _build_aimux(repo_root, target_dir)
    if not aimux_bin.is_file():
        raise RuntimeError(f"aimux binary not found: {aimux_bin}")

    daemon_port = args.daemon_port or _free_loopback_port()
    if daemon_port == DEFAULT_DAEMON_PORT:
        raise RuntimeError(f"refusing to use default daemon port {DEFAULT_DAEMON_PORT}")

    base_dir = Path(os.environ.get("AIMUX_IDLE_SPAWN_GATE_ROOT", Path.home() / ".cache"))
    base_dir.mkdir(parents=True, exist_ok=True)
    root = Path(
        tempfile.mkdtemp(prefix="aimux-idle-process-spawn-gate-", dir=base_dir)
    ).resolve()

    meter = ProcessCreationMeter()
    mutation: subprocess.Popen[str] | None = None
    try:
        aimux_home, project, env = _make_scope(root, daemon_port)
        print(f"idle process spawn gate: platform={platform.system()}")
        print(f"repo root: {repo_root}")
        print(f"aimux binary: {aimux_bin}")
        print(f"scope: AIMUX_HOME={aimux_home} daemon_port={daemon_port}")
        print(f"budget: incremental <= {args.budget_per_sec:.2f} processes/sec")

        baseline = meter.measure(args.baseline_duration)
        _start_idle_fleet(aimux_bin, project, env)
        time.sleep(args.settle)
        _reset_exec_log(Path(env["AIMUX_IDLE_SPAWN_GATE_EXEC_LOG"]))

        if args.mutation == "busy-spawn":
            mutation = _start_mutation(root)
            time.sleep(0.25)

        sampler = ProcessSampler(args.sample_interval)
        active = _measure_with_sampler(meter, sampler, args.duration)

        incremental_rate = max(0.0, active.rate - baseline.rate)
        exec_top = _exec_log_top(Path(env["AIMUX_IDLE_SPAWN_GATE_EXEC_LOG"]))
        top = Counter(dict(sampler.top()))
        top.update(dict(exec_top))
        top_spawners = top.most_common(8)

        print(
            "baseline: "
            f"{baseline.count} processes / {baseline.seconds:.2f}s = {baseline.rate:.2f}/s "
            f"({baseline.method})"
        )
        print(
            "active:   "
            f"{active.count} processes / {active.seconds:.2f}s = {active.rate:.2f}/s "
            f"({active.method})"
        )
        print(f"incremental idle aimux rate: {incremental_rate:.2f}/s")
        _print_top_spawners(top_spawners)

        if incremental_rate > args.budget_per_sec:
            heaviest = top_spawners[0][0] if top_spawners else "<unknown>"
            print(
                "FAIL: idle aimux process-spawn budget exceeded: "
                f"{incremental_rate:.2f}/s > {args.budget_per_sec:.2f}/s; "
                f"heaviest observed spawner={heaviest}",
                file=sys.stderr,
            )
            return 1
        print("PASS: idle aimux process-spawn budget is within limit")
        return 0
    finally:
        _terminate(mutation)
        try:
            if "project" in locals() and "env" in locals():
                _stop_idle_fleet(aimux_bin, project, env)
        finally:
            if args.keep_temp:
                print(f"kept temp scope: {root}")
            else:
                shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except subprocess.CalledProcessError as error:
        print(error.stdout or "", end="")
        print(f"error: command failed with exit code {error.returncode}: {error.cmd}", file=sys.stderr)
        raise SystemExit(error.returncode)
    except subprocess.TimeoutExpired as error:
        print(f"error: command timed out after {error.timeout}s: {error.cmd}", file=sys.stderr)
        raise SystemExit(124)
    except Exception as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1)
