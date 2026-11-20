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

  // The shape the extractor could not see, and the one the scheduler is built
  // from: `PeriodicTask::run` is a PLAIN fn returning `Box::pin(async move
  // { .. })`, because the trait returns a boxed future. 73 bodies in the crate
  // look like this and no hazard had ever been applied to any of them.
  it("rejects a blocking spelling inside Box::pin(async move)", () => {
    const result = runAudit(
      writeFixture(`
fn run() -> Pin<Box<dyn Future<Output = ()>>> {
    Box::pin(async move {
        std::thread::sleep(std::time::Duration::from_millis(1));
    })
}
`),
    );

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("thread-sleep");
    // Named after the function it sits in, because "async block at line N" is
    // a worse thing to read in a failure.
    expect(result.stderr).toContain("run");
  });

  // A bare async block in a plain fn counts too, which is how the relay nests
  // its request futures.
  it("rejects a blocking spelling inside a bare async block", () => {
    const result = runAudit(
      writeFixture(`
fn drive() {
    let work = async {
        std::thread::sleep(std::time::Duration::from_millis(1));
    };
    let _ = work;
}
`),
    );

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("thread-sleep");
  });

  // The exemption, using a marker of its own, because the seams marker
  // accounts for a block_on call and means something different. Some blocking is the fixture: a test task that
  // sleeps to occupy a worker past its interval is how the scheduler's overrun
  // handling gets something to handle, and tokio::time::sleep would yield
  // instead and measure nothing.
  it("allows a blocking spelling a seam marker accounts for", () => {
    const result = runAudit(
      writeFixture(`
fn run() -> Pin<Box<dyn Future<Output = ()>>> {
    // aimux-async-blocking: test - the sleep is the fixture, occupying a worker
    // past its interval so overrun handling has something to handle
    Box::pin(async move {
        std::thread::sleep(std::time::Duration::from_millis(1));
    })
}
`),
    );

    expect(result.status, result.stderr).toBe(0);
  });

  // And a marker has to SAY something. A bare mention is not an exemption, or
  // the escape hatch is just the word.
  it("does not treat an unclassified marker as an exemption", () => {
    const result = runAudit(
      writeFixture(`
fn run() -> Pin<Box<dyn Future<Output = ()>>> {
    // aimux-async-blocking: because
    Box::pin(async move {
        std::thread::sleep(std::time::Duration::from_millis(1));
    })
}
`),
    );

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("thread-sleep");
  });

  // An async fn body is collected once, not twice: it is both an `async fn`
  // and an async-delimited body, and reporting it twice would double every
  // existing finding.
  it("reports an async fn body once", () => {
    const result = runAudit(
      writeFixture("async fn f() { std::thread::sleep(std::time::Duration::from_millis(1)); }"),
    );

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr.match(/thread-sleep/g)).toHaveLength(1);
  });

  // A DELEGATING wrapper holds no fs:: call of its own, so the derivation
  // cannot see it and it has to be named. This is the coverage the hand list
  // had and the first derivation dropped.
  it("rejects a delegating state reader the derivation cannot see", () => {
    const result = runAudit(
      writeFixture(`
fn load_metadata_state(dir: &Path) -> State {
    load_metadata_state_at_unix_millis(dir, now())
}

async fn f() {
    let _ = load_metadata_state(dir);
}
`),
    );

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("sync-fs");
  });

  // The point of deriving: a wrapper NO list contains is still caught, because
  // the fixture's own file defines it as a sync reader.
  it("rejects a derived sync reader that no list names", () => {
    const result = runAudit(
      writeFixture(`
fn load_a_name_no_list_contains(path: &Path) -> String {
    fs::read_to_string(path).unwrap_or_default()
}

async fn f() {
    let _ = load_a_name_no_list_contains(path);
}
`),
    );

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("sync-fs");
  });

  // Attribution rule one: two sync definitions means the scan cannot know
  // which one a call reaches, so it must not claim it.
  it("does not claim a reader name that has two sync definitions", () => {
    const result = runAudit(
      writeFixture(`
mod first {
    fn ambiguous(path: &Path) -> String {
        fs::read_to_string(path).unwrap_or_default()
    }
}

mod second {
    fn ambiguous(path: &Path) -> String {
        fs::read_to_string(path).unwrap_or_default()
    }
}

async fn f() {
    let _ = ambiguous(path);
}
`),
    );

    expect(result.status, result.stderr).toBe(0);
  });

  // Attribution rule two: an async sibling under the same name. This crate
  // pairs them everywhere, and the async body is calling the sibling.
  it("does not claim a reader name that has an async sibling", () => {
    const result = runAudit(
      writeFixture(`
fn paired(path: &Path) -> String {
    fs::read_to_string(path).unwrap_or_default()
}

async fn paired(path: &Path) -> String {
    String::new()
}

async fn f() {
    let _ = paired(path).await;
}
`),
    );

    expect(result.status, result.stderr).toBe(0);
  });

  // A METHOD call is not a free function call. Without this the gate matches
  // `.store(true, Ordering::SeqCst)` against a module function called `store`,
  // and atomics are everywhere in async bodies.
  it("does not claim a method call that shares a reader's name", () => {
    const result = runAudit(
      writeFixture(`
fn store(path: &Path) -> String {
    fs::read_to_string(path).unwrap_or_default()
}

async fn f() {
    reported.store(true, Ordering::SeqCst);
}
`),
    );

    expect(result.status, result.stderr).toBe(0);
  });

  // The hazard the whole blocking-read cleanup was about.
  it("rejects a direct synchronous read inside an async fn", () => {
    const result = runAudit(
      writeFixture('async fn f() { let _ = fs::read_to_string("/tmp/x"); }'),
    );

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("sync-fs");
  });

  // The half that matters more, and the half a direct-call pattern misses:
  // every one of the twelve production sites went through a wrapper like this,
  // so a hazard without the named list would have caught none of them.
  it("rejects a state-file wrapper inside an async fn", () => {
    const result = runAudit(
      writeFixture(`
fn read_runtime_topology(path: &Path) -> Value {
    fs::read_to_string(path).map(parse).unwrap_or_default()
}

async fn f() {
    let _ = read_runtime_topology(path);
}
`),
    );

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("sync-fs");
  });

  // And inside Box::pin, which is where every PeriodicTask::run lives.
  it("rejects a state-file wrapper inside Box::pin(async move)", () => {
    const result = runAudit(
      writeFixture(`
fn try_load_metadata_state(dir: &Path) -> State {
    fs::read_to_string(dir).map(parse).unwrap_or_default()
}

fn periodic() -> Pin<Box<dyn Future<Output = ()>>> {
    Box::pin(async move {
        let _ = try_load_metadata_state(dir);
    })
}
`),
    );

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("sync-fs");
  });

  // Work already on the pool is the FIX, not the hazard. Without this the
  // audit flags the very helpers that exist to hop these reads.
  it("allows a state-file read inside spawn_blocking_named", () => {
    const result = runAudit(
      writeFixture(`
async fn f() {
    let _ = spawn_blocking_named(
        task_name("project-service", "scan"),
        move || read_runtime_topology(path),
    )
    .await;
}
`),
    );

    expect(result.status, result.stderr).toBe(0);
  });

  // A sync fn reading synchronously is not the hazard at all.
  it("allows a state-file read in a plain fn", () => {
    const result = runAudit(
      writeFixture("fn f() { let _ = read_runtime_topology(path); }"),
    );

    expect(result.status, result.stderr).toBe(0);
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
