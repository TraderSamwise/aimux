#!/usr/bin/env python3
"""Build once, then run explicitly-audited Rust integration targets.

Cargo executes integration-test binaries one after another. Most Aimux targets
are pure contract or model tests and can safely run as separate processes in
parallel, but runtime tests that touch tmux, daemons, sockets, fixed paths, or
other machine-global state must remain serial. The two classification files are
therefore an allowlist plus an explicit serial-with-reason list, and this runner
refuses to run if a target is unclassified.
"""

from __future__ import annotations

import concurrent.futures
import json
import os
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "native" / "Cargo.toml"
TESTS_DIR = ROOT / "native" / "crates" / "aimux" / "tests"
PARALLEL_TARGETS = ROOT / "scripts" / "native-test-parallel-targets.txt"
SERIAL_TARGETS = ROOT / "scripts" / "native-test-serial-targets.txt"


@dataclass(frozen=True)
class TestExecutable:
    name: str
    path: Path
    src_path: Path
    integration: bool


@dataclass(frozen=True)
class TestResult:
    name: str
    command: list[str]
    returncode: int
    duration: float
    stdout: str
    stderr: str


def read_list(path: Path) -> list[str]:
    values: list[str] = []
    for line_number, raw_line in enumerate(path.read_text().splitlines(), start=1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        target = line.split()[0]
        if target in values:
            raise SystemExit(f"{path}:{line_number}: duplicate target {target}")
        values.append(target)
    return values


def read_serial(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for line_number, raw_line in enumerate(path.read_text().splitlines(), start=1):
        line = raw_line.rstrip()
        if not line or line.lstrip().startswith("#"):
            continue
        parts = line.split(None, 1)
        if len(parts) != 2:
            raise SystemExit(f"{path}:{line_number}: expected target and reason")
        target, reason = parts
        if target in values:
            raise SystemExit(f"{path}:{line_number}: duplicate target {target}")
        values[target] = reason
    return values


def integration_target_names() -> set[str]:
    return {path.stem for path in TESTS_DIR.glob("*.rs")}


def validate_classification(parallel: set[str], serial: set[str]) -> None:
    actual = integration_target_names()
    overlap = parallel & serial
    stale = (parallel | serial) - actual
    missing = actual - (parallel | serial)
    if overlap or stale or missing:
        if overlap:
            print("Targets classified as both parallel and serial:", file=sys.stderr)
            for target in sorted(overlap):
                print(f"  {target}", file=sys.stderr)
        if stale:
            print("Classified targets with no matching integration test:", file=sys.stderr)
            for target in sorted(stale):
                print(f"  {target}", file=sys.stderr)
        if missing:
            print("Unclassified integration test targets:", file=sys.stderr)
            for target in sorted(missing):
                print(f"  {target}", file=sys.stderr)
        raise SystemExit(2)


def build_tests() -> list[TestExecutable]:
    command = [
        "cargo",
        "test",
        "--manifest-path",
        str(MANIFEST),
        "--no-fail-fast",
        "--no-run",
        "--message-format=json",
    ]
    print("+ " + " ".join(command), flush=True)
    process = subprocess.run(
        command,
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=sys.stderr,
        check=False,
    )
    if process.returncode != 0:
        raise SystemExit(process.returncode)

    executables: list[TestExecutable] = []
    seen: set[Path] = set()
    for line in process.stdout.splitlines():
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            continue
        if message.get("reason") != "compiler-artifact":
            continue
        executable = message.get("executable")
        target = message.get("target") or {}
        if not executable or not target.get("test"):
            continue
        path = Path(executable)
        if path.parent.name != "deps":
            continue
        if path in seen:
            continue
        seen.add(path)
        src_path = Path(target.get("src_path") or "")
        name = str(target.get("name") or path.name)
        integration = src_path.parent.resolve() == TESTS_DIR.resolve()
        executables.append(TestExecutable(name, path, src_path, integration))
    if not executables:
        raise SystemExit("cargo produced no test executables")
    return executables


def run_executable(test: TestExecutable) -> TestResult:
    command = [str(test.path)]
    if not test.integration:
        # Unit/bin test binaries share process-wide globals such as the async
        # runtime; the runner already provides cross-target parallelism.
        command.append("--test-threads=1")
    started = time.monotonic()
    process = subprocess.run(
        command,
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    return TestResult(
        test.name,
        command,
        process.returncode,
        time.monotonic() - started,
        process.stdout,
        process.stderr,
    )


def print_result(result: TestResult) -> None:
    status = "ok" if result.returncode == 0 else f"FAILED ({result.returncode})"
    print(f"{status:12} {result.duration:7.2f}s {result.name}", flush=True)


def run_serial(tests: list[TestExecutable]) -> list[TestResult]:
    results: list[TestResult] = []
    for test in tests:
        result = run_executable(test)
        print_result(result)
        results.append(result)
    return results


def run_parallel(tests: list[TestExecutable], jobs: int) -> list[TestResult]:
    results: list[TestResult] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=jobs) as executor:
        futures = {executor.submit(run_executable, test): test for test in tests}
        for future in concurrent.futures.as_completed(futures):
            result = future.result()
            print_result(result)
            results.append(result)
    return results


def run_doc_tests() -> TestResult:
    command = [
        "cargo",
        "test",
        "--manifest-path",
        str(MANIFEST),
        "--doc",
        "--no-fail-fast",
    ]
    started = time.monotonic()
    process = subprocess.run(
        command,
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    return TestResult(
        "doc-tests",
        command,
        process.returncode,
        time.monotonic() - started,
        process.stdout,
        process.stderr,
    )


def report_failures(results: list[TestResult]) -> None:
    failures = [result for result in results if result.returncode != 0]
    if not failures:
        return
    print("\nFailing Rust test targets:", file=sys.stderr)
    for result in failures:
        print(
            f"\n--- {result.name} ({result.returncode}, {result.duration:.2f}s) ---",
            file=sys.stderr,
        )
        print("+ " + " ".join(result.command), file=sys.stderr)
        if result.stdout:
            print(result.stdout[-20_000:], file=sys.stderr)
        if result.stderr:
            print(result.stderr[-20_000:], file=sys.stderr)


def main() -> int:
    parallel_targets = set(read_list(PARALLEL_TARGETS))
    serial_targets = read_serial(SERIAL_TARGETS)
    validate_classification(parallel_targets, set(serial_targets))

    started = time.monotonic()
    build_started = time.monotonic()
    executables = build_tests()
    build_duration = time.monotonic() - build_started

    integrations = {test.name: test for test in executables if test.integration}
    non_integrations = [test for test in executables if not test.integration]
    missing_binaries = (parallel_targets | set(serial_targets)) - set(integrations)
    if missing_binaries:
        print("Classified targets missing from cargo test build:", file=sys.stderr)
        for target in sorted(missing_binaries):
            print(f"  {target}", file=sys.stderr)
        return 2

    parallel_tests = [integrations[name] for name in sorted(parallel_targets)]
    serial_tests = non_integrations + [
        integrations[name] for name in sorted(serial_targets)
    ]
    jobs = int(os.environ.get("AIMUX_NATIVE_TEST_JOBS") or min(4, os.cpu_count() or 2))
    jobs = max(1, jobs)

    print(
        "Rust test target plan: "
        f"{len(parallel_tests)} parallel-safe, "
        f"{len(serial_targets)} serial integration, "
        f"{len(non_integrations)} cargo unit/bin targets, "
        f"{jobs} parallel jobs",
        flush=True,
    )
    print(f"Build/no-run: {build_duration:.2f}s", flush=True)

    results: list[TestResult] = []
    parallel_started = time.monotonic()
    results.extend(run_parallel(parallel_tests, jobs))
    parallel_duration = time.monotonic() - parallel_started

    serial_started = time.monotonic()
    results.extend(run_serial(serial_tests))
    serial_duration = time.monotonic() - serial_started

    doc_result = run_doc_tests()
    print_result(doc_result)
    results.append(doc_result)

    total_duration = time.monotonic() - started
    failures = [result for result in results if result.returncode != 0]
    report_failures(results)
    print(
        "\nRust test target summary: "
        f"build={build_duration:.2f}s "
        f"parallel={parallel_duration:.2f}s "
        f"serial={serial_duration:.2f}s "
        f"total={total_duration:.2f}s "
        f"failed={len(failures)}",
        flush=True,
    )
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
