import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isDevelopmentRuntime, resolveRelayUrl, resolveWebAppUrl } from "./connection-targets.js";

const ORIGINAL_ENV = {
  AIMUX_ENV: process.env.AIMUX_ENV,
  AIMUX_HOME: process.env.AIMUX_HOME,
  AIMUX_DAEMON_PORT: process.env.AIMUX_DAEMON_PORT,
  AIMUX_WEB_APP_URL: process.env.AIMUX_WEB_APP_URL,
  AIMUX_RELAY_URL: process.env.AIMUX_RELAY_URL,
};

function restoreEnv(): void {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe("connection target defaults", () => {
  afterEach(() => restoreEnv());

  it("defaults production CLI login to the hosted app and relay", () => {
    delete process.env.AIMUX_ENV;
    delete process.env.AIMUX_WEB_APP_URL;
    delete process.env.AIMUX_RELAY_URL;

    expect(resolveWebAppUrl()).toBe("https://aimux.app");
    expect(resolveRelayUrl()).toBe("wss://relay.aimux.app");
  });

  it("defaults development CLI login to local web while keeping the production relay", () => {
    process.env.AIMUX_ENV = "development";
    delete process.env.AIMUX_WEB_APP_URL;
    delete process.env.AIMUX_RELAY_URL;

    expect(resolveWebAppUrl()).toBe("http://localhost:8081");
    expect(resolveRelayUrl()).toBe("wss://relay.aimux.app");
  });

  it("allows explicit web app and relay overrides", () => {
    process.env.AIMUX_ENV = "development";
    process.env.AIMUX_WEB_APP_URL = "https://preview.example.com/";
    process.env.AIMUX_RELAY_URL = "wss://relay-preview.example.com/";

    expect(resolveWebAppUrl()).toBe("https://preview.example.com");
    expect(resolveRelayUrl()).toBe("wss://relay-preview.example.com");
  });

  it("ignores blank CLI target overrides", () => {
    process.env.AIMUX_ENV = "development";
    process.env.AIMUX_WEB_APP_URL = "   ";
    process.env.AIMUX_RELAY_URL = "";

    expect(resolveWebAppUrl()).toBe("http://localhost:8081");
    expect(resolveRelayUrl()).toBe("wss://relay.aimux.app");
  });
});

describe("isDevelopmentRuntime lane detection", () => {
  afterEach(() => restoreEnv());

  function clearLaneEnv(): void {
    delete process.env.AIMUX_ENV;
    delete process.env.AIMUX_HOME;
    delete process.env.AIMUX_DAEMON_PORT;
    delete process.env.AIMUX_WEB_APP_URL;
  }

  it("is false with no lane signals (production default)", () => {
    clearLaneEnv();
    expect(isDevelopmentRuntime()).toBe(false);
  });

  it("detects dev from AIMUX_ENV", () => {
    clearLaneEnv();
    process.env.AIMUX_ENV = "development";
    expect(isDevelopmentRuntime()).toBe(true);
  });

  it("detects dev from the dev home even if AIMUX_ENV is unset", () => {
    clearLaneEnv();
    process.env.AIMUX_HOME = join(homedir(), ".aimux-dev");
    expect(isDevelopmentRuntime()).toBe(true);
  });

  it("detects dev from a tilde-prefixed home path", () => {
    clearLaneEnv();
    process.env.AIMUX_HOME = "~/.aimux-dev";
    expect(isDevelopmentRuntime()).toBe(true);
  });

  it("detects dev from the dev daemon port", () => {
    clearLaneEnv();
    process.env.AIMUX_DAEMON_PORT = "43191";
    expect(isDevelopmentRuntime()).toBe(true);
  });

  it("detects dev from the local web app url", () => {
    clearLaneEnv();
    process.env.AIMUX_WEB_APP_URL = "http://localhost:8081";
    expect(isDevelopmentRuntime()).toBe(true);
  });

  it("treats the prod home as production", () => {
    clearLaneEnv();
    process.env.AIMUX_HOME = join(homedir(), ".aimux");
    expect(isDevelopmentRuntime()).toBe(false);
  });
});
