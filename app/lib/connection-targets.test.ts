import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ Platform: { OS: "web" } }));

import {
  resolveAppConnectionMode,
  resolveAppDaemonUrl,
  resolveAppRelayUrl,
} from "@/lib/connection-targets";

const ORIGINAL_ENV = {
  NODE_ENV: process.env.NODE_ENV,
  EXPO_PUBLIC_AIMUX_CONNECTION_MODE: process.env.EXPO_PUBLIC_AIMUX_CONNECTION_MODE,
  EXPO_PUBLIC_AIMUX_DAEMON_URL: process.env.EXPO_PUBLIC_AIMUX_DAEMON_URL,
  EXPO_PUBLIC_AIMUX_RELAY_URL: process.env.EXPO_PUBLIC_AIMUX_RELAY_URL,
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

function setEnv(key: string, value: string): void {
  (process.env as Record<string, string | undefined>)[key] = value;
}

describe("app connection targets", () => {
  afterEach(() => restoreEnv());

  it("defaults development builds to local daemon mode", () => {
    setEnv("NODE_ENV", "development");
    delete process.env.EXPO_PUBLIC_AIMUX_CONNECTION_MODE;
    delete process.env.EXPO_PUBLIC_AIMUX_DAEMON_URL;
    delete process.env.EXPO_PUBLIC_AIMUX_RELAY_URL;

    expect(resolveAppConnectionMode()).toBe("local");
    expect(resolveAppDaemonUrl()).toBe("http://localhost:43190");
    expect(resolveAppRelayUrl()).toBeUndefined();
  });

  it("defaults production builds to hosted relay mode", () => {
    setEnv("NODE_ENV", "production");
    delete process.env.EXPO_PUBLIC_AIMUX_CONNECTION_MODE;
    delete process.env.EXPO_PUBLIC_AIMUX_DAEMON_URL;
    delete process.env.EXPO_PUBLIC_AIMUX_RELAY_URL;

    expect(resolveAppConnectionMode()).toBe("relay");
    expect(resolveAppRelayUrl()).toBe("wss://relay.aimux.app");
    expect(resolveAppDaemonUrl()).toBeUndefined();
  });

  it("allows explicit local and relay target overrides", () => {
    setEnv("NODE_ENV", "development");
    process.env.EXPO_PUBLIC_AIMUX_CONNECTION_MODE = "relay";
    process.env.EXPO_PUBLIC_AIMUX_RELAY_URL = "wss://relay-preview.example.com/";
    expect(resolveAppConnectionMode()).toBe("relay");
    expect(resolveAppRelayUrl()).toBe("wss://relay-preview.example.com");

    process.env.EXPO_PUBLIC_AIMUX_CONNECTION_MODE = "local";
    process.env.EXPO_PUBLIC_AIMUX_DAEMON_URL = "http://localhost:43191/";
    expect(resolveAppConnectionMode()).toBe("local");
    expect(resolveAppDaemonUrl()).toBe("http://localhost:43191");
  });

  it("does not let URL overrides implicitly switch the build-mode default", () => {
    setEnv("NODE_ENV", "development");
    delete process.env.EXPO_PUBLIC_AIMUX_CONNECTION_MODE;
    process.env.EXPO_PUBLIC_AIMUX_RELAY_URL = "wss://relay-preview.example.com/";
    expect(resolveAppConnectionMode()).toBe("local");
    expect(resolveAppRelayUrl()).toBeUndefined();

    setEnv("NODE_ENV", "production");
    process.env.EXPO_PUBLIC_AIMUX_DAEMON_URL = "http://localhost:43191/";
    delete process.env.EXPO_PUBLIC_AIMUX_RELAY_URL;
    expect(resolveAppConnectionMode()).toBe("relay");
    expect(resolveAppDaemonUrl()).toBeUndefined();
  });

  it("rejects invalid explicit connection modes", () => {
    setEnv("EXPO_PUBLIC_AIMUX_CONNECTION_MODE", "remote");

    expect(() => resolveAppConnectionMode()).toThrow(/must be "local" or "relay"/);
  });
});
