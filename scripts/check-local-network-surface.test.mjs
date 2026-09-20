import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const script = join(repoRoot, "scripts/check-local-network-surface.mjs");
const tempRoots = [];

function tempDir(name) {
  const dir = mkdtempSync(join(tmpdir(), `aimux-${name}-`));
  tempRoots.push(dir);
  return dir;
}

function makeFixture(source) {
  const root = tempDir("local-network-surface");
  mkdirSync(join(root, "native/crates/aimux/src"), { recursive: true });
  writeFileSync(join(root, "native/crates/aimux/src/lib.rs"), source, "utf8");
  return root;
}

function runCheck(root, extraArgs = []) {
  return spawnSync(
    process.execPath,
    [script, "--source-root", root, "--skip-package-identity-check", ...extraArgs],
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

describe("local network surface checker", () => {
  it("passes loopback socket calls in local source", () => {
    const root = makeFixture(`
pub fn wake() {
    let _ = std::net::TcpStream::connect(("127.0.0.1", 43192));
    let _ = std::net::TcpListener::bind("127.0.0.1:0");
}
`);

    const result = runCheck(root);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Local network surface gate passed");
  });

  it("fails a non-loopback TcpStream::connect outside src/remote", () => {
    const root = makeFixture(`
pub fn leak() {
    let _ = std::net::TcpStream::connect(("198.51.100.10", 443));
}
`);

    const result = runCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("non-loopback network target");
    expect(result.stderr).toContain("198.51.100.10");
  });

  it("allows remote-control source to contain remote network calls under src/remote", () => {
    const root = makeFixture("pub mod remote;\n");
    mkdirSync(join(root, "native/crates/aimux/src/remote"), { recursive: true });
    writeFileSync(
      join(root, "native/crates/aimux/src/remote/relay.rs"),
      'pub fn connect() { let _ = std::net::TcpStream::connect(("198.51.100.10", 443)); }\n',
      "utf8",
    );

    const result = runCheck(root);

    expect(result.status, result.stderr).toBe(0);
  });

  it("fails cfg! feature checks because they compile both branches into local builds", () => {
    const root = makeFixture(`
pub fn local_boundary() -> bool {
    cfg!(feature = "remote-control")
}
`);

    const result = runCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('uses cfg!(feature = "remote-control")');
    expect(result.stderr).toContain("#[cfg] removes code from the local build");
    expect(result.stderr).toContain("cfg! compiles both branches");
  });

  it("fails when the local package identity graph changes", () => {
    const root = makeFixture("pub fn marker() {}\n");
    const expected = join(root, "expected.txt");
    const actual = join(root, "actual.txt");
    const expectedEdges = join(root, "expected-edges.txt");
    const actualEdges = join(root, "actual-edges.txt");
    writeFileSync(expected, "path#aimux@0.1.0\n", "utf8");
    writeFileSync(
      actual,
      "path#aimux@0.1.0\nregistry+https://github.com/rust-lang/crates.io-index#sneaky-network-client@1.0.0\n",
      "utf8",
    );
    writeFileSync(expectedEdges, "tokio->registry+https://github.com/rust-lang/crates.io-index#tokio@1.53.1\n", "utf8");
    writeFileSync(actualEdges, "tokio->registry+https://github.com/rust-lang/crates.io-index#tokio@1.53.1\n", "utf8");

    const result = spawnSync(
      process.execPath,
      [
        script,
        "--source-root",
        root,
        "--package-identities-file",
        actual,
        "--expected-package-identities-file",
        expected,
        "--root-dependency-edges-file",
        actualEdges,
        "--expected-root-dependency-edges-file",
        expectedEdges,
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("dependency graph changed from the audited identities");
    expect(result.stderr).toContain("sneaky-network-client@1.0.0");
  });

  it("fails when an audited transitive package becomes directly usable by aimux source", () => {
    const root = makeFixture("pub fn marker() {}\n");
    const packages = join(root, "packages.txt");
    const expectedEdges = join(root, "expected-edges.txt");
    const actualEdges = join(root, "actual-edges.txt");
    writeFileSync(packages, "path#aimux@0.1.0\nregistry+https://github.com/rust-lang/crates.io-index#socket2@0.6.5\n", "utf8");
    writeFileSync(expectedEdges, "tokio->registry+https://github.com/rust-lang/crates.io-index#tokio@1.53.1\n", "utf8");
    writeFileSync(
      actualEdges,
      "socket2->registry+https://github.com/rust-lang/crates.io-index#socket2@0.6.5\ntokio->registry+https://github.com/rust-lang/crates.io-index#tokio@1.53.1\n",
      "utf8",
    );

    const result = spawnSync(
      process.execPath,
      [
        script,
        "--source-root",
        root,
        "--package-identities-file",
        packages,
        "--expected-package-identities-file",
        packages,
        "--root-dependency-edges-file",
        actualEdges,
        "--expected-root-dependency-edges-file",
        expectedEdges,
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("root dependency edge set changed from the audited identities");
    expect(result.stderr).toContain("socket2@0.6.5");
  });

  it("detects aliases of standard socket types", () => {
    const root = makeFixture(`
use std::net::TcpStream as Pipe;

pub fn leak() {
    let _ = Pipe::connect(("198.51.100.10", 443));
}
`);

    const result = runCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("non-loopback network target");
    expect(result.stderr).toContain("198.51.100.10");
  });
});
