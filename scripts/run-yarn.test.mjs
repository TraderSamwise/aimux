import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runYarn = join(repoRoot, "scripts/run-yarn");
const tempDirs = [];

function tempDir(name) {
  const dir = mkdtempSync(join(tmpdir(), `aimux-${name}-`));
  tempDirs.push(dir);
  return dir;
}

function runYarnCommand(args, options = {}) {
  return spawnSync(runYarn, args, {
    cwd: repoRoot,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

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

  it("falls back when VOLTA_HOME has no Yarn image", () => {
    const missingVoltaHome = join(tempDir("missing-volta-home"), "does-not-exist");
    const result = runYarnCommand(["node", "-e", "process.exit(7)"], {
      env: { VOLTA_HOME: missingVoltaHome },
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(7);
    expect(result.stderr).toContain("Exit code: 7");
  });

  it("uses a plain yarn binary on PATH when Volta is absent", () => {
    const bin = tempDir("plain-yarn-path");
    symlinkSync("/bin/bash", join(bin, "bash"));
    writeFileSync(
      join(bin, "yarn"),
      "#!/usr/bin/env bash\nprintf 'plain-yarn:%s\\n' \"$*\"\nexit 23\n",
      { mode: 0o755 },
    );

    const result = runYarnCommand(["sentinel", "args"], {
      env: {
        PATH: bin,
        VOLTA_HOME: join(bin, "missing-volta"),
      },
    });

    expect(result.status, result.stderr).toBe(23);
    expect(result.stdout).toContain("plain-yarn:sentinel args");
  });

  it("reports every provider checked when Yarn cannot be found", () => {
    const bin = tempDir("no-yarn-path");
    symlinkSync("/bin/bash", join(bin, "bash"));
    const missingVoltaHome = join(bin, "missing-volta");

    const result = runYarnCommand(["--version"], {
      env: {
        PATH: bin,
        VOLTA_HOME: missingVoltaHome,
        AIMUX_YARN_CLI: "",
      },
    });

    expect(result.status).toBe(127);
    expect(result.stderr).toContain("unable to find a Yarn runner for scripts/run-yarn");
    expect(result.stderr).toContain(`Volta Yarn CLI: ${missingVoltaHome}/tools/image/yarn/1.22.21/lib/cli.js`);
    expect(result.stderr).toContain("PATH yarn: <not found>");
    expect(result.stderr).toContain("corepack: <not found>");
  });
});
