import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cliEntryFor, prepareStableCliEnv } from "./launcher-env.js";

describe("launcher environment targeting", () => {
  it("fills blank aimux defaults", () => {
    const env: Record<string, string | undefined> = {};

    prepareStableCliEnv(env);

    expect(env).toMatchObject({
      AIMUX_HOME: join(homedir(), ".aimux"),
      AIMUX_DAEMON_PORT: "43190",
      AIMUX_ENV: "production",
      AIMUX_WEB_APP_URL: "https://aimux.app",
    });
  });

  it("preserves explicit custom targeting", () => {
    const env: Record<string, string | undefined> = {
      AIMUX_HOME: join(homedir(), ".aimux-scratch"),
      AIMUX_DAEMON_PORT: "44190",
      AIMUX_ENV: "development",
      AIMUX_WEB_APP_URL: "http://localhost:8081",
      AIMUX_SESSION_ID: "codex-custom",
    };

    prepareStableCliEnv(env);

    expect(env).toMatchObject({
      AIMUX_HOME: join(homedir(), ".aimux-scratch"),
      AIMUX_DAEMON_PORT: "44190",
      AIMUX_ENV: "development",
      AIMUX_WEB_APP_URL: "http://localhost:8081",
      AIMUX_SESSION_ID: "codex-custom",
    });
  });
});

describe("cliEntryFor", () => {
  it("routes every invocation to the full CLI", () => {
    expect(cliEntryFor(["node", "/p/bin/aimux", "expose", "--project-root", "/p"])).toBe("main");
    expect(cliEntryFor(["node", "/p/bin/aimux", "spawn"])).toBe("main");
    expect(cliEntryFor(["node", "/p/bin/aimux", "--help"])).toBe("main");
    expect(cliEntryFor(["node", "/p/bin/aimux"])).toBe("main");
  });
});
