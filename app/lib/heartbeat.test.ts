import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ Platform: { OS: "web" } }));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: {} }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "test" } } }));
vi.mock("expo-secure-store", () => ({}));

import { setApiRelay } from "./api";
import { startHeartbeat, type StreamEvent } from "./heartbeat";
import type { RelayTransport } from "./relay-transport";

describe("startHeartbeat relay transport", () => {
  afterEach(() => {
    setApiRelay(null);
  });

  it("dispatches relay project ready events through the heartbeat event path", () => {
    const stop = vi.fn();
    const ready = {
      projectId: "project-1",
      ts: "2026-06-20T00:00:00.000Z",
      sessionId: null,
      startLine: 0,
      intervalMs: 500,
    };
    const subscribeProjectEvents = vi.fn(
      (path, headers, onEvent: (event: string, data: unknown) => void) => {
        onEvent("ready", ready);
        return { stop };
      },
    );
    setApiRelay({ subscribeProjectEvents } as unknown as RelayTransport);
    const events: StreamEvent[] = [];

    const handle = startHeartbeat({
      serviceEndpoint: { host: "127.0.0.1", port: 43210 },
      sessionId: null,
      token: "token",
      onEvent: (event) => events.push(event),
    });

    expect(subscribeProjectEvents).toHaveBeenCalledWith(
      "/proxy/127.0.0.1/43210/events",
      { Authorization: "Bearer token" },
      expect.any(Function),
      expect.any(Function),
    );
    expect(events).toEqual([{ type: "ready", ...ready }]);

    handle.stop();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("subscribes to session live output over relay project events", () => {
    const output = {
      sessionId: "session/a b",
      output: "hello",
      startLine: -50,
      parsed: { blocks: [{ type: "message", text: "hello" }] },
    };
    const subscribeProjectEvents = vi.fn(
      (path, headers, onEvent: (event: string, data: unknown) => void) => {
        onEvent("agent_output", output);
        return { stop: vi.fn() };
      },
    );
    setApiRelay({ subscribeProjectEvents } as unknown as RelayTransport);
    const events: StreamEvent[] = [];

    startHeartbeat({
      serviceEndpoint: { host: "127.0.0.1", port: 43210 },
      sessionId: "session/a b",
      startLine: -50,
      intervalMs: 250,
      onEvent: (event) => events.push(event),
    });

    expect(subscribeProjectEvents).toHaveBeenCalledWith(
      "/proxy/127.0.0.1/43210/events?sessionId=session%2Fa+b&startLine=-50&intervalMs=250",
      {},
      expect.any(Function),
      expect.any(Function),
    );
    expect(events).toEqual([{ type: "agent_output", ...output }]);
  });
});
