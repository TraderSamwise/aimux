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

  // The bare name belongs to whichever module imported it bare, and you
  // cannot import two types of the same name bare in one file. So when
  // `tokio::net::TcpListener` is the bare import, a bare `TcpListener::` is
  // tokio's, and std's has to be qualified or aliased -- which is exactly how
  // `local_ui_server.rs` is written: std's TcpStream aliased, tokio's bare,
  // `std::net::TcpListener::bind` fully qualified outside the async block, and
  // `TcpListener::from_std` bare inside it. The hazard fired on that file
  // because `use std::net::` appears SOMEWHERE in it, which is not evidence
  // about the spelling in the body.
  //
  // The fixture deliberately carries NO qualified `std::net::` path, not even
  // in a parameter type. My first version annotated the parameter and failed
  // for that reason instead of the one under test, which would have had me
  // "fixing" the wrong branch of the hazard.
  it("allows tokio's net types when tokio owns the bare name", () => {
    const result = runAudit(
      writeFixture(`
use std::net::TcpStream as StdTcpStream;
use tokio::net::{TcpListener, TcpStream};

async fn serve(listener: Listener) {
    let _ = TcpListener::from_std(listener);
    let _: Option<TcpStream> = None;
    let _: Option<StdTcpStream> = None;
}
`),
    );

    expect(result.status, result.stderr).toBe(0);
  });

  // And the hazard still has to fire when std owns the bare name, or the
  // tightening above has simply switched it off.
  it("still rejects std's net types when std owns the bare name", () => {
    const result = runAudit(
      writeFixture(`
use std::net::TcpStream;

async fn f() {
    let _ = TcpStream::connect("127.0.0.1:9");
}
`),
    );

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("std-net");
  });

  // The qualified spelling is unambiguous and must fire whatever the imports
  // say, including in a file that also imports tokio's.
  it("still rejects a fully qualified std::net path beside a tokio import", () => {
    const result = runAudit(
      writeFixture(`
use tokio::net::TcpStream;

async fn f() {
    let _ = std::net::TcpStream::connect("127.0.0.1:9");
    let _: Option<TcpStream> = None;
}
`),
    );

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("std-net");
  });

  // The case that makes the tokio-ownership check load-bearing, and the only
  // one that can: a type cannot be imported bare twice, so `fromStd` and
  // `fromTokio` can both hold a name only when std arrives by GLOB and tokio
  // names it explicitly -- where the explicit import shadows the glob, so the
  // bare name is tokio's.
  //
  // Added after a mutation: deleting the tokio check left the earlier
  // false-positive test passing, because std's type was aliased there and so
  // was absent from `fromStd` regardless. The check was unproven until this
  // fixture existed.
  it("lets an explicit tokio import shadow a std glob", () => {
    const result = runAudit(
      writeFixture(`
use std::net::*;
use tokio::net::TcpListener;

async fn serve(listener: Listener) {
    let _ = TcpListener::from_std(listener);
}
`),
    );

    expect(result.status, result.stderr).toBe(0);
  });

  // And the glob alone still fires, so the shadowing rule did not switch the
  // glob off.
  it("still rejects a bare std type arriving by glob", () => {
    const result = runAudit(
      writeFixture(`
use std::net::*;

async fn f() {
    let _ = TcpStream::connect("127.0.0.1:9");
}
`),
    );

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("std-net");
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
