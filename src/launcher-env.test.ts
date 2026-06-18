import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cliEntryFor, prepareDevCliEnv, prepareStableCliEnv } from "./launcher-env.js";

describe("launcher environment targeting", () => {
  it("normalizes stable aimux away from inherited dev defaults", () => {
    const env: Record<string, string | undefined> = {
      AIMUX_HOME: join(homedir(), ".aimux-dev"),
      AIMUX_DAEMON_PORT: "43191",
      AIMUX_ENV: "development",
      AIMUX_WEB_APP_URL: "http://localhost:8081",
      AIMUX_METADATA_ENDPOINT_FILE: "/tmp/dev-project/metadata-api.txt",
      AIMUX_SESSION_ID: "codex-dev",
      AIMUX_SHELL_INTEGRATION_SCRIPT: "/tmp/dev-shell.zsh",
      AIMUX_TOOL: "codex",
    };

    prepareStableCliEnv(env);

    expect(env).toMatchObject({
      AIMUX_HOME: join(homedir(), ".aimux"),
      AIMUX_DAEMON_PORT: "43190",
      AIMUX_ENV: "production",
      AIMUX_WEB_APP_URL: "https://aimux.app",
    });
    expect(env.AIMUX_METADATA_ENDPOINT_FILE).toBeUndefined();
    expect(env.AIMUX_SESSION_ID).toBeUndefined();
    expect(env.AIMUX_SHELL_INTEGRATION_SCRIPT).toBeUndefined();
    expect(env.AIMUX_TOOL).toBeUndefined();
  });

  it("normalizes aimux-dev away from inherited stable defaults", () => {
    const env: Record<string, string | undefined> = {
      AIMUX_HOME: join(homedir(), ".aimux"),
      AIMUX_DAEMON_PORT: "43190",
      AIMUX_ENV: "production",
      AIMUX_WEB_APP_URL: "https://aimux.app",
      AIMUX_SESSION_ID: "claude-prod",
    };

    prepareDevCliEnv(env);

    expect(env).toMatchObject({
      AIMUX_HOME: join(homedir(), ".aimux-dev"),
      AIMUX_DAEMON_PORT: "43191",
      AIMUX_ENV: "development",
      AIMUX_WEB_APP_URL: "http://localhost:8081",
    });
    expect(env.AIMUX_SESSION_ID).toBeUndefined();
  });

  it("preserves custom development lane targeting", () => {
    const env: Record<string, string | undefined> = {
      AIMUX_HOME: join(homedir(), ".aimux-dev-openrig-runtime-core"),
      AIMUX_DAEMON_PORT: "43192",
      AIMUX_ENV: "development",
      AIMUX_WEB_APP_URL: "http://localhost:8082",
      AIMUX_SESSION_ID: "codex-lane",
    };

    prepareDevCliEnv(env);

    expect(env).toMatchObject({
      AIMUX_HOME: join(homedir(), ".aimux-dev-openrig-runtime-core"),
      AIMUX_DAEMON_PORT: "43192",
      AIMUX_ENV: "development",
      AIMUX_WEB_APP_URL: "http://localhost:8082",
      AIMUX_SESSION_ID: "codex-lane",
    });
  });

  it("preserves explicit non-default stable targeting", () => {
    const env: Record<string, string | undefined> = {
      AIMUX_HOME: join(homedir(), ".aimux-preview"),
      AIMUX_DAEMON_PORT: "44190",
      AIMUX_ENV: "production",
      AIMUX_WEB_APP_URL: "https://preview.aimux.app",
    };

    prepareStableCliEnv(env);

    expect(env).toMatchObject({
      AIMUX_HOME: join(homedir(), ".aimux-preview"),
      AIMUX_DAEMON_PORT: "44190",
      AIMUX_ENV: "production",
      AIMUX_WEB_APP_URL: "https://preview.aimux.app",
    });
  });
});

describe("cliEntryFor", () => {
  it("routes the expose subcommand to the lightweight popup entry", () => {
    expect(cliEntryFor(["node", "/p/bin/aimux", "expose", "--project-root", "/p"])).toBe("expose");
  });

  it("routes everything else (and the bare invocation) to the full CLI", () => {
    expect(cliEntryFor(["node", "/p/bin/aimux", "spawn"])).toBe("main");
    expect(cliEntryFor(["node", "/p/bin/aimux", "--help"])).toBe("main");
    expect(cliEntryFor(["node", "/p/bin/aimux"])).toBe("main");
  });
});
