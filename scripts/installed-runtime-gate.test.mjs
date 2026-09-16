import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageJsonPath = join(repoRoot, "package.json");
const gatePath = join(repoRoot, "scripts/installed-runtime-gate.py");
const python = process.env.PYTHON || "python3";

describe("installed runtime gate wiring", () => {
  it("keeps the installed-runtime gate in the release readiness lane", () => {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));

    expect(packageJson.scripts?.["installed:gate"]).toBe("python3 scripts/installed-runtime-gate.py");
    expect(packageJson.scripts?.["release:readiness"]).toContain("yarn installed:gate");
    expect(packageJson.scripts?.verify).toBe("yarn verify:fast");
  });

  it("documents all user-visible installed runtime checks", () => {
    const result = spawnSync(python, [gatePath, "--list-checks"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual(["loop", "input", "liveness", "transcript"]);
  });

  it("exposes one mutation switch for each installed-runtime check", () => {
    const source = readFileSync(gatePath, "utf8");

    expect(source).toContain('"loop-no-enroll"');
    expect(source).toContain('"input-drop"');
    expect(source).toContain('"liveness-skip-kill"');
    expect(source).toContain('"transcript-no-genuine"');
  });
});
