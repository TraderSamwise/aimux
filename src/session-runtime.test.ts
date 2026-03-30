import { describe, expect, it, vi } from "vitest";
import { SessionRuntime, type SessionRuntimeEvent, type SessionTransport } from "./session-runtime.js";

function createTransport(overrides: Partial<SessionTransport> = {}): SessionTransport {
  let onData: ((data: string) => void) | null = null;
  let onExit: ((code: number) => void) | null = null;
  return {
    id: overrides.id ?? "s1",
    command: overrides.command ?? "codex",
    backendSessionId: overrides.backendSessionId,
    exited: overrides.exited ?? false,
    exitCode: overrides.exitCode,
    status: overrides.status ?? "idle",
    write: overrides.write ?? vi.fn(),
    resize: overrides.resize ?? vi.fn(),
    hasVisibleContent: overrides.hasVisibleContent ?? (() => true),
    onData: (cb) => {
      onData = cb;
    },
    onExit: (cb) => {
      onExit = cb;
    },
    kill: overrides.kill ?? vi.fn(),
    destroy: overrides.destroy ?? vi.fn(),
    ...overrides,
    emitData(data: string) {
      onData?.(data);
    },
    emitExit(code: number) {
      onExit?.(code);
    },
  } as SessionTransport & { emitData: (data: string) => void; emitExit: (code: number) => void };
}

describe("SessionRuntime", () => {
  it("emits output events from the transport", () => {
    const onEvent = vi.fn<(event: SessionRuntimeEvent) => void>();
    const transport = createTransport();
    const runtime = new SessionRuntime(transport, Date.now(), { onEvent });

    void runtime;
    transport.emitData("hello");
    expect(onEvent).toHaveBeenCalledWith({ type: "output", data: "hello" });
  });

  it("emits exit events from the transport", () => {
    const onEvent = vi.fn<(event: SessionRuntimeEvent) => void>();
    const transport = createTransport() as SessionTransport & { emitExit: (code: number) => void };
    const runtime = new SessionRuntime(transport, Date.now(), { onEvent });

    void runtime;
    transport.emitExit(7);
    expect(onEvent).toHaveBeenCalledWith({ type: "exit", code: 7 });
  });
});
