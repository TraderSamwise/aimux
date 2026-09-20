import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runYarn = join(repoRoot, "scripts/run-yarn.mjs");

function runYarnCommand(args) {
  return spawnSync(process.execPath, [runYarn, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("run-yarn", () => {
  it("reports success honestly", () => {
    const result = runYarnCommand(["node", "-e", "process.exit(0)"]);

    expect(result.status, result.stderr).toBe(0);
  });

  it("propagates child exit codes instead of masking them as runner failures", () => {
    const result = runYarnCommand(["node", "-e", "process.exit(7)"]);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(7);
    expect(result.stderr).toContain("Exit code: 7");
  });

  it("propagates child exit codes when running in a package cwd", () => {
    const result = runYarnCommand(["--cwd", "app", "node", "-e", "process.exit(9)"]);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(9);
    expect(result.stderr).toContain("Exit code: 9");
  });
});
