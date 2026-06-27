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

  it("opens service windows from project-wide managed windows", () => {
    const tmux = host();

    const target = openManagedServiceWindow(tmux, "/repo", "service-1");

    expect(target?.windowId).toBe("@service");
    expect(tmux.openTarget).toHaveBeenCalledWith(expect.objectContaining({ windowId: "@service" }), {
      insideTmux: false,
    });
  });
});
