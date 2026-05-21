import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { configureLogging, debug, log, resetLoggingForTests } from "./debug.js";

describe("debug logging", () => {
  let root = "";
  let logPath = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "aimux-debug-"));
    logPath = join(root, "logs", "aimux.jsonl");
    resetLoggingForTests();
  });

  afterEach(() => {
    resetLoggingForTests();
    rmSync(root, { recursive: true, force: true });
  });

  it("does not create a log file when disabled", () => {
    configureLogging({ enabled: false, path: logPath, level: "debug" });

    debug("hidden", "test");

    expect(existsSync(logPath)).toBe(false);
  });

  it("writes structured JSONL when enabled", () => {
    configureLogging({
      enabled: true,
      path: logPath,
      level: "debug",
      processKind: "test",
      projectId: "project-1",
      projectRoot: root,
    });

    debug("hello", "test");

    const records = readFileSync(logPath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      level: "debug",
      category: "test",
      message: "hello",
      processKind: "test",
      projectId: "project-1",
      projectRoot: root,
    });
    expect(typeof records[0].ts).toBe("string");
    expect(typeof records[0].pid).toBe("number");
  });

  it("filters by level and category", () => {
    configureLogging({ enabled: true, path: logPath, level: "info", categories: ["daemon"] });

    log.debug("debug hidden", "daemon");
    log.info("wrong category hidden", "session");
    log.warn("visible", "daemon");

    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!) as Record<string, unknown>).toMatchObject({
      level: "warn",
      category: "daemon",
      message: "visible",
    });
  });

  it("rotates log files when maxBytes is exceeded", () => {
    mkdirSync(join(root, "logs"), { recursive: true });
    writeFileSync(logPath, "existing\n");
    configureLogging({ enabled: true, path: logPath, level: "info", maxBytes: 10, maxFiles: 2 });

    log.info("after rotate", "test");

    expect(readFileSync(`${logPath}.1`, "utf-8")).toBe("existing\n");
    expect(readFileSync(logPath, "utf-8")).toContain("after rotate");
  });
});
