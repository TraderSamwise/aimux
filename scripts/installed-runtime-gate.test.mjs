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
    expect(packageJson.scripts?.["installed:local-gate"]).toBe("python3 scripts/installed-runtime-gate.py --scenario local");
    expect(packageJson.scripts?.["release:readiness"]).toContain("scripts/run-yarn installed:gate");
    expect(packageJson.scripts?.["release:readiness"]).toContain("scripts/run-yarn installed:local-gate");
    expect(packageJson.scripts?.verify).toBe("scripts/run-yarn verify:fast");
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
      "structural-boundary",
      "source-review",
    ]);
  });

  it("documents the installed runtime gate scenarios", () => {
    const result = spawnSync(python, [gatePath, "--list-scenarios"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual(["full", "local"]);
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
    expect(source).toContain('"structural-boundary-remote-compiled"');
    expect(source).toContain('"source-review-missing-provenance"');
  });

  it("proves real local archives through install, strings, help, cargo tree, and variant refusals", () => {
    const source = readFileSync(gatePath, "utf8");

    expect(source).toContain('build_release_asset(work, "local")');
    expect(source).toContain('install_release_asset(local_asset, work, variant="local")');
    expect(source).toContain('"AIMUX_RELAY_URL"');
    expect(source).toContain('"relay.aimux.app"');
    expect(source).toContain('"tokio_tungstenite"');
    expect(source).toContain('"wss://"');
    expect(source).toContain('"cargo", "tree"');
    expect(source).toContain("release archive BUILD_VARIANT mismatch: expected local, got full");
    expect(source).toContain("release archive BUILD_VARIANT mismatch: expected full, got local");
  });

  it("wires the structural remote boundary into the installed local gate", () => {
    const source = readFileSync(gatePath, "utf8");

    expect(source).toContain('"structural-boundary"');
    expect(source).toContain('"node"');
    expect(source).toContain('"scripts/check-remote-structural-boundary.mjs"');
    expect(source).toContain('"--variant"');
    expect(source).toContain('"local"');
    expect(source).toContain('"structural-boundary-remote-compiled"');
  });

  it("adds the reviewer source-build path to the installed local gate", () => {
    const source = readFileSync(gatePath, "utf8");

    expect(source).toContain('"source-review"');
    expect(source).toContain('"git", "clone", "--quiet"');
    expect(source).toContain('"scripts/build-local-release-from-source.sh"');
    expect(source).toContain("reviewer source build matched release-lane local artifact surfaces");
    expect(source).toContain('"source-review-missing-provenance"');
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
