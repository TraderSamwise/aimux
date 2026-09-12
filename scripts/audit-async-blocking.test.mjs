import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const roots = [];

function runAudit(root) {
  return spawnSync("node", ["scripts/audit-async-blocking.mjs", relative(repoRoot, root)], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function writeFixture(source) {
  const root = mkdtempSync(join(tmpdir(), "aimux-async-blocking-audit-"));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "lib.rs"), source);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop(), { recursive: true, force: true });
  }
});

describe("async blocking audit", () => {
  it.each([
    ["std-process", "async fn f() { let _ = std::process::Command::new(\"true\").status(); }"],
    ["std-net", "async fn f() { let _ = std::net::TcpStream::connect(\"127.0.0.1:9\"); }"],
    ["thread-sleep", "async fn f() { std::thread::sleep(std::time::Duration::from_millis(1)); }"],
    [
      "blocking-recv",
      "async fn f(rx: std::sync::mpsc::Receiver<String>) { let _ = rx.recv(); }",
    ],
  ])("rejects %s inside async fn", (hazard, source) => {
    const result = runAudit(writeFixture(source));

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain(hazard);
    expect(result.stderr).toContain("src/lib.rs:1 f");
  });

  it("allows the same blocking spellings outside async fn", () => {
    const result = runAudit(
      writeFixture(`
fn f(rx: std::sync::mpsc::Receiver<String>) {
    let _ = std::process::Command::new("true").status();
    let _ = std::net::TcpStream::connect("127.0.0.1:9");
    std::thread::sleep(std::time::Duration::from_millis(1));
    let _ = rx.recv();
}
`),
    );

    expect(result.status, result.stderr).toBe(0);
  });
});
