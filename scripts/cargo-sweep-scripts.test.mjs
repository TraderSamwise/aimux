import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cleanupRoots = [];

afterEach(() => {
  while (cleanupRoots.length > 0) {
    const root = cleanupRoots.pop();
    rmSync(root, { recursive: true, force: true });
  }
});

function scratch() {
  const root = mkdtempSync(join(tmpdir(), "aimux-cargo-sweep-test-"));
  cleanupRoots.push(root);
  return root;
}

function writeExecutable(path, body) {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function fakeCargoEnv(root) {
  const bin = join(root, "bin");
  const log = join(root, "cargo.log");
  mkdirSync(bin, { recursive: true });
  writeExecutable(
    join(bin, "cargo"),
    `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "sweep" ]; then
  printf 'target=%s args=%s\\n' "\${CARGO_TARGET_DIR:-}" "$*" >> "${log}"
  exit 0
fi
exit 99
`,
  );
  writeExecutable(
    join(bin, "cargo-sweep"),
    `#!/usr/bin/env bash
exit 0
`,
  );
  return {
    PATH: `${bin}:${process.env.PATH}`,
    log,
  };
}

function fakeWorkspace(root) {
  const workspace = join(root, "native");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "Cargo.toml"), "[workspace]\nmembers = []\n");
  return workspace;
}

describe("cargo sweep maintenance scripts", () => {
  it("sweeps stale target dirs once after canonicalizing /tmp aliases", () => {
    const root = scratch();
    const tmp = join(root, "tmp");
    const workspace = fakeWorkspace(root);
    const target = join(tmp, "aimux-cargo-target-stale");
    mkdirSync(join(target, "debug"), { recursive: true });
    writeFileSync(join(target, "debug", "artifact"), "old");
    const canonicalTarget = realpathSync(target);

    const fake = fakeCargoEnv(root);
    const result = run("bash", ["scripts/cargo-sweep-stale-targets.sh", "--apply", "--days", "3", "--min-age-minutes", "0"], {
      env: {
        PATH: fake.PATH,
        AIMUX_CARGO_SWEEP_WORKSPACE_ROOT: workspace,
        AIMUX_CARGO_SWEEP_TMP_ROOTS: `${tmp} ${tmp}`,
        AIMUX_CARGO_SWEEP_PRUNE_WORKTREES: "0",
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Sweeping ${canonicalTarget} artifacts older than 3 day(s).`);
    const calls = readFileSync(fake.log, "utf8").trim().split("\n");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(`target=${canonicalTarget}`);
  });

  it("skips an active target whose process keeps the target path out of argv", async () => {
    const root = scratch();
    const tmp = join(root, "tmp");
    const workspace = fakeWorkspace(root);
    const target = join(tmp, "aimux-cargo-target-active");
    mkdirSync(join(target, "debug"), { recursive: true });
    const heldFile = join(target, "debug", "artifact");
    writeFileSync(heldFile, "active");
    const canonicalTarget = realpathSync(target);

    const active = spawn(process.execPath, ["-e", "const fs = require('node:fs'); const fd = fs.openSync('debug/artifact', 'r'); setTimeout(() => fs.closeSync(fd), 20000);"], {
      cwd: canonicalTarget,
      env: { ...process.env, CARGO_TARGET_DIR: canonicalTarget },
      stdio: "ignore",
      detached: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 250));

    try {
      const fake = fakeCargoEnv(root);
      const result = run("bash", ["scripts/cargo-sweep-stale-targets.sh", "--apply", "--min-age-minutes", "0"], {
        env: {
          PATH: fake.PATH,
          AIMUX_CARGO_SWEEP_WORKSPACE_ROOT: workspace,
          AIMUX_CARGO_SWEEP_TMP_ROOTS: tmp,
          AIMUX_CARGO_SWEEP_PRUNE_WORKTREES: "0",
        },
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(`Skipping active target dir: ${canonicalTarget}`);
      expect(existsSync(fake.log)).toBe(false);
    } finally {
      active.kill("SIGTERM");
      await new Promise((resolve) => active.once("exit", resolve));
    }
  });

  it("git worktree prune leaves a real dirty temp worktree alone", () => {
    const root = scratch();
    const tmp = join(root, "tmp");
    const workspace = fakeWorkspace(root);
    const repo = join(root, "repo");
    const worktree = join(tmp, "dirty-worktree");
    mkdirSync(tmp, { recursive: true });
    mkdirSync(repo, { recursive: true });

    run("git", ["init"], { cwd: repo });
    run("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    run("git", ["config", "user.name", "Aimux Test"], { cwd: repo });
    writeFileSync(join(repo, "README.md"), "base\n");
    run("git", ["add", "README.md"], { cwd: repo });
    run("git", ["commit", "-m", "base"], { cwd: repo });
    run("git", ["worktree", "add", worktree], { cwd: repo });
    writeFileSync(join(worktree, "dirty.txt"), "do not remove\n");

    const fake = fakeCargoEnv(root);
    const result = run("bash", ["scripts/cargo-sweep-stale-targets.sh", "--apply"], {
      env: {
        PATH: fake.PATH,
        AIMUX_CARGO_SWEEP_WORKSPACE_ROOT: workspace,
        AIMUX_CARGO_SWEEP_TMP_ROOTS: tmp,
        AIMUX_CARGO_SWEEP_WORKTREE_REPOS: repo,
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(worktree, "dirty.txt"))).toBe(true);
    const status = run("git", ["status", "--short"], { cwd: worktree });
    expect(status.stdout).toContain("dirty.txt");
  });

  it("renders a local schedule without installing it", () => {
    const root = scratch();
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });

    const result = run("bash", ["scripts/install-cargo-sweep-schedule.sh", "--dry-run", "--repo", repoRoot, "--label", "dev.aimux.cargo-sweep.test"], {
      env: {
        HOME: home,
        AIMUX_CARGO_SWEEP_INTERVAL_SECONDS: "60",
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/Would install (launchd agent|systemd user timer|cron entry)/);
  });
});
