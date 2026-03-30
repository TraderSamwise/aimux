import { describe, expect, it, vi } from "vitest";
import {
  ServerRuntimeManager,
  type ServerRuntimeClient,
  type ServerRuntimeEvent,
  type ServerSessionInfo,
} from "./server-runtime-manager.js";
import { SessionRuntime, type SessionTransport } from "./session-runtime.js";
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

function createRuntime(id: string): SessionRuntime {
  const transport = createTransport({ id, command: "codex", viewport: makeViewport("") });
  return new SessionRuntime(transport, new SessionOutputPipeline(new TerminalQueryResponder()), Date.now());
}

describe("ServerRuntimeManager", () => {
  it("does not connect when the server is unavailable", async () => {
    const createClient = vi.fn<() => ServerRuntimeClient>();
    const manager = new ServerRuntimeManager(createClient, () => false);

    await manager.connect();

    expect(createClient).not.toHaveBeenCalled();
    expect(manager.connected).toBe(false);
  });

  it("reconnects live sessions and hydrates them", async () => {
    const snapshot = {
      cols: 80,
      rows: 24,
      cursor: { row: 2, col: 3 },
      viewportY: 0,
      baseY: 0,
      startLine: 0,
      lines: [{ cells: [{ chars: "hello", width: 5 }], wrapped: false }],
    };
    const registerSession = vi.fn((_id: string, command: string) => {
      return {
        id: "srv-1",
        command,
        backendSessionId: undefined,
        resize: vi.fn(),
        _hydrateSnapshot: vi.fn().mockResolvedValue(undefined),
      } as any;
    });
    const listSessions = vi.fn<() => Promise<ServerSessionInfo[]>>().mockResolvedValue([
      { id: "srv-1", command: "codex", backendSessionId: "backend-1" },
      { id: "srv-exit", command: "claude", exited: true },
    ]);
    const requestScreen = vi.fn<() => Promise<typeof snapshot>>().mockResolvedValue(snapshot);

    const client: ServerRuntimeClient = {
      connected: true,
      connect: vi.fn(),
      onSessionUpdated: vi.fn(),
      listSessions,
      registerSession: registerSession as any,
      requestScreen: requestScreen as any,
      renameSession: vi.fn(),
      send: vi.fn(),
      disconnect: vi.fn(),
    };

    const onEvent = vi.fn<(event: ServerRuntimeEvent) => void>();
    const manager = new ServerRuntimeManager(
      () => client,
      () => true,
      { onEvent },
    );
    await manager.connect();

    const discovered: string[] = [];
    const runtimes = new Map<string, SessionRuntime>();

    await manager.reconnectExistingSessions(80, 24, {
      resolvePromptPatterns: () => undefined,
      onDiscovered: (info, session) => {
        discovered.push(info.id);
        expect(session.backendSessionId).toBe("backend-1");
        const runtime = createRuntime(info.id);
        runtimes.set(info.id, runtime);
        return runtime;
      },
    });

    await vi.waitFor(() => {
      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: "sessionHydrated", runtime: expect.objectContaining({ id: "srv-1" }) }),
      );
    });

    expect(discovered).toEqual(["srv-1"]);
    expect(manager.isServerSession("srv-1")).toBe(true);
    expect(manager.isHydrating("srv-1")).toBe(false);
    expect(manager.getRuntime("srv-1")).toBe(runtimes.get("srv-1"));
    expect(manager.getSessionIds()).toEqual(new Set(["srv-1"]));
    expect(manager.getBackendSessionIds()).toEqual(new Set(["backend-1"]));
    expect(runtimes.get("srv-1")?.isHydrating).toBe(false);
    expect(registerSession).toHaveBeenCalledTimes(1);
    expect(requestScreen).toHaveBeenCalledWith("srv-1");
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "sessionDiscovered", info: expect.objectContaining({ id: "srv-1" }) }),
    );
  });

  it("retries hydration after an empty snapshot by nudging resize", async () => {
    vi.useFakeTimers();
    const session = {
      id: "srv-2",
      command: "codex",
      backendSessionId: undefined,
      resize: vi.fn(),
      _hydrateSnapshot: vi.fn().mockResolvedValue(undefined),
    } as any;

    const requestScreen = vi
      .fn()
      .mockResolvedValueOnce({
        cols: 80,
        rows: 24,
        cursor: { row: 1, col: 1 },
        viewportY: 0,
        baseY: 0,
        startLine: 0,
        lines: [],
      })
      .mockResolvedValueOnce({
        cols: 80,
        rows: 24,
        cursor: { row: 2, col: 4 },
        viewportY: 0,
        baseY: 0,
        startLine: 0,
        lines: [{ cells: [{ chars: "ready", width: 5 }], wrapped: false }],
      });

    const client: ServerRuntimeClient = {
      connected: true,
      connect: vi.fn(),
      onSessionUpdated: vi.fn(),
      listSessions: vi.fn().mockResolvedValue([{ id: "srv-2", command: "codex" }]),
      registerSession: vi.fn().mockReturnValue(session),
      requestScreen: requestScreen as any,
      renameSession: vi.fn(),
      send: vi.fn(),
      disconnect: vi.fn(),
    };

    const manager = new ServerRuntimeManager(
      () => client,
      () => true,
    );
    await manager.connect();
    const runtime = createRuntime("srv-2");

    const reconnectPromise = manager.reconnectExistingSessions(80, 24, {
      resolvePromptPatterns: () => undefined,
      onDiscovered: () => runtime,
    });

    await vi.advanceTimersByTimeAsync(150);
    await reconnectPromise;

    expect(session.resize).toHaveBeenCalledWith(80, 24);
    expect(requestScreen).toHaveBeenCalledTimes(2);
    expect(session._hydrateSnapshot).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("owns fresh server-backed spawn registration and dispatch", async () => {
    const session = {
      id: "srv-3",
      command: "codex",
      backendSessionId: undefined,
      resize: vi.fn(),
      _hydrateSnapshot: vi.fn(),
    } as any;

    const send = vi.fn();
    const client: ServerRuntimeClient = {
      connected: true,
      connect: vi.fn(),
      onSessionUpdated: vi.fn(),
      listSessions: vi.fn(),
      registerSession: vi.fn().mockReturnValue(session),
      requestScreen: vi.fn(),
      renameSession: vi.fn(),
      send,
      disconnect: vi.fn(),
    };

    const manager = new ServerRuntimeManager(
      () => client,
      () => true,
    );
    await manager.connect();
    const created = manager.spawnSession({
      id: "srv-3",
      command: "codex",
      args: ["--full-auto"],
      toolConfigKey: "codex",
      backendSessionId: "backend-3",
      worktreePath: "/tmp/wt",
      cwd: "/tmp/wt",
      cols: 100,
      rows: 30,
      promptPatterns: [/foo/],
    });

    expect(created).toBe(session);
    expect(manager.isServerSession("srv-3")).toBe(true);
    expect(client.registerSession).toHaveBeenCalledWith("srv-3", "codex", 100, 30, [/foo/]);
    expect(send).toHaveBeenCalledWith({
      type: "spawn",
      id: "srv-3",
      command: "codex",
      args: ["--full-auto"],
      toolConfigKey: "codex",
      backendSessionId: "backend-3",
      worktreePath: "/tmp/wt",
      cwd: "/tmp/wt",
      cols: 100,
      rows: 30,
    });

    const runtime = createRuntime("srv-3");
    runtime.backendSessionId = "backend-3";
    manager.attachRuntime("srv-3", runtime);
    expect(manager.getRuntime("srv-3")).toBe(runtime);
    expect(manager.getSessionIds()).toEqual(new Set(["srv-3"]));
    expect(manager.getBackendSessionIds()).toEqual(new Set(["backend-3"]));
  });

  it("spawns and attaches managed runtimes in one flow", async () => {
    const session = {
      id: "srv-5",
      command: "codex",
      backendSessionId: undefined,
      resize: vi.fn(),
      _hydrateSnapshot: vi.fn(),
    } as any;

    const client: ServerRuntimeClient = {
      connected: true,
      connect: vi.fn(),
      onSessionUpdated: vi.fn(),
      listSessions: vi.fn(),
      registerSession: vi.fn().mockReturnValue(session),
      requestScreen: vi.fn(),
      renameSession: vi.fn(),
      send: vi.fn(),
      disconnect: vi.fn(),
    };

    const manager = new ServerRuntimeManager(
      () => client,
      () => true,
    );
    await manager.connect();

    const runtime = createRuntime("srv-5");
    runtime.backendSessionId = "backend-5";
    const created = manager.spawnManagedSession(
      {
        id: "srv-5",
        command: "codex",
        args: [],
        toolConfigKey: "codex",
        backendSessionId: "backend-5",
        cwd: "/tmp",
        cols: 80,
        rows: 24,
      },
      {
        onSpawned: () => runtime,
      },
    );

    expect(created).toBe(runtime);
    expect(manager.getRuntime("srv-5")).toBe(runtime);
    expect(manager.getBackendSessionIds()).toEqual(new Set(["backend-5"]));
  });

  it("provides persistence ownership helpers", async () => {
    const session = {
      id: "srv-4",
      command: "codex",
      backendSessionId: undefined,
      resize: vi.fn(),
      _hydrateSnapshot: vi.fn(),
    } as any;

    const client: ServerRuntimeClient = {
      connected: true,
      connect: vi.fn(),
      onSessionUpdated: vi.fn(),
      listSessions: vi.fn(),
      registerSession: vi.fn().mockReturnValue(session),
      requestScreen: vi.fn(),
      renameSession: vi.fn(),
      send: vi.fn(),
      disconnect: vi.fn(),
    };

    const manager = new ServerRuntimeManager(
      () => client,
      () => true,
    );
    await manager.connect();
    manager.spawnSession({
      id: "srv-4",
      command: "codex",
      args: [],
      toolConfigKey: "codex",
      backendSessionId: "backend-4",
      cwd: "/tmp",
      cols: 80,
      rows: 24,
    });

    const sessions = [
      { id: "srv-4", backendSessionId: "backend-4" },
      { id: "local-1", backendSessionId: "backend-local" },
      { id: "local-2" },
    ];

    expect(manager.getPersistableSessions(sessions)).toEqual([
      { id: "local-1", backendSessionId: "backend-local" },
      { id: "local-2" },
    ]);
    expect(manager.getDestroyableSessions(sessions)).toEqual([
      { id: "local-1", backendSessionId: "backend-local" },
      { id: "local-2" },
    ]);
    expect(manager.getOwnedBackendSessionIdsForSessions(sessions)).toEqual(new Set(["backend-4", "backend-local"]));
    expect(manager.canControlSession("srv-4")).toBe(true);
    expect(manager.canControlSession("local-1")).toBe(false);
  });
});
