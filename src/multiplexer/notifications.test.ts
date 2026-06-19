import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initPaths } from "../paths.js";
import type { NotificationRecord } from "../notifications.js";
import { upsertNotification } from "../notifications.js";
import { createRuntimeExchangeStore } from "../runtime-core/exchange-store.js";
import { notificationTargetLabel, notificationTargetState, refreshNotificationEntries } from "./notifications.js";
import { handleCoordinationKey } from "./coordination.js";

function addExchangeNotification(sessionId: string, body: string): NotificationRecord {
  return upsertNotification({ title: "Needs input", body, sessionId, kind: "thread" });
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
      coordinationSection: "notifications",
      notificationEntries: [notification],
      notificationIndex: 0,
      renderCoordination: vi.fn(),
      getDashboardSessions: vi.fn(() => []),
      getDashboardServices: vi.fn(() => [{ id: "service-1", status: "offline", label: "shell", command: "shell" }]),
      notificationTargetLabel: vi.fn(() => "shell [service]"),
      notificationTargetState: vi.fn(() => "offline"),
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
      composeSplitScreen: (left: string[]) => left,
      wrapKeyValue: (_key: string, value: string) => [value],
      writeFrame: vi.fn(),
      showHelp: vi.fn(),
      footerFlash: "",
      footerFlashTicks: 0,
    };
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
    const teammateNotification = addExchangeNotification("teammate-1", "Open teammate");
    host.notificationEntries = [teammateNotification];
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
});
