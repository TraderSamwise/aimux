import { describe, expect, it, vi } from "vitest";

import { openManagedSessionWindow, openManagedServiceWindow } from "./window-open.js";

describe("managed window open", () => {
  function host(overrides: any = {}) {
    const agentTarget = {
      sessionName: "project-client-1",
      windowId: "@agent",
      windowIndex: 3,
      windowName: "codex",
    };
    const serviceTarget = {
      sessionName: "project-client-1",
      windowId: "@service",
      windowIndex: 4,
      windowName: "shell",
    };
    return {
      isInsideTmux: vi.fn(() => false),
      currentClientSession: vi.fn(() => null),
      openTarget: vi.fn(),
      getTargetByWindowId: vi.fn(),
      listProjectManagedWindows: vi.fn(() => [
        {
          target: agentTarget,
          metadata: {
            kind: "agent",
            sessionId: "codex-1",
            backendSessionId: "backend-1",
            command: "codex",
            args: [],
            toolConfigKey: "codex",
          },
        },
        {
          target: serviceTarget,
          metadata: {
            kind: "service",
            sessionId: "service-1",
            command: "shell",
            args: [],
            toolConfigKey: "shell",
          },
        },
      ]),
      ...overrides,
    } as any;
  }

  it("opens agent windows from the same project-wide source used by dashboard render", () => {
    const tmux = host();

    const target = openManagedSessionWindow(tmux, "/repo", { id: "codex-1", tmuxWindowId: "@agent" });

    expect(target?.windowId).toBe("@agent");
    expect(tmux.openTarget).toHaveBeenCalledWith(expect.objectContaining({ windowId: "@agent" }), {
      insideTmux: false,
    });
  });

  it("opens agent windows by backend session id when the logical id changed", () => {
    const tmux = host();

    const target = openManagedSessionWindow(tmux, "/repo", { id: "codex-new", backendSessionId: "backend-1" });

    expect(target?.windowId).toBe("@agent");
    expect(tmux.openTarget).toHaveBeenCalledWith(expect.objectContaining({ windowId: "@agent" }), {
      insideTmux: false,
    });
  });

  it("skips dead stale agent matches and opens a later live replacement", () => {
    const deadTarget = {
      sessionName: "project-client-1",
      windowId: "@dead-agent",
      windowIndex: 2,
      windowName: "codex",
    };
    const liveTarget = {
      sessionName: "project-client-1",
      windowId: "@live-agent",
      windowIndex: 5,
      windowName: "codex",
    };
    const tmux = host({
      listProjectManagedWindows: vi.fn(() => [
        {
          target: deadTarget,
          metadata: { kind: "agent", sessionId: "codex-1", backendSessionId: "backend-1" },
        },
        {
          target: liveTarget,
          metadata: { kind: "agent", sessionId: "codex-1", backendSessionId: "backend-1" },
        },
      ]),
      isWindowAlive: vi.fn((target) => target.windowId !== "@dead-agent"),
    });

    const target = openManagedSessionWindow(tmux, "/repo", { id: "codex-1", backendSessionId: "backend-1" });

    expect(target?.windowId).toBe("@live-agent");
    expect(tmux.openTarget).toHaveBeenCalledWith(liveTarget, { insideTmux: false });
  });

  it("prefers an exact agent tmux window id over an earlier duplicate live session match", () => {
    const duplicateTarget = {
      sessionName: "project-client-1",
      windowId: "@duplicate-agent",
      windowIndex: 2,
      windowName: "codex",
    };
    const exactTarget = {
      sessionName: "project-client-1",
      windowId: "@exact-agent",
      windowIndex: 5,
      windowName: "codex",
    };
    const tmux = host({
      listProjectManagedWindows: vi.fn(() => [
        {
          target: duplicateTarget,
          metadata: { kind: "agent", sessionId: "codex-1", backendSessionId: "backend-1" },
        },
        {
          target: exactTarget,
          metadata: { kind: "agent", sessionId: "codex-1", backendSessionId: "backend-1" },
        },
      ]),
      isWindowAlive: vi.fn(() => true),
    });

    const target = openManagedSessionWindow(tmux, "/repo", { id: "codex-1", tmuxWindowId: "@exact-agent" });

    expect(target?.windowId).toBe("@exact-agent");
    expect(tmux.openTarget).toHaveBeenCalledWith(exactTarget, { insideTmux: false });
  });

  it("opens service windows from project-wide managed windows", () => {
    const tmux = host();

    const target = openManagedServiceWindow(tmux, "/repo", "service-1");

    expect(target?.windowId).toBe("@service");
    expect(tmux.openTarget).toHaveBeenCalledWith(expect.objectContaining({ windowId: "@service" }), {
      insideTmux: false,
    });
  });

  it("skips dead stale service matches and opens a later live replacement", () => {
    const deadTarget = {
      sessionName: "project-client-1",
      windowId: "@dead-service",
      windowIndex: 4,
      windowName: "shell",
    };
    const liveTarget = {
      sessionName: "project-client-1",
      windowId: "@live-service",
      windowIndex: 6,
      windowName: "shell",
    };
    const tmux = host({
      listProjectManagedWindows: vi.fn(() => [
        {
          target: deadTarget,
          metadata: { kind: "service", sessionId: "service-1" },
        },
        {
          target: liveTarget,
          metadata: { kind: "service", sessionId: "service-1" },
        },
      ]),
      isWindowAlive: vi.fn((target) => target.windowId !== "@dead-service"),
    });

    const target = openManagedServiceWindow(tmux, "/repo", "service-1");

    expect(target?.windowId).toBe("@live-service");
    expect(tmux.openTarget).toHaveBeenCalledWith(liveTarget, { insideTmux: false });
  });

  it("prefers an exact service tmux window id over an earlier duplicate live service match", () => {
    const duplicateTarget = {
      sessionName: "project-client-1",
      windowId: "@duplicate-service",
      windowIndex: 4,
      windowName: "shell",
    };
    const exactTarget = {
      sessionName: "project-client-1",
      windowId: "@exact-service",
      windowIndex: 6,
      windowName: "shell",
    };
    const tmux = host({
      listProjectManagedWindows: vi.fn(() => [
        {
          target: duplicateTarget,
          metadata: { kind: "service", sessionId: "service-1" },
        },
        {
          target: exactTarget,
          metadata: { kind: "service", sessionId: "service-1" },
        },
      ]),
      isWindowAlive: vi.fn(() => true),
    });

    const target = openManagedServiceWindow(tmux, "/repo", { id: "service-1", tmuxWindowId: "@exact-service" });

    expect(target?.windowId).toBe("@exact-service");
    expect(tmux.openTarget).toHaveBeenCalledWith(exactTarget, { insideTmux: false });
  });
});
