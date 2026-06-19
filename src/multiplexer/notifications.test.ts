import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initPaths } from "../paths.js";
import type { NotificationRecord } from "../notifications.js";
import { clearNotifications, markNotificationsRead, upsertNotification } from "../notifications.js";
import { createRuntimeExchangeStore } from "../runtime-core/exchange-store.js";
import {
  handleNotificationPanelKey,
  notificationTargetLabel,
  notificationTargetState,
  refreshCoordinationFromService,
  refreshNotificationEntries,
} from "./notifications.js";
import { buildCoordinationView } from "../coordination-model.js";
import { handleCoordinationKey } from "./coordination.js";

function addExchangeNotification(sessionId: string, body: string): NotificationRecord {
  return upsertNotification({ title: "Needs input", body, sessionId, kind: "thread" });
}

// Faithful stand-in for the project service: applies the notification mutation to the local
// store synchronously (so store assertions hold) the way the real service would.
function notificationServiceDouble() {
  return vi.fn(async (path: string, body: { id?: string; sessionId?: string }) => {
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

describe("notification target open", () => {
  let host: any;
  let repoRoot = "";

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "aimux-notification-open-"));
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    await initPaths(repoRoot);
    const notification = addExchangeNotification("service-1", "Open service");
    host = {
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
      dashboardState: { toggleDetailsSidebar: vi.fn() },
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
    refreshNotificationEntries(host);
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
    refreshNotificationEntries(host);
    host.coordinationIndex = host.coordinationWorklist.findIndex((item: any) => item.sessionId === "teammate-1");

    expect(notificationTargetLabel(host, "teammate-1")).toBe("reviewer · demo");
    expect(notificationTargetState(host, "teammate-1")).toBe("offline");

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

    refreshNotificationEntries(host);

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
      dashboardState: {},
      writeFrame: vi.fn(),
    };
    refreshNotificationEntries(host);

    expect(host.coordinationWorklist[0].sessionId).toBe("live-1");

    // digit nav selects by index
    handleCoordinationKey(host, Buffer.from("2"));
    expect(host.coordinationIndex).toBe(1);

    // Tab filters to threads-only (none here)
    handleCoordinationKey(host, Buffer.from("\t"));
    expect(host.coordinationFilter).toBe("threads");

    // r on the selected live notification marks its session read VIA the service (sole writer)
    host.coordinationFilter = "all";
    refreshNotificationEntries(host);
    host.coordinationIndex = 0;
    handleCoordinationKey(host, Buffer.from("r"));
    expect(host.postToProjectService).toHaveBeenCalledWith("/notifications/read", { sessionId: "live-1" });
    expect(unreadInboxEntries("live-1")).toHaveLength(0);
  });
});

describe("notification panel mutations route through the service", () => {
  let repoRoot = "";

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "aimux-notification-panel-"));
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    await initPaths(repoRoot);
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("posts read/clear via the service instead of writing the store directly", () => {
    const note = addExchangeNotification("panel-1", "needs you");
    const host: any = {
      notificationPanelState: { entries: [note], index: 0 },
      postToProjectService: notificationServiceDouble(),
      renderDashboard: vi.fn(),
      footerFlash: "",
      footerFlashTicks: 0,
    };
    handleNotificationPanelKey(host, Buffer.from("r"));
    expect(host.postToProjectService).toHaveBeenCalledWith("/notifications/read", { id: note.id });
    handleNotificationPanelKey(host, Buffer.from("C"));
    expect(host.postToProjectService).toHaveBeenCalledWith("/notifications/clear", {});
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
      sessions: [{ id: "remote-1", status: "running", command: "claude", semantic: { user: { label: "needs_input" } } }],
      notifications: [
        { id: "r1", title: "Remote", body: "remote agent needs input", sessionId: "remote-1", kind: "needs_input", unread: true, cleared: false, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
      ],
      threads: [],
    });
    const host: any = {
      coordinationFilter: "all",
      getFromProjectService: vi.fn(async () => ({ ok: true, model: payload.model, worklist: payload.worklist, threads: [] })),
    };

    const ok = await refreshCoordinationFromService(host);

    expect(ok).toBe(true);
    expect(host.getFromProjectService).toHaveBeenCalledWith("/coordination-worklist");
    expect(host.coordinationLoaded).toBe(true);
    expect(host.coordinationWorklist.map((item: any) => item.sessionId)).toContain("remote-1");
    expect(host.notificationEntries.map((entry: any) => entry.id)).toContain("r1");
  });

  it("falls back to the local build when the service request fails", async () => {
    addExchangeNotification("local-1", "local agent needs input");
    const host: any = {
      coordinationFilter: "all",
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
    expect(host.coordinationWorklist.map((item: any) => item.sessionId)).toContain("local-1");
  });
});
