import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initPaths } from "../paths.js";
import type { NotificationRecord } from "../notifications.js";
import { clearNotifications, listNotifications, markNotificationsRead, upsertNotification } from "../notifications.js";
import { createRuntimeExchangeStore } from "../runtime-core/exchange-store.js";
import {
  applyCoordinationModel,
  markCoordinationItemRead,
  notificationTargetLabel,
  notificationTargetState,
  openCoordinationNotification,
  refreshCoordinationFromService,
} from "./notifications.js";
import { buildCoordinationView } from "../coordination-model.js";
import { handleCoordinationKey, showCoordination } from "./coordination.js";

function addExchangeNotification(sessionId: string, body: string): NotificationRecord {
  return upsertNotification({ title: "Needs input", body, sessionId, kind: "thread" });
}

// Faithful stand-in for the project service: applies the notification mutation to the local
// store synchronously (so store assertions hold) the way the real service would.
function notificationServiceDouble() {
  return vi.fn(async (path: string, body: { id?: string; ids?: string[]; sessionId?: string }) => {
    if (path === "/notifications/read") markNotificationsRead(body);
    else if (path === "/notifications/clear") clearNotifications(body);
    return { ok: true };
  });
}

function unreadInboxEntries(sessionId: string) {
  return createRuntimeExchangeStore()
    .read()
    .inbox.filter((entry) => entry.participantId === sessionId && entry.state !== "done");
}

function applyServiceLikeCoordinationPayload(host: any): void {
  const threads: never[] = [];
  const { model, worklist } = buildCoordinationView({
    sessions: host.getDashboardSessions?.() ?? [],
    teammates: host.dashboardTeammatesCache ?? [],
    services: host.getDashboardServices?.() ?? [],
    notifications: listNotifications(),
    threads,
  });
  applyCoordinationModel(host, { model, worklist, threads });
}

describe("notification target open", () => {
  let host: any;
  let repoRoot = "";

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "aimux-notification-open-"));
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    await initPaths(repoRoot);
    const notification = addExchangeNotification("service-1", "Open service");
    host = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
      notificationEntries: [notification],
      notificationIndex: 0,
      renderCoordination: vi.fn(),
      getDashboardSessions: vi.fn(() => []),
      getDashboardServices: vi.fn(() => [{ id: "service-1", status: "offline", label: "shell", command: "shell" }]),
      notificationTargetLabel: vi.fn(() => "shell [service]"),
      notificationTargetState: vi.fn(() => "offline"),
      postToProjectService: notificationServiceDouble(),
      activateDashboardService: vi.fn(async () => undefined),
      resumeOfflineServiceWithFeedback: vi.fn(async () => undefined),
      resumeOfflineServiceById: vi.fn(),
      waitAndOpenLiveTmuxWindowForService: vi.fn(),
      showDashboardError: vi.fn(),
      dashboardState: { screen: "coordination", toggleDetailsSidebar: vi.fn() },
      handleDashboardSubscreenNavigationKey: vi.fn(() => false),
      exitDashboardClientOrProcess: vi.fn(),
      setDashboardScreen: vi.fn(),
      renderDashboard: vi.fn(),
      getViewportSize: vi.fn(() => ({ cols: 120, rows: 40 })),
      centerInWidth: (text: string) => text,
      truncatePlain: (text: string) => text,
      wrapKeyValue: (_key: string, value: string) => [value],
      writeFrame: vi.fn(),
      showHelp: vi.fn(),
      footerFlash: "",
      footerFlashTicks: 0,
    };
    applyServiceLikeCoordinationPayload(host);
    host.coordinationIndex = 0;
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("routes service notification targets through the unified service activator", async () => {
    handleCoordinationKey(host, Buffer.from("\r"));
    await vi.waitFor(() => expect(host.activateDashboardService).toHaveBeenCalled());

    expect(host.activateDashboardService).toHaveBeenCalledWith({
      id: "service-1",
      status: "offline",
      label: "shell",
      command: "shell",
    });
    expect(host.resumeOfflineServiceWithFeedback).not.toHaveBeenCalled();
    expect(host.resumeOfflineServiceById).not.toHaveBeenCalled();
    expect(unreadInboxEntries("service-1")).toHaveLength(0);
  });

  it("keeps a notification unread if target activation fails", async () => {
    host.activateDashboardService = vi.fn(async () => {
      throw new Error("open failed");
    });

    handleCoordinationKey(host, Buffer.from("\r"));
    await vi.waitFor(() => expect(host.activateDashboardService).toHaveBeenCalled());

    expect(unreadInboxEntries("service-1")).toHaveLength(1);
  });

  it("suppresses stale activation failure UI after newer dashboard input", async () => {
    let rejectOpen!: (error: unknown) => void;
    host.activateDashboardService = vi.fn(
      () =>
        new Promise((_resolve, reject) => {
          rejectOpen = reject;
        }),
    );

    const open = openCoordinationNotification(host, host.coordinationWorklist[host.coordinationIndex]);
    await vi.waitFor(() => expect(host.activateDashboardService).toHaveBeenCalled());
    host.dashboardInputEpoch = 1;
    rejectOpen(new Error("open failed"));
    await expect(open).resolves.toBeUndefined();

    expect(host.footerFlash).toBe("");
    expect(host.renderDashboard).not.toHaveBeenCalled();
    expect(host.renderCoordination).not.toHaveBeenCalled();
  });

  it("keeps a notification unread if service activation resolves without opening", async () => {
    host.activateDashboardService = vi.fn(async () => "missing");

    handleCoordinationKey(host, Buffer.from("\r"));
    await vi.waitFor(() => expect(host.activateDashboardService).toHaveBeenCalled());

    expect(unreadInboxEntries("service-1")).toHaveLength(1);
    expect(host.footerFlash).toBe("Failed to open notification target");
  });

  it("does not throw when notification settle fails before refresh wiring exists", async () => {
    delete host.refreshCoordinationFromService;
    host.postToProjectService = vi.fn(async () => {
      throw new Error("service unavailable");
    });
    const item = {
      key: "n:sessionless",
      kind: "notification",
      notification: {
        unreadCount: 1,
        notifications: [{ id: "note-1" }],
      },
    } as any;

    await expect(openCoordinationNotification(host, item)).resolves.toBeUndefined();

    expect(host.footerFlash).toBe("Notification update failed");
    expect(host.renderCoordination).toHaveBeenCalled();
  });

  it("opens teammate notification targets from the hidden teammate cache", async () => {
    addExchangeNotification("teammate-1", "Open teammate");
    host.dashboardTeammatesCache = [
      {
        id: "teammate-1",
        command: "codex",
        label: "reviewer",
        status: "offline",
        worktreeName: "demo",
        team: { teamId: "team-parent", parentSessionId: "parent-1", role: "reviewer" },
      },
    ];
    host.activateDashboardEntry = vi.fn(async () => undefined);
    applyServiceLikeCoordinationPayload(host);
    host.coordinationIndex = host.coordinationWorklist.findIndex((item: any) => item.sessionId === "teammate-1");

    expect(notificationTargetLabel(host, "teammate-1")).toBe("reviewer · demo");
    expect(notificationTargetState(host, "teammate-1")).toBe("offline");

    host.dashboardTeammatesCache[0].status = "exited";
    expect(notificationTargetState(host, "teammate-1")).toBe("offline");
    host.dashboardTeammatesCache[0].status = "offline";

    handleCoordinationKey(host, Buffer.from("\r"));
    await vi.waitFor(() => expect(host.activateDashboardEntry).toHaveBeenCalled());

    expect(host.activateDashboardEntry).toHaveBeenCalledWith(expect.objectContaining({ id: "teammate-1" }), {
      preserveDashboardSelection: true,
    });
    expect(unreadInboxEntries("teammate-1")).toHaveLength(0);
  });
});

describe("coordination inbox ordering", () => {
  let repoRoot = "";

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "aimux-inbox-order-"));
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    await initPaths(repoRoot);
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("orders live-actionable first and sinks unreachable to the tail with meta flags", () => {
    addExchangeNotification("ghost-1", "vanished agent needs input");
    addExchangeNotification("live-1", "live agent needs input");
    const host: any = {
      notificationIndex: 0,
      threadEntries: [],
      dashboardTeammatesCache: [],
      getDashboardServices: () => [],
      getDashboardSessions: () => [
        {
          id: "live-1",
          status: "running",
          command: "claude",
          semantic: { user: { label: "needs_input" }, presentation: { attentionScore: 4 } },
        },
      ],
    };

    applyServiceLikeCoordinationPayload(host);

    expect(host.notificationEntries[0].sessionId).toBe("live-1");
    expect(host.notificationRowMeta[0]).toMatchObject({ reachability: "live", actionable: true });
    const last = host.notificationEntries.length - 1;
    expect(host.notificationEntries[last].sessionId).toBe("ghost-1");
    expect(host.notificationRowMeta[last]).toMatchObject({ reachability: "missing", actionable: false });
  });

  it("builds a unified worklist and navigates/filters/reads it by single index", () => {
    addExchangeNotification("ghost-1", "vanished agent needs input");
    addExchangeNotification("live-1", "live agent needs input");
    const host: any = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
      coordinationIndex: 0,
      coordinationFilter: "all",
      dashboardTeammatesCache: [],
      getDashboardServices: () => [],
      getDashboardSessions: () => [
        { id: "live-1", status: "running", command: "claude", semantic: { user: { label: "needs_input" } } },
      ],
      handleDashboardSubscreenNavigationKey: () => false,
      renderDashboard: vi.fn(),
      setDashboardScreen: vi.fn(),
      exitDashboardClientOrProcess: vi.fn(),
      showHelp: vi.fn(),
      getViewportSize: () => ({ cols: 120, rows: 40 }),
      centerInWidth: (text: string) => text,
      truncatePlain: (text: string) => text,
      wrapKeyValue: (_key: string, value: string) => [value],
      notificationTargetLabel: () => null,
      postToProjectService: notificationServiceDouble(),
      dashboardState: { screen: "coordination" },
      writeFrame: vi.fn(),
    };
    applyServiceLikeCoordinationPayload(host);

    expect(host.coordinationWorklist[0].sessionId).toBe("live-1");

    // digit nav selects by index
    handleCoordinationKey(host, Buffer.from("2"));
    expect(host.coordinationIndex).toBe(1);

    // Tab filters to threads-only (none here)
    handleCoordinationKey(host, Buffer.from("\t"));
    expect(host.coordinationFilter).toBe("threads");

    // r on the selected live notification marks its session read VIA the service (sole writer)
    host.coordinationFilter = "all";
    applyServiceLikeCoordinationPayload(host);
    host.coordinationIndex = 0;
    handleCoordinationKey(host, Buffer.from("r"));
    expect(host.postToProjectService).toHaveBeenCalledWith("/notifications/read", { sessionId: "live-1" });
    expect(unreadInboxEntries("live-1")).toHaveLength(0);
  });

  it("batches sessionless notification rollups through one service request", async () => {
    const first = upsertNotification({ title: "First", body: "sessionless first", kind: "thread" });
    const second = upsertNotification({ title: "Second", body: "sessionless second", kind: "thread" });
    const host: any = {
      postToProjectService: notificationServiceDouble(),
    };
    const item = {
      key: "notification:sessionless",
      kind: "notification",
      notification: {
        unreadCount: 2,
        notifications: [first, second],
      },
    } as any;

    await markCoordinationItemRead(host, item);
    expect(host.postToProjectService).toHaveBeenCalledTimes(1);
    expect(host.postToProjectService).toHaveBeenCalledWith("/notifications/read", {
      ids: expect.arrayContaining([first.id, second.id]),
    });
  });

  it("refreshes coordination after notification mutation failures", async () => {
    addExchangeNotification("live-1", "live agent needs input");
    const host: any = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
      coordinationIndex: 0,
      coordinationFilter: "all",
      dashboardTeammatesCache: [],
      getDashboardServices: () => [],
      getDashboardSessions: () => [{ id: "live-1", status: "running", command: "claude" }],
      handleDashboardSubscreenNavigationKey: () => false,
      renderDashboard: vi.fn(),
      setDashboardScreen: vi.fn(),
      exitDashboardClientOrProcess: vi.fn(),
      showHelp: vi.fn(),
      getViewportSize: () => ({ cols: 120, rows: 40 }),
      centerInWidth: (text: string) => text,
      truncatePlain: (text: string) => text,
      wrapKeyValue: (_key: string, value: string) => [value],
      notificationTargetLabel: () => null,
      postToProjectService: vi.fn(async () => {
        throw new Error("timeout");
      }),
      refreshCoordinationFromService: vi.fn(async () => true),
      dashboardState: { screen: "coordination" },
      writeFrame: vi.fn(),
    };
    applyServiceLikeCoordinationPayload(host);

    handleCoordinationKey(host, Buffer.from("r"));

    await vi.waitFor(() => expect(host.refreshCoordinationFromService).toHaveBeenCalledOnce());
    expect(host.footerFlash).toBe("Notification update failed");
  });

  it("loads coordination with a dashboard lifecycle token", async () => {
    const host: any = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
      coordinationIndex: 0,
      coordinationFilter: "all",
      notificationEntries: [],
      notificationRowMeta: [],
      coordinationWorklist: [],
      coordinationWorklistAll: [],
      clearDashboardSubscreens: vi.fn(),
      setDashboardScreen: vi.fn((screen: string) => {
        host.dashboardState.screen = screen;
      }),
      writeStatuslineFile: vi.fn(),
      refreshCoordinationFromService: vi.fn(async () => true),
      dashboardState: { screen: "dashboard" },
      isDashboardScreen: vi.fn((screen: string) => host.dashboardState.screen === screen),
      getViewportSize: () => ({ cols: 120, rows: 40 }),
      centerInWidth: (text: string) => text,
      truncatePlain: (text: string) => text,
      wrapKeyValue: (_key: string, value: string) => [value],
      writeFrame: vi.fn(),
    };

    showCoordination(host);
    await vi.waitFor(() =>
      expect(host.refreshCoordinationFromService).toHaveBeenCalledWith({
        lifecycle: expect.objectContaining({ inputEpoch: 0, screen: "coordination" }),
      }),
    );
  });
});

describe("coordination thread workflow keys", () => {
  function taskWorklistItem() {
    return {
      key: "t:thread-1",
      kind: "thread",
      type: "task",
      bucket: "awake",
      title: "Task",
      urgency: 1,
      reachability: "live",
      actionable: true,
      stale: false,
      thread: {
        thread: {
          id: "thread-1",
          kind: "task",
          title: "Task",
          participants: ["agent-1", "user"],
          owner: "agent-1",
          waitingOn: ["user"],
          unreadBy: [],
          status: "open",
          taskId: "task-1",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        displayTitle: "Task",
        messages: [],
        pendingDeliveries: 0,
        latestPendingRecipients: [],
        task: { id: "task-1" },
        urgency: 1,
        stateLabel: "assigned",
        familyTaskIds: ["task-1"],
      },
    };
  }

  function workflowHost() {
    return {
      coordinationIndex: 0,
      coordinationWorklist: [taskWorklistItem()],
      handleDashboardSubscreenNavigationKey: vi.fn(() => false),
      postToProjectService: vi.fn(async () => ({ ok: true })),
      refreshCoordinationFromService: vi.fn(async () => true),
      exitDashboardClientOrProcess: vi.fn(),
      setDashboardScreen: vi.fn(),
      renderDashboard: vi.fn(),
      showHelp: vi.fn(),
      showDashboardError: vi.fn(),
      activateDashboardEntry: vi.fn(async () => undefined),
      dashboardState: {},
      getViewportSize: () => ({ cols: 120, rows: 40 }),
      centerInWidth: (text: string) => text,
      truncatePlain: (text: string) => text,
      wrapKeyValue: (_key: string, value: string) => [value],
      writeFrame: vi.fn(),
    };
  }

  it("keeps accept, review, and reopen workflow mutations on uppercase keys", async () => {
    const host: any = workflowHost();

    handleCoordinationKey(host, Buffer.from("a"));
    handleCoordinationKey(host, Buffer.from("e"));
    handleCoordinationKey(host, Buffer.from("j"));
    expect(host.postToProjectService).not.toHaveBeenCalled();

    handleCoordinationKey(host, Buffer.from("A"));
    await vi.waitFor(() =>
      expect(host.postToProjectService).toHaveBeenCalledWith("/tasks/accept", {
        taskId: "task-1",
        from: "user",
      }),
    );

    handleCoordinationKey(host, Buffer.from("J"));
    await vi.waitFor(() =>
      expect(host.postToProjectService).toHaveBeenCalledWith("/reviews/request-changes", {
        taskId: "task-1",
        from: "user",
      }),
    );

    handleCoordinationKey(host, Buffer.from("E"));
    await vi.waitFor(() =>
      expect(host.postToProjectService).toHaveBeenCalledWith("/tasks/reopen", {
        taskId: "task-1",
        from: "user",
      }),
    );
  });

  it("marks coordination threads seen as the dashboard user, not the target agent", async () => {
    const host: any = workflowHost();

    handleCoordinationKey(host, Buffer.from("\r"));
    await vi.waitFor(() =>
      expect(host.postToProjectService).toHaveBeenCalledWith("/threads/mark-seen", {
        threadId: "thread-1",
        sessionId: "user",
      }),
    );
  });

  it("suppresses duplicate lifecycle mutations while a thread action is in flight", async () => {
    let resolvePost!: (value: unknown) => void;
    const host: any = workflowHost();
    host.postToProjectService = vi.fn(
      () =>
        new Promise((resolve) => {
          resolvePost = resolve;
        }),
    );

    handleCoordinationKey(host, Buffer.from("A"));
    handleCoordinationKey(host, Buffer.from("A"));

    await vi.waitFor(() => expect(host.postToProjectService).toHaveBeenCalledOnce());
    resolvePost({ ok: true });
    await vi.waitFor(() => expect(host.refreshCoordinationFromService).toHaveBeenCalledOnce());

    handleCoordinationKey(host, Buffer.from("A"));
    await vi.waitFor(() => expect(host.postToProjectService).toHaveBeenCalledTimes(2));
  });
});

describe("coordination reads prefer the service", () => {
  let repoRoot = "";

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "aimux-coordination-service-"));
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    await initPaths(repoRoot);
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("applies the service worklist to host state", async () => {
    // Service authority: a payload the local stores do NOT contain, proving the host took it
    // from the wire (the service-built reconciliation) rather than rebuilding locally.
    const payload = buildCoordinationView({
      sessions: [
        { id: "remote-1", status: "running", command: "claude", semantic: { user: { label: "needs_input" } } },
      ],
      notifications: [
        {
          id: "r1",
          title: "Remote",
          body: "remote agent needs input",
          sessionId: "remote-1",
          kind: "needs_input",
          unread: true,
          cleared: false,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      threads: [],
    });
    const host: any = {
      coordinationFilter: "all",
      getFromProjectService: vi.fn(async () => ({
        ok: true,
        model: payload.model,
        worklist: payload.worklist,
        threads: [],
      })),
    };

    const ok = await refreshCoordinationFromService(host);

    expect(ok).toBe(true);
    expect(host.getFromProjectService).toHaveBeenCalledWith("/coordination-worklist");
    expect(host.coordinationLoaded).toBe(true);
    expect(host.coordinationWorklist.map((item: any) => item.sessionId)).toContain("remote-1");
    expect(host.notificationEntries.map((entry: any) => entry.id)).toContain("r1");
  });

  it("does not apply stale coordination payloads after newer dashboard input", async () => {
    const payload = buildCoordinationView({
      sessions: [
        { id: "remote-1", status: "running", command: "claude", semantic: { user: { label: "needs_input" } } },
      ],
      notifications: [
        {
          id: "r1",
          title: "Remote",
          body: "remote agent needs input",
          sessionId: "remote-1",
          kind: "needs_input",
          unread: true,
          cleared: false,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      threads: [],
    });
    const host: any = {
      mode: "dashboard",
      dashboardInputEpoch: 1,
      coordinationFilter: "all",
      getFromProjectService: vi.fn(async () => ({
        ok: true,
        model: payload.model,
        worklist: payload.worklist,
        threads: [],
      })),
    };

    const ok = await refreshCoordinationFromService(host, {
      lifecycle: { mode: "dashboard", inputEpoch: 0, requiresInputEpoch: true },
    });

    expect(ok).toBe(false);
    expect(host.coordinationLoaded).toBeUndefined();
    expect(host.coordinationWorklist).toBeUndefined();
    expect(host.notificationEntries).toBeUndefined();
  });

  it("coalesces concurrent coordination refreshes through the TUI API runtime", async () => {
    const payload = buildCoordinationView({
      sessions: [
        { id: "remote-1", status: "running", command: "claude", semantic: { user: { label: "needs_input" } } },
      ],
      notifications: [
        {
          id: "r1",
          title: "Remote",
          body: "remote agent needs input",
          sessionId: "remote-1",
          kind: "needs_input",
          unread: true,
          cleared: false,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      threads: [],
    });
    let resolveRefresh!: (value: unknown) => void;
    const host: any = {
      coordinationFilter: "all",
      getFromProjectService: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveRefresh = resolve;
          }),
      ),
    };

    const first = refreshCoordinationFromService(host);
    const second = refreshCoordinationFromService(host);
    resolveRefresh({ ok: true, model: payload.model, worklist: payload.worklist, threads: [] });

    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);

    expect(host.getFromProjectService).toHaveBeenCalledTimes(1);
    expect(host.coordinationLoaded).toBe(true);
    expect(host.notificationEntries.map((entry: any) => entry.id)).toEqual(["r1"]);
  });

  it("preserves the last API state when the service request fails", async () => {
    addExchangeNotification("local-1", "local agent needs input");
    const host: any = {
      coordinationFilter: "all",
      coordinationLoaded: true,
      coordinationWorklist: [{ sessionId: "remote-1" }],
      notificationEntries: [{ id: "r1" }],
      getFromProjectService: vi.fn(async () => {
        throw new Error("service down");
      }),
      getDashboardSessions: () => [
        { id: "local-1", status: "running", command: "claude", semantic: { user: { label: "needs_input" } } },
      ],
      getDashboardServices: () => [],
      dashboardTeammatesCache: [],
    };

    const ok = await refreshCoordinationFromService(host);

    expect(ok).toBe(false);
    expect(host.coordinationLoaded).toBe(true);
    expect(host.coordinationWorklist.map((item: any) => item.sessionId)).toEqual(["remote-1"]);
    expect(host.notificationEntries.map((entry: any) => entry.id)).toEqual(["r1"]);
  });

  it("rejects malformed service thread payloads before mutating host state", async () => {
    const host: any = {
      coordinationFilter: "all",
      coordinationLoaded: true,
      threadEntries: [{ thread: { id: "existing" } }],
      coordinationWorklist: [{ sessionId: "remote-1" }],
      notificationEntries: [{ id: "r1" }],
      getFromProjectService: vi.fn(async () => ({
        ok: true,
        model: { items: [] },
        worklist: { items: [] },
        threads: { bad: true },
      })),
    };

    const ok = await refreshCoordinationFromService(host);

    expect(ok).toBe(false);
    expect(host.threadEntries).toEqual([{ thread: { id: "existing" } }]);
    expect(host.coordinationWorklist).toEqual([{ sessionId: "remote-1" }]);
    expect(host.notificationEntries).toEqual([{ id: "r1" }]);
  });
});
