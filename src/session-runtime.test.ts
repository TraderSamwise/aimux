import { describe, expect, it, vi } from "vitest";
import { SessionRuntime, type SessionRuntimeEvent, type SessionTransport } from "./session-runtime.js";
import { SessionOutputPipeline } from "./session-output-pipeline.js";
import { TerminalQueryResponder } from "./terminal-query-responder.js";
import type { SessionTerminalViewport } from "./session-terminal-state.js";

function makeViewport(text: string): SessionTerminalViewport {
  return {
    rows: 4,
    cols: 20,
    cursor: { row: 1, col: 1 },
    visibleLines: [
      {
        cells: [{ chars: text, width: text.length }],
        wrapped: false,
      },
    ],
  };
}

function createTransport(
  overrides: Partial<SessionTransport> & { viewport?: SessionTerminalViewport } = {},
): SessionTransport {
  let onData: ((data: string) => void) | null = null;
  let onExit: ((code: number) => void) | null = null;
  const viewport = overrides.viewport ?? makeViewport("");
  return {
    id: overrides.id ?? "s1",
    command: overrides.command ?? "codex",
    backendSessionId: overrides.backendSessionId,
    exited: overrides.exited ?? false,
    exitCode: overrides.exitCode,
    status: overrides.status ?? "idle",
    write: overrides.write ?? vi.fn(),
    resize: overrides.resize ?? vi.fn(),
    getCursorPosition: overrides.getCursorPosition ?? (() => ({ row: 1, col: 1 })),
    getViewportFrame: overrides.getViewportFrame ?? (() => viewport),
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
  it("reports startup loading while the viewport is still blank", () => {
    const transport = createTransport({ viewport: makeViewport("   ") });
    const runtime = new SessionRuntime(transport, new SessionOutputPipeline(new TerminalQueryResponder()), Date.now());
    expect(runtime.shouldRenderStartupLoading()).toBe(true);
  });

  it("stops reporting startup loading once visible content exists", () => {
    const transport = createTransport({ viewport: makeViewport("OpenAI Codex") });
    const runtime = new SessionRuntime(transport, new SessionOutputPipeline(new TerminalQueryResponder()), Date.now());
    expect(runtime.shouldRenderStartupLoading()).toBe(false);
  });

  it("settles focused resize through a deferred render request", async () => {
    vi.useFakeTimers();
    const onEvent = vi.fn<(event: SessionRuntimeEvent) => void>();
    const transport = createTransport();
    const runtime = new SessionRuntime(transport, new SessionOutputPipeline(new TerminalQueryResponder()), Date.now(), {
      onEvent,
    });

    runtime.handleFocusedResize(() => true);
    expect(onEvent).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(24);
    expect(onEvent).toHaveBeenCalledWith({ type: "renderRequested", forceFooter: true });
    vi.useRealTimers();
  });

  it("wakes codex on focus and schedules repaints", async () => {
    vi.useFakeTimers();
    const onEvent = vi.fn<(event: SessionRuntimeEvent) => void>();
    const resize = vi.fn();
    const transport = createTransport({ command: "codex", resize });
    const runtime = new SessionRuntime(transport, new SessionOutputPipeline(new TerminalQueryResponder()), Date.now(), {
      onEvent,
    });

    runtime.handleFocusIn(120, 40, () => true);
    expect(onEvent).toHaveBeenCalledWith({ type: "renderRequested", forceFooter: true });
    expect(onEvent).toHaveBeenCalledWith({ type: "repaintRequested", delayMs: 32 });
    expect(onEvent).toHaveBeenCalledWith({ type: "repaintRequested", delayMs: 96 });
    expect(resize).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(32);
    expect(resize).toHaveBeenCalledWith(120, 40);
    vi.useRealTimers();
  });
});
