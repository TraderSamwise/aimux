import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { configureLogging, debug, log, resetLoggingForTests, resolveLoggingRuntimeConfig } from "./debug.js";

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

  it("redacts secret-like env assignments and fields", () => {
    configureLogging({ enabled: true, path: logPath, level: "debug", processKind: "test" });

    log.debug(
      'spawn args: ["AWS_SECRET_ACCESS_KEY=real-secret","PATH=/usr/bin","OPENAI_API_KEY=real-key","SENTRY_AUTH_TOKEN=\\"quoted-secret\\""]',
      "session",
      {
        token: "real-token",
        apiKey: "real-api-key",
        authToken: "real-auth-token",
        authorization: "real-authorization",
        nested: { password: "real-password", privateKey: "real-private-key", command: "SENTRY_AUTH_TOKEN=real-auth" },
      },
    );

    const record = JSON.parse(readFileSync(logPath, "utf-8").trim()) as Record<string, any>;
    expect(record.message).toContain("AWS_SECRET_ACCESS_KEY=<redacted>");
    expect(record.message).toContain("OPENAI_API_KEY=<redacted>");
    expect(record.message).toContain("PATH=/usr/bin");
    expect(record.message).not.toContain("real-secret");
    expect(record.message).not.toContain("real-key");
    expect(record.message).not.toContain("quoted-secret");
    expect(record.fields.token).toBe("<redacted>");
    expect(record.fields.apiKey).toBe("<redacted>");
    expect(record.fields.authToken).toBe("<redacted>");
    expect(record.fields.authorization).toBe("<redacted>");
    expect(record.fields.nested.password).toBe("<redacted>");
    expect(record.fields.nested.privateKey).toBe("<redacted>");
    expect(record.fields.nested.command).toBe("SENTRY_AUTH_TOKEN=<redacted>");
  });

  it("preserves toJSON field values while sanitizing fields", () => {
    configureLogging({ enabled: true, path: logPath, level: "debug", processKind: "test" });

    log.debug("dated", "session", {
      at: new Date("2026-05-23T01:02:03.000Z"),
      custom: {
        toJSON: () => ({ apiKey: "real-key", label: "ok" }),
      },
    });

    const record = JSON.parse(readFileSync(logPath, "utf-8").trim()) as Record<string, any>;
    expect(record.fields.at).toBe("2026-05-23T01:02:03.000Z");
    expect(record.fields.custom).toEqual({ apiKey: "<redacted>", label: "ok" });
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

  it("resolves logging config with env and cli precedence", () => {
    const resolved = resolveLoggingRuntimeConfig({
      config: {
        enabled: false,
        level: "info",
        categories: ["session"],
        maxBytes: 123,
        maxFiles: 2,
      },
      env: {
        AIMUX_LOG: "1",
        AIMUX_LOG_LEVEL: "debug",
        AIMUX_LOG_CATEGORIES: "daemon,tmux",
      },
      cli: {
        trace: true,
        logCategory: "http",
      },
      path: logPath,
      processKind: "test",
      projectId: "project-1",
      projectRoot: root,
    });

    expect(resolved).toEqual({
      enabled: true,
      level: "trace",
      categories: ["http"],
      maxBytes: 123,
      maxFiles: 2,
      path: logPath,
      processKind: "test",
      projectId: "project-1",
      projectRoot: root,
    });
  });
});
