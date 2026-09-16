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
    expect(packageJson.scripts?.["installed:lite-gate"]).toBe("python3 scripts/installed-runtime-gate.py --scenario lite");
    expect(packageJson.scripts?.["release:readiness"]).toContain("yarn installed:gate");
    expect(packageJson.scripts?.["release:readiness"]).toContain("yarn installed:lite-gate");
    expect(packageJson.scripts?.verify).toBe("yarn verify:fast");
  });

  it("documents all user-visible installed runtime checks", () => {
    const result = spawnSync(python, [gatePath, "--list-checks"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "loop",
      "input",
      "liveness",
      "transcript",
      "git-leak",
      "sensitive-egress",
    ]);
  });

  it("documents the installed runtime gate scenarios", () => {
    const result = spawnSync(python, [gatePath, "--list-scenarios"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual(["full", "lite"]);
  });

  it("exposes one mutation switch for each installed-runtime check", () => {
    const source = readFileSync(gatePath, "utf8");

    expect(source).toContain('"loop-no-enroll"');
    expect(source).toContain('"input-drop"');
    expect(source).toContain('"liveness-skip-kill"');
    expect(source).toContain('"transcript-no-genuine"');
    expect(source).toContain('"git-leak-no-outer-ignore"');
    expect(source).toContain('"git-leak-no-attachments-rule"');
    expect(source).toContain('"sensitive-egress-nonloopback"');
  });

  it("proves real lite archives through install, strings, help, cargo tree, and variant refusals", () => {
    const source = readFileSync(gatePath, "utf8");

    expect(source).toContain('build_release_asset(work, "lite")');
    expect(source).toContain('install_release_asset(lite_asset, work, variant="lite")');
    expect(source).toContain('"AIMUX_RELAY_URL"');
    expect(source).toContain('"relay.aimux.app"');
    expect(source).toContain('"tokio_tungstenite"');
    expect(source).toContain('"wss://"');
    expect(source).toContain('"cargo", "tree"');
    expect(source).toContain("release archive BUILD_VARIANT mismatch: expected lite, got full");
    expect(source).toContain("release archive BUILD_VARIANT mismatch: expected full, got lite");
  });

  it("keeps data-at-rest gates inside the installed runtime gate", () => {
    const source = readFileSync(gatePath, "utf8");

    expect(source).toContain("SENSITIVE_STORES");
    expect(source).toContain('"attachments"');
    expect(source).toContain('"worktrees"');
    expect(source).toContain('"git", "config", "core.excludesFile", "/dev/null"');
    expect(source).toContain('"git", "add", "-n"');
    expect(source).toContain("root_gitignore_has_aimux_entry");
    expect(source).toContain("AIMUX_DAEMON_HOST");
    expect(source).toContain("assert_no_non_loopback_network_surface");
  });
});
