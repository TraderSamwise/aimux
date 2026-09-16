import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const script = join(repoRoot, "scripts/check-remote-structural-boundary.mjs");
const tempRoots = [];

function tempDir(name) {
  const dir = mkdtempSync(join(tmpdir(), `aimux-${name}-`));
  tempRoots.push(dir);
  return dir;
}

function makeFixture({ lib = '#[cfg(feature = "remote-control")]\npub mod remote;\npub mod request_actor;\n' } = {}) {
  const root = tempDir("remote-structural");
  mkdirSync(join(root, "native/crates/aimux/src/remote"), { recursive: true });
  mkdirSync(join(root, "native/crates/aimux/src/daemon"), { recursive: true });
  writeFileSync(join(root, "native/crates/aimux/src/lib.rs"), lib, "utf8");
  writeFileSync(join(root, "native/crates/aimux/src/remote/mod.rs"), "pub mod relay_client;\n", "utf8");
  writeFileSync(join(root, "native/crates/aimux/src/remote/relay_client.rs"), "pub fn marker() {}\n", "utf8");
  writeFileSync(join(root, "native/crates/aimux/src/request_actor.rs"), "pub fn marker() {}\n", "utf8");
  return root;
}

function writeFixtureFile(root, name, contents) {
  const path = join(root, name);
  writeFileSync(path, contents, "utf8");
  return path;
}

function runCheck(root, extraArgs = []) {
  return spawnSync(
    process.execPath,
    [
      script,
      "--source-root",
      root,
      "--skip-build",
      "--dep-info-file",
      join(root, "dep-info.d"),
      "--cargo-tree-file",
      join(root, "cargo-tree.txt"),
      ...extraArgs,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("remote structural boundary checker", () => {
  it("passes when local dep-info excludes the gated remote tree and cargo tree has no remote deps", () => {
    const root = makeFixture();
    writeFixtureFile(root, "dep-info.d", "target: native/crates/aimux/src/lib.rs native/crates/aimux/src/request_actor.rs\n");
    writeFixtureFile(root, "cargo-tree.txt", "aimux v0.1.0\n└── tokio v1.0.0\n");

    const result = runCheck(root);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("remote structural boundary check passed for local");
    expect(result.stdout).toContain("compiled_remote_hits=0");
  });

  it("fails if the remote module declaration is not gated by remote-control", () => {
    const root = makeFixture({ lib: "pub mod remote;\npub mod request_actor;\n" });
    writeFixtureFile(root, "dep-info.d", "target: native/crates/aimux/src/lib.rs\n");
    writeFixtureFile(root, "cargo-tree.txt", "aimux v0.1.0\n");

    const result = runCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("expected exactly one #[cfg(feature = \"remote-control\")] pub mod remote;");
  });

  it("fails if local dep-info includes any source file from src/remote", () => {
    const root = makeFixture();
    writeFixtureFile(
      root,
      "dep-info.d",
      "target: native/crates/aimux/src/lib.rs native/crates/aimux/src/remote/relay_client.rs\n",
    );
    writeFixtureFile(root, "cargo-tree.txt", "aimux v0.1.0\n");

    const result = runCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("local build compiled remote source files");
    expect(result.stderr).toContain("native/crates/aimux/src/remote/relay_client.rs");
  });

  it("fails if the local cargo tree contains remote-control dependencies", () => {
    const root = makeFixture();
    writeFixtureFile(root, "dep-info.d", "target: native/crates/aimux/src/lib.rs\n");
    writeFixtureFile(root, "cargo-tree.txt", "aimux v0.1.0\n└── tokio-tungstenite v0.24.0\n");

    const result = runCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("local cargo tree contains remote-control dependencies");
  });

  it("proves the opposite full boundary includes remote source and dependencies", () => {
    const root = makeFixture();
    writeFixtureFile(
      root,
      "dep-info.d",
      "target: native/crates/aimux/src/lib.rs native/crates/aimux/src/remote/relay_client.rs\n",
    );
    writeFixtureFile(root, "cargo-tree.txt", "aimux v0.1.0\n├── ureq v2.0.0\n└── tokio-tungstenite v0.24.0\n");

    const result = runCheck(root, ["--variant", "full"]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("remote structural boundary check passed for full");
    expect(result.stdout).toContain("compiled_remote_hits=1");
    expect(result.stdout).toContain("remote_dependency_present=true");
  });

  it("fails the full boundary if remote dependencies are absent", () => {
    const root = makeFixture();
    writeFixtureFile(
      root,
      "dep-info.d",
      "target: native/crates/aimux/src/lib.rs native/crates/aimux/src/remote/relay_client.rs\n",
    );
    writeFixtureFile(root, "cargo-tree.txt", "aimux v0.1.0\n└── tokio v1.0.0\n");

    const result = runCheck(root, ["--variant", "full"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("full cargo tree is missing remote-control dependencies");
  });
});
