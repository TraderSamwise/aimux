import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initPaths } from "../paths.js";
import { addNotification, listNotifications } from "../notifications.js";
import { handleNotificationsKey } from "./notifications.js";

describe("notification target open", () => {
  let host: any;
  let repoRoot = "";

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "aimux-notification-open-"));
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    await initPaths(repoRoot);
    const notification = addNotification({
      title: "Needs input",
      body: "Open service",
      sessionId: "service-1",
    });
    host = {
      notificationEntries: [notification],
      notificationIndex: 0,
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
    handleNotificationsKey(host, Buffer.from("\r"));
    await vi.waitFor(() => expect(host.activateDashboardService).toHaveBeenCalled());

    expect(host.activateDashboardService).toHaveBeenCalledWith({
      id: "service-1",
      status: "offline",
      label: "shell",
      command: "shell",
    });
    expect(host.resumeOfflineServiceWithFeedback).not.toHaveBeenCalled();
    expect(host.resumeOfflineServiceById).not.toHaveBeenCalled();
    expect(listNotifications({ unreadOnly: true, sessionId: "service-1" })).toHaveLength(0);
  });

  it("keeps a notification unread if target activation fails", async () => {
    host.activateDashboardService = vi.fn(async () => {
      throw new Error("open failed");
    });

    handleNotificationsKey(host, Buffer.from("\r"));
    await vi.waitFor(() => expect(host.activateDashboardService).toHaveBeenCalled());

    expect(listNotifications({ unreadOnly: true, sessionId: "service-1" })).toHaveLength(1);
  });
});
