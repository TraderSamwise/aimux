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
  it("routes sidecar-owned control-plane commands to the lean core CLI", () => {
    expect(cliEntryFor(["node", "/p/bin/aimux", "host", "status"])).toBe("core");
    expect(cliEntryFor(["node", "/p/bin/aimux", "daemon", "ensure"])).toBe("core");
    expect(cliEntryFor(["node", "/p/bin/aimux", "daemon", "status", "--json"])).toBe("core");
    expect(cliEntryFor(["node", "/p/bin/aimux", "daemon", "projects"])).toBe("core");
    expect(cliEntryFor(["node", "/p/bin/aimux", "daemon", "project-ensure", "--project", "/p"])).toBe("core");
    expect(cliEntryFor(["node", "/p/bin/aimux", "projects", "list"])).toBe("core");
    expect(cliEntryFor(["node", "/p/bin/aimux", "remote", "status"])).toBe("core");
    expect(cliEntryFor(["/Users/sam/.nvm/versions/node/v24.16.0/bin/node", "/p/bin/aimux", "remote", "status"])).toBe(
      "core",
    );
    expect(cliEntryFor(["node", "/p/bin/aimux", "remote", "enable"])).toBe("core");
    expect(cliEntryFor(["node", "/p/bin/aimux", "remote", "disable"])).toBe("core");
    expect(cliEntryFor(["node", "/p/bin/aimux", "--debug", "remote", "status"])).toBe("core");
    expect(cliEntryFor(["node", "/p/bin/aimux", "remote", "enable", "--debug"])).toBe("core");
    expect(cliEntryFor(["node", "/p/bin/aimux", "daemon", "project-ensure", "--project", "/p", "--trace"])).toBe(
      "core",
    );
    expect(
      cliEntryFor(["node", "/p/bin/aimux", "daemon", "project-ensure", "--log-level", "debug", "--project", "/p"]),
    ).toBe("core");
  });

  it("keeps runtime and help commands on the full CLI", () => {
    expect(cliEntryFor(["node", "/p/bin/aimux", "remote", "enable", "--help"])).toBe("main");
    expect(cliEntryFor(["node", "/p/bin/aimux", "remote", "enable", "--json"])).toBe("main");
    expect(cliEntryFor(["node", "/p/bin/aimux", "remote", "disable", "--dry-run"])).toBe("main");
    expect(cliEntryFor(["node", "/p/bin/aimux", "remote", "enable", "extra"])).toBe("main");
    expect(cliEntryFor(["node", "/p/bin/aimux", "daemon", "status", "extra"])).toBe("main");
    expect(cliEntryFor(["node", "/p/bin/aimux", "projects", "list", "extra", "--json"])).toBe("main");
    expect(cliEntryFor(["node", "/p/bin/aimux", "remote", "enable", "extra", "--debug"])).toBe("main");
    expect(cliEntryFor(["node", "/p/bin/aimux", "daemon", "project-ensure", "-h"])).toBe("main");
    expect(cliEntryFor(["node", "/p/bin/aimux", "expose", "--project-root", "/p"])).toBe("main");
    expect(cliEntryFor(["node", "/p/bin/aimux", "spawn"])).toBe("main");
    expect(cliEntryFor(["node", "/p/bin/aimux", "daemon", "restart"])).toBe("main");
    expect(cliEntryFor(["node", "/p/bin/aimux", "host", "agent-stream", "claude-1"])).toBe("main");
    expect(cliEntryFor(["node", "/p/bin/aimux", "remote", "unlock"])).toBe("main");
    expect(cliEntryFor(["node", "/p/bin/aimux", "--help"])).toBe("main");
    expect(cliEntryFor(["node", "/p/bin/aimux"])).toBe("main");
  });

  it("routes malformed project-ensure to core so it cannot mutate through Commander parsing", () => {
    expect(cliEntryFor(["node", "/p/bin/aimux", "daemon", "project-ensure", "--project", "--json"])).toBe("core");
    expect(cliEntryFor(["node", "/p/bin/aimux", "daemon", "project-ensure", "--dry-run"])).toBe("core");
  });
});
