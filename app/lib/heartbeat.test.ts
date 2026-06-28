import { afterEach, describe, expect, it, vi } from "vitest";

const eventSourceMock = vi.hoisted(() => {
  class MockEventSource {
    static instances: MockEventSource[] = [];

    listeners = new Map<string, Array<(ev: MessageEvent) => void>>();
    onerror: ((event: Event) => void) | null = null;
    closed = false;

    constructor(
      readonly url: string,
      readonly options?: unknown,
    ) {
      MockEventSource.instances.push(this);
    }

    addEventListener(name: string, handler: (ev: MessageEvent) => void) {
      const listeners = this.listeners.get(name) ?? [];
      listeners.push(handler);
      this.listeners.set(name, listeners);
    }

    emit(name: string, data: unknown) {
      const event = { data } as MessageEvent;
      for (const listener of this.listeners.get(name) ?? []) {
        listener(event);
      }
    }

    close() {
      this.closed = true;
    }
  }

  return {
    EventSourcePolyfill: vi.fn(function EventSourcePolyfill(url: string, options?: unknown) {
      return new MockEventSource(url, options);
    }),
    MockEventSource,
  };
});

vi.mock("react-native", () => ({ Platform: { OS: "web" } }));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: {} }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "test" } } }));
vi.mock("expo-secure-store", () => ({}));
vi.mock("event-source-polyfill", () => ({
  EventSourcePolyfill: eventSourceMock.EventSourcePolyfill,
}));

import { setApiRelay } from "./api";
import { startHeartbeat, type StreamEvent } from "./heartbeat";
import type { RelayTransport } from "./relay-transport";

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");

function restoreWindow() {
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, "window", originalWindowDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, "window");
  }
}

describe("startHeartbeat relay transport", () => {
  afterEach(() => {
    setApiRelay(null);
    eventSourceMock.EventSourcePolyfill.mockClear();
    eventSourceMock.MockEventSource.instances.length = 0;
    restoreWindow();
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

describe("startHeartbeat local transport", () => {
  afterEach(() => {
    setApiRelay(null);
    eventSourceMock.EventSourcePolyfill.mockClear();
    eventSourceMock.MockEventSource.instances.length = 0;
    restoreWindow();
  });

  it("ignores empty local SSE payloads during reconnect churn", () => {
    const events: StreamEvent[] = [];
    const onError = vi.fn();

    startHeartbeat({
      serviceEndpoint: { host: "10.0.0.5", port: 43210 },
      sessionId: null,
      onEvent: (event) => events.push(event),
      onError,
    });

    const source = eventSourceMock.MockEventSource.instances[0];
    source.emit("ready", undefined);
    source.emit("ready", "");
    source.emit("ready", "   ");
    source.emit("ready", JSON.stringify({ projectId: "project-1" }));

    expect(onError).not.toHaveBeenCalled();
    expect(events).toEqual([{ type: "ready", projectId: "project-1" }]);
  });

  it("uses native browser EventSource for loopback project-service streams", () => {
    class NativeEventSourceMock {
      static instances: NativeEventSourceMock[] = [];

      listeners = new Map<string, Array<(ev: MessageEvent) => void>>();
      onerror: ((event: Event) => void) | null = null;

      constructor(readonly url: string) {
        NativeEventSourceMock.instances.push(this);
      }

      addEventListener(name: string, handler: (ev: MessageEvent) => void) {
        const listeners = this.listeners.get(name) ?? [];
        listeners.push(handler);
        this.listeners.set(name, listeners);
      }

      emit(name: string, data: unknown) {
        const event = { data } as MessageEvent;
        for (const listener of this.listeners.get(name) ?? []) {
          listener(event);
        }
      }

      close() {}
    }

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { EventSource: NativeEventSourceMock },
    });
    const events: StreamEvent[] = [];

    startHeartbeat({
      serviceEndpoint: { host: "127.0.0.1", port: 43210 },
      sessionId: null,
      onEvent: (event) => events.push(event),
    });

    expect(eventSourceMock.EventSourcePolyfill).not.toHaveBeenCalled();
    expect(NativeEventSourceMock.instances).toHaveLength(1);
    NativeEventSourceMock.instances[0].emit("ready", JSON.stringify({ projectId: "project-1" }));
    expect(events).toEqual([{ type: "ready", projectId: "project-1" }]);
  });
});
