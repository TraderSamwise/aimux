import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeFileSync } from "node:fs";

import { atomicWrite, quarantineCorruptFile, writeJsonAtomic, writeTextAtomic } from "./atomic-write.js";

describe("atomicWrite", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aimux-atomic-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes content and leaves no temp files behind", () => {
    const target = join(dir, "nested", "file.txt");
    atomicWrite(target, "hello");
    expect(readFileSync(target, "utf8")).toBe("hello");
    expect(readdirSync(join(dir, "nested")).filter((n) => n.includes(".tmp"))).toEqual([]);
  });

  it("writeJsonAtomic round-trips with a trailing newline", () => {
    const target = join(dir, "state.json");
    writeJsonAtomic(target, { a: 1, b: ["x"] });
    const raw = readFileSync(target, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(JSON.parse(raw)).toEqual({ a: 1, b: ["x"] });
  });

  it("writeTextAtomic writes bytes verbatim without appending a newline", () => {
    const target = join(dir, "endpoint.txt");
    writeTextAtomic(target, "http://127.0.0.1:43190\n");
    expect(readFileSync(target, "utf8")).toBe("http://127.0.0.1:43190\n");
  });

  it("honors an explicit file mode", () => {
    const target = join(dir, "auth.json");
    atomicWrite(target, "{}", { mode: 0o600 });
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it("overwrites an existing file atomically", () => {
    const target = join(dir, "f.json");
    writeJsonAtomic(target, { v: 1 });
    writeJsonAtomic(target, { v: 2 });
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ v: 2 });
    expect(existsSync(target)).toBe(true);
  });

  it("uses a unique temp path, not a shared <file>.tmp (race-safe)", () => {
    const statusDir = join(dir, "statusline");
    mkdirSync(statusDir, { recursive: true });
    const target = join(statusDir, "bottom-dashboard.txt");
    // Occupy the shared "<file>.tmp" path a racy writer would reuse. A fixed-".tmp"
    // implementation would fail here (EISDIR / collision); the unique-temp writer
    // must not, and must leave a valid result with no leftover temp files.
    mkdirSync(`${target}.tmp`, { recursive: true });
    expect(() => writeTextAtomic(target, "ok\n")).not.toThrow();
    expect(readFileSync(target, "utf8")).toBe("ok\n");
    expect(readdirSync(statusDir).filter((n) => n.endsWith(".tmp") && statSync(join(statusDir, n)).isFile())).toEqual(
      [],
    );
  });

  it("quarantines a corrupt file aside instead of dropping it", () => {
    const target = join(dir, "state.json");
    writeFileSync(target, "{ not valid json");
    const dest = quarantineCorruptFile(target);
    expect(dest).toBeTruthy();
    expect(existsSync(target)).toBe(false);
    expect(readFileSync(dest!, "utf8")).toBe("{ not valid json");
    expect(readdirSync(dir).some((n) => n.includes(".corrupt-"))).toBe(true);
  });

  it("quarantine is a no-op for a missing file", () => {
    expect(quarantineCorruptFile(join(dir, "nope.json"))).toBeNull();
  });
});
