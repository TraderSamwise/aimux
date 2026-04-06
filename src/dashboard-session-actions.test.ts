import { describe, expect, it, vi } from "vitest";
import {
  graveyardSessionWithFeedback,
  resumeOfflineSessionWithFeedback,
  stopSessionToOfflineWithFeedback,
} from "./dashboard-session-actions.js";

class FakeRuntime {
  exited = false;
  private exitHandlers: Array<() => void> = [];

  constructor(
    public readonly id: string,
    public readonly command: string,
  ) {}

  onExit(handler: () => void): void {
    this.exitHandlers.push(handler);
  }

  triggerExit(): void {
    this.exited = true;
    for (const handler of this.exitHandlers) handler();
  }
}

describe("dashboard-session-actions", () => {
  it("no-ops duplicate resume while already starting", async () => {
    const resumeOfflineSession = vi.fn();
    const setPendingAction = vi.fn();
    const setFooterFlash = vi.fn();
    const renderDashboard = vi.fn();

    await resumeOfflineSessionWithFeedback(
      {
        getSessionLabel: () => "main",
        getPendingAction: () => "starting",
        setPendingAction,
        stopSessionToOffline: vi.fn(),
        isGraveyardAfterStop: vi.fn(),
        sendAgentToGraveyard: vi.fn(),
        resumeOfflineSession,
        refreshLocalDashboardModel: vi.fn(),
        adjustAfterRemove: vi.fn(),
        renderDashboard,
        showDashboardError: vi.fn(),
        setFooterFlash,
        getRuntimeById: vi.fn(),
        isSessionRuntimeLive: vi.fn(),
      },
      { id: "sess-1", command: "codex", label: "main" },
    );

    expect(resumeOfflineSession).not.toHaveBeenCalled();
    expect(setPendingAction).not.toHaveBeenCalled();
    expect(setFooterFlash).not.toHaveBeenCalled();
    expect(renderDashboard).not.toHaveBeenCalled();
  });

  it("stops a session to offline and clears pending after exit", async () => {
    const runtime = new FakeRuntime("sess-1", "codex");
    const setPendingAction = vi.fn();
    const refreshLocalDashboardModel = vi.fn();
    const setFooterFlash = vi.fn();
    const renderDashboard = vi.fn();

    await stopSessionToOfflineWithFeedback(
      {
        getSessionLabel: () => "main",
        getPendingAction: vi.fn(),
        setPendingAction,
        stopSessionToOffline: () => runtime.triggerExit(),
        isGraveyardAfterStop: () => false,
        sendAgentToGraveyard: vi.fn(),
        resumeOfflineSession: vi.fn(),
        refreshLocalDashboardModel,
        adjustAfterRemove: vi.fn(),
        renderDashboard,
        showDashboardError: vi.fn(),
        setFooterFlash,
        getRuntimeById: vi.fn(),
        isSessionRuntimeLive: vi.fn(),
      },
      runtime as never,
    );

    expect(setPendingAction).toHaveBeenNthCalledWith(1, "sess-1", "stopping");
    expect(setPendingAction).toHaveBeenNthCalledWith(2, "sess-1", null);
    expect(refreshLocalDashboardModel).toHaveBeenCalledOnce();
    expect(setFooterFlash).toHaveBeenCalledWith("Stopped main", 3);
    expect(renderDashboard).toHaveBeenCalledOnce();
  });

  it("graveyards a session, clears pending, and adjusts selection", async () => {
    const setPendingAction = vi.fn();
    const refreshLocalDashboardModel = vi.fn();
    const adjustAfterRemove = vi.fn();
    const setFooterFlash = vi.fn();
    const renderDashboard = vi.fn();

    await graveyardSessionWithFeedback(
      {
        getSessionLabel: () => "main",
        getPendingAction: vi.fn(),
        setPendingAction,
        stopSessionToOffline: vi.fn(),
        isGraveyardAfterStop: vi.fn(),
        sendAgentToGraveyard: vi.fn().mockResolvedValue(undefined),
        resumeOfflineSession: vi.fn(),
        refreshLocalDashboardModel,
        adjustAfterRemove,
        renderDashboard,
        showDashboardError: vi.fn(),
        setFooterFlash,
        getRuntimeById: vi.fn(),
        isSessionRuntimeLive: vi.fn(),
      },
      { id: "sess-1", command: "codex", label: "main" },
      "sess-1",
      true,
    );

    expect(setPendingAction).toHaveBeenNthCalledWith(1, "sess-1", "graveyarding");
    expect(setPendingAction).toHaveBeenNthCalledWith(2, "sess-1", null);
    expect(refreshLocalDashboardModel).toHaveBeenCalledOnce();
    expect(adjustAfterRemove).toHaveBeenCalledWith(true);
    expect(setFooterFlash).toHaveBeenCalledWith("Sent main to graveyard", 3);
    expect(renderDashboard).toHaveBeenCalledOnce();
  });
});
