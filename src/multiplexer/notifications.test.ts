import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initPaths } from "../paths.js";
import { addNotification } from "../notifications.js";
import { handleNotificationsKey } from "./notifications.js";

describe("notification target open", () => {
  let host: any;
  let repoRoot = "";

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "aimux-notification-open-"));
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    await initPaths(repoRoot);
    addNotification({
      id: "notif-1",
      title: "Needs input",
      body: "Open service",
      sessionId: "service-1",
      unread: true,
    });
    host = {
      notificationEntries: [{ id: "notif-1", sessionId: "service-1", unread: true }],
      notificationIndex: 0,
      getDashboardSessions: vi.fn(() => []),
      getDashboardServices: vi.fn(() => [{ id: "service-1", status: "offline", label: "shell", command: "shell" }]),
      resumeOfflineServiceWithFeedback: vi.fn(async () => undefined),
      resumeOfflineServiceById: vi.fn(),
      waitAndOpenLiveTmuxWindowForService: vi.fn(),
      showDashboardError: vi.fn(),
      dashboardState: { toggleDetailsSidebar: vi.fn() },
      handleDashboardSubscreenNavigationKey: vi.fn(() => false),
      exitDashboardClientOrProcess: vi.fn(),
      setDashboardScreen: vi.fn(),
      renderDashboard: vi.fn(),
      showHelp: vi.fn(),
      footerFlash: "",
      footerFlashTicks: 0,
    };
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("uses the lifecycle helper for offline service notification targets", () => {
    handleNotificationsKey(host, Buffer.from("\r"));

    expect(host.resumeOfflineServiceWithFeedback).toHaveBeenCalledWith({ id: "service-1", label: "shell" });
    expect(host.resumeOfflineServiceById).not.toHaveBeenCalled();
  });
});
