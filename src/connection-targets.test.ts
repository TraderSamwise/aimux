import { afterEach, describe, expect, it } from "vitest";
import { resolveRelayUrl, resolveWebAppUrl } from "./connection-targets.js";

const ORIGINAL_ENV = {
  AIMUX_ENV: process.env.AIMUX_ENV,
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
