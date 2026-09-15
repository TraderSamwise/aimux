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
import sys
import time

runner_path, log_path, worker_id, sleep_ms = sys.argv[1:5]
spec = importlib.util.spec_from_file_location("native_test_runner", runner_path)
runner = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = runner
spec.loader.exec_module(runner)

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

function spawnProbe(home, id, extraEnv = {}, milliseconds = 120) {
  return spawn(
    python,
    ["-c", pythonProbeSource(milliseconds), runnerPath, join(home, "events.jsonl"), String(id), String(milliseconds)],
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

function runProbe(home, extraEnv = {}) {
  return spawnSync(python, ["-c", pythonProbeSource(1), runnerPath, join(home, "events.jsonl"), "single", "1"], {
    cwd: repoRoot,
    env: runnerEnv(home, extraEnv),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function waitForLock(home) {
  const lockPath = join(home, "locks/native-test-0");
  const start = Date.now();
  while (!existsSync(lockPath)) {
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

  it("bounds observed concurrent native suites to AIMUX_NATIVE_TEST_JOBS", async () => {
    const home = tempAimuxHome("native-test-cap");
    const children = Array.from({ length: 6 }, (_, index) =>
      spawnProbe(home, index, { AIMUX_NATIVE_TEST_JOBS: "3" }, 160),
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

  it("does not report waiting for one uncontended native suite", () => {
    const home = tempAimuxHome("native-test-single");
    const result = runProbe(home, { AIMUX_NATIVE_TEST_JOBS: "3" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain("native test concurrency cap reached");
  });

  it("reclaims a crashed holder instead of blocking indefinitely", () => {
    const home = tempAimuxHome("native-test-stale");
    const lockPath = join(home, "locks/native-test-0");
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ pid: 999999, label: "crashed" }));

    const result = runProbe(home, { AIMUX_NATIVE_TEST_JOBS: "1" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("reclaimed stale native test lock");
  });

  it("reports bounded waits while another native suite holds the cap", async () => {
    const home = tempAimuxHome("native-test-wait");
    const holder = spawnProbe(home, "holder", { AIMUX_NATIVE_TEST_JOBS: "1" }, 250);
    const holderDone = collect(holder);
    waitForLock(home);

    const waiter = runProbe(home, { AIMUX_NATIVE_TEST_JOBS: "1" });
    const holderResult = await holderDone;

    expect(holderResult.code).toBe(0);
    expect(waiter.status, waiter.stderr).toBe(0);
    expect(waiter.stderr).toContain("native test concurrency cap reached (1/1)");
    expect(waiter.stderr).toContain("waiting before probe-single");
    expect(waiter.stderr).toContain("waited");
  });
});
