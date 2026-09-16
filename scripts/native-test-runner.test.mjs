import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageJsonPath = join(repoRoot, "package.json");
const runnerPath = join(repoRoot, "scripts/native-test-runner.py");
const python = process.env.PYTHON || "python3";
const roots = [];

function tempAimuxHome(name) {
  const root = mkdtempSync(join(tmpdir(), `aimux-${name}-`));
  roots.push(root);
  return root;
}

function tempRoot(name) {
  const root = mkdtempSync(join(tmpdir(), `aimux-${name}-`));
  roots.push(root);
  return root;
}

function runnerEnv(home, extra = {}) {
  return {
    ...process.env,
    AIMUX_HOME: home,
    AIMUX_NATIVE_TEST_LOCK_STALE_MS: "5000",
    AIMUX_NATIVE_TEST_WAIT_LOG_MS: "50",
    AIMUX_NATIVE_TEST_WAIT_TIMEOUT_MS: "1500",
    ...extra,
  };
}

function pythonProbeSource(milliseconds = 120) {
  return `
import importlib.util
import json
from pathlib import Path
import sys
import time

runner_path, log_path, worker_id, sleep_ms, lock_root = sys.argv[1:6]
spec = importlib.util.spec_from_file_location("native_test_runner", runner_path)
runner = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = runner
spec.loader.exec_module(runner)
runner.MACHINE_NATIVE_TEST_LOCKS_DIR = Path(lock_root)

with runner.native_test_slot(f"probe-{worker_id}"):
    with open(log_path, "a") as log:
        log.write(json.dumps({"event": "start", "id": worker_id}) + "\\n")
        log.flush()
    time.sleep(int(sleep_ms) / 1000)
    with open(log_path, "a") as log:
        log.write(json.dumps({"event": "end", "id": worker_id}) + "\\n")
        log.flush()
`;
}

function spawnProbe(home, id, extraEnv = {}, milliseconds = 120, options = {}) {
  const logPath = options.logPath ?? join(home, "events.jsonl");
  const lockRoot = options.lockRoot ?? join(home, "machine-native-test-locks");
  return spawn(
    python,
    ["-c", pythonProbeSource(milliseconds), runnerPath, logPath, String(id), String(milliseconds), lockRoot],
    {
      cwd: repoRoot,
      env: runnerEnv(home, extraEnv),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

function collect(child) {
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return new Promise((resolvePromise) => {
    child.on("exit", (code, signal) => {
      resolvePromise({ code, signal, stdout, stderr });
    });
  });
}

function runProbe(home, extraEnv = {}, options = {}) {
  const logPath = options.logPath ?? join(home, "events.jsonl");
  const lockRoot = options.lockRoot ?? join(home, "machine-native-test-locks");
  return spawnSync(python, ["-c", pythonProbeSource(1), runnerPath, logPath, "single", "1", lockRoot], {
    cwd: repoRoot,
    env: runnerEnv(home, extraEnv),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function runPython(source, extraEnv = {}) {
  return spawnSync(python, ["-c", source, runnerPath], {
    cwd: repoRoot,
    env: { ...process.env, ...extraEnv },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function waitForLock(lockRoot) {
  const lockPath = join(lockRoot, "native-test-0");
  const start = Date.now();
  while (true) {
    if (existsSync(lockPath)) {
      try {
        JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8"));
        return;
      } catch {
        // The holder creates the directory before writing owner.json. Keep
        // waiting so crash tests kill a fully acquired lock, not a partial one.
      }
    }
    if (Date.now() - start > 1000) throw new Error("timed out waiting for native-test-0");
  }
}

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop(), { recursive: true, force: true });
  }
});

describe("native-test-runner machine-wide cap", () => {
  it("keeps the yarn native:test lane on the Python runner instead of nesting yarn", () => {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    const script = packageJson.scripts?.["native:test"];

    expect(script).toBe("CARGO_INCREMENTAL=0 python3 scripts/native-test-runner.py");
    expect(script).not.toMatch(/(^|[;&|]\s*)yarn(\s|$)/);
    expect(script).not.toMatch(/(^|[;&|]\s*)npm(\s|$)/);
  });

  it("defaults Aimux agent runs to a per-session Cargo target directory", () => {
    const result = runPython(
      `
import importlib.util
import sys
spec = importlib.util.spec_from_file_location("native_test_runner", sys.argv[1])
runner = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = runner
spec.loader.exec_module(runner)
print(runner.default_agent_cargo_target_dir({"AIMUX_SESSION_ID": "codex:test"}))
print(runner.default_agent_cargo_target_dir({"AIMUX_SESSION_ID": "codex:test", "CARGO_TARGET_DIR": "/tmp/custom"}))
`,
      { CARGO_TARGET_DIR: "" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual(["/tmp/aimux-cargo-target-codex_test", "None"]);
  });

  it("bounds observed concurrent native suites to AIMUX_NATIVE_TEST_JOBS", async () => {
    const home = tempAimuxHome("native-test-cap");
    const lockRoot = tempRoot("native-test-cap-locks");
    const children = Array.from({ length: 6 }, (_, index) =>
      spawnProbe(home, index, { AIMUX_NATIVE_TEST_JOBS: "3" }, 160, { lockRoot }),
    );
    const results = await Promise.all(children.map(collect));

    expect(
      results.map((result) => result.code),
      results.map((result) => result.stderr).join("\n"),
    ).toEqual([0, 0, 0, 0, 0, 0]);
    const events = readFileSync(join(home, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    let active = 0;
    let maxActive = 0;
    for (const event of events) {
      active += event.event === "start" ? 1 : -1;
      maxActive = Math.max(maxActive, active);
    }
    expect(maxActive).toBeLessThanOrEqual(3);
  });

  it("serializes native suites across different AIMUX_HOME values", async () => {
    const lockRoot = tempRoot("native-test-machine-locks");
    const logPath = join(lockRoot, "events.jsonl");
    const homeA = tempAimuxHome("native-test-home-a");
    const homeB = tempAimuxHome("native-test-home-b");
    const children = [
      spawnProbe(homeA, "a", { AIMUX_NATIVE_TEST_JOBS: "1" }, 180, { lockRoot, logPath }),
      spawnProbe(homeB, "b", { AIMUX_NATIVE_TEST_JOBS: "1" }, 180, { lockRoot, logPath }),
    ];
    const results = await Promise.all(children.map(collect));

    expect(
      results.map((result) => result.code),
      results.map((result) => result.stderr).join("\n"),
    ).toEqual([0, 0]);
    const events = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    let active = 0;
    let maxActive = 0;
    for (const event of events) {
      active += event.event === "start" ? 1 : -1;
      maxActive = Math.max(maxActive, active);
    }
    expect(maxActive).toBe(1);
    expect(results.map((result) => result.stderr).join("\n")).toContain(
      "native test concurrency cap reached (1/1)",
    );
  });

  it("allows runners up to the cap across different AIMUX_HOME values without waiting", async () => {
    const lockRoot = tempRoot("native-test-machine-cap-locks");
    const logPath = join(lockRoot, "events.jsonl");
    const homes = [tempAimuxHome("native-test-cap-a"), tempAimuxHome("native-test-cap-b"), tempAimuxHome("native-test-cap-c")];
    const children = homes.map((home, index) =>
      spawnProbe(home, index, { AIMUX_NATIVE_TEST_JOBS: "3" }, 180, { lockRoot, logPath }),
    );
    const results = await Promise.all(children.map(collect));

    expect(
      results.map((result) => result.code),
      results.map((result) => result.stderr).join("\n"),
    ).toEqual([0, 0, 0]);
    expect(results.map((result) => result.stderr).join("\n")).not.toContain(
      "native test concurrency cap reached",
    );
    const events = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    let active = 0;
    let maxActive = 0;
    for (const event of events) {
      active += event.event === "start" ? 1 : -1;
      maxActive = Math.max(maxActive, active);
    }
    expect(maxActive).toBe(3);
  });

  it("does not report waiting for one uncontended native suite", () => {
    const home = tempAimuxHome("native-test-single");
    const result = runProbe(home, { AIMUX_NATIVE_TEST_JOBS: "3" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain("native test concurrency cap reached");
  });

  it("reclaims a crashed holder instead of blocking indefinitely", () => {
    const home = tempAimuxHome("native-test-stale");
    const lockRoot = tempRoot("native-test-stale-locks");
    const lockPath = join(lockRoot, "native-test-0");
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ pid: 999999, label: "crashed" }));

    const result = runProbe(home, { AIMUX_NATIVE_TEST_JOBS: "1" }, { lockRoot });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("reclaimed stale native test lock");
  });

  it("releases a machine-wide slot after the holder process is killed", async () => {
    const lockRoot = tempRoot("native-test-killed-locks");
    const logPath = join(lockRoot, "events.jsonl");
    const holderHome = tempAimuxHome("native-test-killed-holder");
    const waiterHome = tempAimuxHome("native-test-killed-waiter");
    const holder = spawnProbe(holderHome, "holder", { AIMUX_NATIVE_TEST_JOBS: "1" }, 5000, {
      lockRoot,
      logPath,
    });
    const holderDone = collect(holder);
    waitForLock(lockRoot);

    holder.kill("SIGKILL");
    await holderDone;
    const result = runProbe(waiterHome, { AIMUX_NATIVE_TEST_JOBS: "1" }, { lockRoot, logPath });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("reclaimed stale native test lock");
  });

  it("does not reclaim an unreadable holder as stale by age alone", () => {
    const home = tempAimuxHome("native-test-unreadable");
    const lockRoot = tempRoot("native-test-unreadable-locks");
    const lockPath = join(lockRoot, "native-test-0");
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(join(lockPath, "owner.json"), "{not json");

    const result = runProbe(
      home,
      {
        AIMUX_NATIVE_TEST_JOBS: "1",
        AIMUX_NATIVE_TEST_LOCK_STALE_MS: "1",
        AIMUX_NATIVE_TEST_WAIT_TIMEOUT_MS: "250",
      },
      { lockRoot },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("native test concurrency cap wait timed out");
    expect(result.stderr).not.toContain("reclaimed stale native test lock");
  });

  it("reports bounded waits while another native suite holds the cap", async () => {
    const home = tempAimuxHome("native-test-wait");
    const lockRoot = tempRoot("native-test-wait-locks");
    const holder = spawnProbe(home, "holder", { AIMUX_NATIVE_TEST_JOBS: "1" }, 250, { lockRoot });
    const holderDone = collect(holder);
    waitForLock(lockRoot);

    const waiter = runProbe(home, { AIMUX_NATIVE_TEST_JOBS: "1" }, { lockRoot });
    const holderResult = await holderDone;

    expect(holderResult.code).toBe(0);
    expect(waiter.status, waiter.stderr).toBe(0);
    expect(waiter.stderr).toContain("native test concurrency cap reached (1/1)");
    expect(waiter.stderr).toContain("waiting before probe-single");
    expect(waiter.stderr).toContain("waited");
  });
});
