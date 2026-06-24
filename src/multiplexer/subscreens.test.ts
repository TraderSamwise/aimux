import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initPaths } from "../paths.js";
import { appendMessage, createThread } from "../threads.js";
import { renderCoordinationDetails } from "../tui/screens/subscreen-renderers.js";
import { buildThreadEntries } from "../workflow.js";
import { handleCoordinationKey } from "./coordination.js";
import { openRelevantThreadForSession, runThreadHandoffAction } from "./subscreens.js";

describe("thread subscreen navigation", () => {
  let repoRoot = "";

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "aimux-thread-navigation-"));
    await initPaths(repoRoot);
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("opens hidden teammate thread targets from the teammate cache", () => {
    const thread = createThread({
      id: "thread-1",
      title: "Review",
      kind: "review",
      createdBy: "parent-1",
      participants: ["teammate-1", "user"],
      owner: "teammate-1",
      unreadBy: ["teammate-1"],
    });
    const teammate = {
      id: "teammate-1",
      command: "codex",
      status: "offline",
      team: { teamId: "team-parent", parentSessionId: "parent-1", role: "reviewer" },
    };
    const host: any = {
      coordinationWorklist: [{ kind: "thread", key: "t:thread-1", thread: { thread, displayTitle: "Review" } }],
      coordinationIndex: 0,
      threadEntries: [{ thread, displayTitle: "Review" }],
      threadIndex: 0,
      getDashboardSessions: vi.fn(() => []),
      dashboardTeammatesCache: [teammate],
      postToProjectService: vi.fn(async () => ({ ok: true })),
      activateDashboardEntry: vi.fn(),
      dashboardState: { toggleDetailsSidebar: vi.fn() },
      handleDashboardSubscreenNavigationKey: vi.fn(() => false),
      exitDashboardClientOrProcess: vi.fn(),
      setDashboardScreen: vi.fn(),
      renderDashboard: vi.fn(),
      showHelp: vi.fn(),
    };

    handleCoordinationKey(host, Buffer.from("\r"));

    expect(host.postToProjectService).toHaveBeenCalledWith("/threads/mark-seen", {
      threadId: "thread-1",
      session: "user",
    });
    expect(host.activateDashboardEntry).toHaveBeenCalledWith(teammate, { preserveDashboardSelection: true });
  });

  it("renders thread details from thread entry messages without a host reader", () => {
    const thread = createThread({
      id: "thread-1",
      title: "Review",
      kind: "review",
      createdBy: "parent-1",
      participants: ["teammate-1", "user"],
      owner: "teammate-1",
    });
    appendMessage(thread.id, {
      id: "message-1",
      from: "parent-1",
      to: ["user"],
      kind: "note",
      body: "Please check this thread.",
    });

    const host: any = {
      coordinationWorklist: [{ kind: "thread", thread: buildThreadEntries()[0] }],
      coordinationIndex: 0,
      describeHandoffState: vi.fn(),
      wrapKeyValue: (_key: string, value: string) => [value],
    };

    expect(() => renderCoordinationDetails(host, 80, 20)).not.toThrow();
    expect(renderCoordinationDetails(host, 80, 20).join("\n")).toContain("Please check this thread.");
  });

  it("opens relevant threads through a lifecycle-aware coordination refresh", async () => {
    const thread = createThread({
      id: "thread-1",
      title: "Review",
      kind: "review",
      createdBy: "parent-1",
      participants: ["codex-1", "user"],
      owner: "codex-1",
    });
    const host: any = {
      mode: "dashboard",
      dashboardInputEpoch: 4,
      dashboardState: { screen: "dashboard" },
      threadEntries: [{ thread, displayTitle: "Review" }],
      refreshCoordinationFromService: vi.fn(async () => true),
      isDashboardScreen: vi.fn((screen: string) => screen === "dashboard"),
      setDashboardScreen: vi.fn(),
      writeStatuslineFile: vi.fn(),
      renderCoordination: vi.fn(),
    };

    await openRelevantThreadForSession(host, "codex-1");

    expect(host.refreshCoordinationFromService).toHaveBeenCalledWith({
      force: true,
      lifecycle: expect.objectContaining({ inputEpoch: 4, screen: "dashboard" }),
    });
    expect(host.setDashboardScreen).toHaveBeenCalledWith("coordination");
  });

  it("forces coordination refresh after thread workflow mutations", async () => {
    const host: any = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
      isDashboardScreen: vi.fn((screen: string) => screen === "coordination"),
      postToProjectService: vi.fn(async () => ({ ok: true })),
      refreshCoordinationFromService: vi.fn(async () => true),
      renderCoordination: vi.fn(),
    };

    await runThreadHandoffAction(host, "accept", "thread-1");
    await vi.waitFor(() => {
      expect(host.refreshCoordinationFromService).toHaveBeenCalledWith({
        force: true,
        lifecycle: expect.objectContaining({ inputEpoch: 0, screen: "coordination" }),
      });
      expect(host.renderCoordination).toHaveBeenCalledOnce();
    });

    expect(host.postToProjectService).toHaveBeenCalledWith("/handoff/accept", {
      threadId: "thread-1",
      from: "user",
    });
  });

  it("shows refresh failure instead of success when workflow mutation snapshot reload fails", async () => {
    const host: any = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
      isDashboardScreen: vi.fn((screen: string) => screen === "coordination"),
      postToProjectService: vi.fn(async () => ({ ok: true })),
      refreshCoordinationFromService: vi.fn(async () => false),
      renderCoordination: vi.fn(),
    };

    await runThreadHandoffAction(host, "accept", "thread-1");

    expect(host.footerFlash).toBe("Coordination refresh failed");
    expect(host.renderCoordination).toHaveBeenCalledOnce();
  });

  it("does not render stale workflow mutation completions after leaving coordination", async () => {
    let resolvePost!: (value: unknown) => void;
    const host: any = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
      isDashboardScreen: vi.fn((screen: string) => host.mode === "dashboard" && screen === "coordination"),
      postToProjectService: vi.fn(
        () =>
          new Promise((resolve) => {
            resolvePost = resolve;
          }),
      ),
      refreshCoordinationFromService: vi.fn(async () => true),
      renderCoordination: vi.fn(),
      showDashboardError: vi.fn(),
    };

    const action = runThreadHandoffAction(host, "accept", "thread-1");
    host.mode = "session";
    resolvePost({ ok: true });
    await action;

    expect(host.refreshCoordinationFromService).toHaveBeenCalledWith({
      force: true,
      lifecycle: expect.objectContaining({ inputEpoch: 0, screen: "coordination" }),
    });
    expect(host.renderCoordination).not.toHaveBeenCalled();
    expect(host.showDashboardError).not.toHaveBeenCalled();
  });

  it("does not flash stale notification mutation failures after later input", async () => {
    let rejectPost!: (error: unknown) => void;
    const host: any = {
      mode: "dashboard",
      dashboardInputEpoch: 1,
      coordinationIndex: 0,
      coordinationWorklist: [
        {
          key: "n:claude-1",
          kind: "notification",
          sessionId: "claude-1",
          type: "msg",
          bucket: "awake",
          title: "Claude needs input",
          urgency: 1,
          reachability: "live",
          actionable: true,
          stale: false,
          notification: {
            key: "claude-1",
            sessionId: "claude-1",
            title: "Claude needs input",
            unreadCount: 1,
            reachability: "live",
            actionable: true,
            stale: false,
            notifications: [{ id: "note-1", kind: "message", body: "hello" }],
          },
        },
      ],
      isDashboardScreen: vi.fn((screen: string) => screen === "coordination"),
      handleDashboardSubscreenNavigationKey: vi.fn(() => false),
      postToProjectService: vi.fn(
        () =>
          new Promise((_, reject) => {
            rejectPost = reject;
          }),
      ),
      refreshCoordinationFromService: vi.fn(async () => true),
      writeFrame: vi.fn(),
      getViewportSize: vi.fn(() => ({ cols: 100, rows: 30 })),
      centerInWidth: vi.fn((text: string) => text),
      truncatePlain: vi.fn((text: string) => text),
      wrapKeyValue: vi.fn((_key: string, value: string) => [value]),
      dashboardState: { detailsSidebarVisible: false },
    };

    handleCoordinationKey(host, Buffer.from("r"));
    expect(host.postToProjectService).toHaveBeenCalledWith("/notifications/read", { sessionId: "claude-1" });
    host.dashboardInputEpoch = 2;
    rejectPost(new Error("late failure"));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(host.footerFlash).toBeUndefined();
    expect(host.refreshCoordinationFromService).not.toHaveBeenCalled();
    expect(host.writeFrame).not.toHaveBeenCalled();
  });

  it("forces coordination refresh before selecting a relevant thread", async () => {
    const thread = createThread({
      id: "thread-force",
      title: "Needs input",
      kind: "question",
      createdBy: "claude-1",
      participants: ["claude-1", "user"],
      waitingOn: ["claude-1"],
    });
    const host: any = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
      dashboardState: { screen: "dashboard" },
      coordinationLoaded: true,
      threadEntries: [{ thread, displayTitle: "Needs input" }],
      coordinationWorklist: [{ kind: "thread", thread: { thread } }],
      refreshCoordinationFromService: vi.fn(async () => true),
      setDashboardScreen: vi.fn(),
      writeStatuslineFile: vi.fn(),
      openDashboardOverlay: vi.fn(),
      redrawDashboardWithOverlay: vi.fn(),
      renderCoordination: vi.fn(),
    };

    await openRelevantThreadForSession(host, "claude-1");

    expect(host.refreshCoordinationFromService).toHaveBeenCalledWith({
      force: true,
      lifecycle: expect.objectContaining({ inputEpoch: 0, screen: "dashboard" }),
    });
    expect(host.setDashboardScreen).toHaveBeenCalledWith("coordination");
    expect(host.openDashboardOverlay).toHaveBeenCalledWith("thread-reply");
  });

  it("does not open a relevant thread after the dashboard screen changes during refresh", async () => {
    let resolveRefresh!: (value: boolean) => void;
    const thread = createThread({
      id: "thread-stale",
      title: "Needs input",
      kind: "question",
      createdBy: "claude-1",
      participants: ["claude-1", "user"],
      waitingOn: ["claude-1"],
    });
    const host: any = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
      dashboardState: { screen: "dashboard" },
      coordinationLoaded: true,
      threadEntries: [{ thread, displayTitle: "Needs input" }],
      coordinationWorklist: [{ kind: "thread", thread: { thread } }],
      refreshCoordinationFromService: vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            resolveRefresh = resolve;
          }),
      ),
      setDashboardScreen: vi.fn(),
      openDashboardOverlay: vi.fn(),
      renderCoordination: vi.fn(),
    };

    const open = openRelevantThreadForSession(host, "claude-1");
    host.dashboardState.screen = "project";
    resolveRefresh(true);
    await open;

    expect(host.setDashboardScreen).not.toHaveBeenCalled();
    expect(host.openDashboardOverlay).not.toHaveBeenCalled();
    expect(host.renderCoordination).not.toHaveBeenCalled();
  });
});
