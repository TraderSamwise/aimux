import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initPaths } from "../paths.js";
import { addNotification, markNotificationsRead } from "../notifications.js";
import { persistenceMethods } from "./persistence-methods.js";

function cleanupInboxHost() {
  return {
    mode: "dashboard",
    dashboardInputEpoch: 0,
    notificationIndex: 0,
    threadEntries: [],
    dashboardTeammatesCache: [],
    getDashboardSessions: () => [],
    getDashboardServices: () => [],
    metadataServer: { notifyChange: vi.fn() },
    isDashboardScreen: vi.fn(() => true),
    refreshCoordinationFromService: vi.fn(async () => true),
    renderCurrentDashboardView: vi.fn(),
  } as any;
}

describe("cleanupInbox runtime", () => {
  let repoRoot = "";

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "aimux-inbox-cleanup-runtime-"));
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    await initPaths(repoRoot);
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("archives a read+aged notification and refreshes service-backed consumers", async () => {
    const record = addNotification({
      title: "needs input",
      body: "waiting",
      sessionId: "claude-1",
      kind: "needs_input",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    markNotificationsRead({ id: record.id });

    const host = cleanupInboxHost();
    const result = await (persistenceMethods.cleanupInbox as any).call(host, { now: "2026-06-01T00:00:00.000Z" });

    expect(result.results.some((item: any) => item.status === "cleared")).toBe(true);
    expect(host.metadataServer.notifyChange).toHaveBeenCalled();
    await vi.waitFor(() => expect(host.refreshCoordinationFromService).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(host.renderCurrentDashboardView).toHaveBeenCalledOnce());
  });

  it("does not refresh or notify when nothing is eligible", async () => {
    addNotification({ title: "needs input", body: "waiting", sessionId: "claude-1", kind: "needs_input" });

    const host = cleanupInboxHost();
    const result = await (persistenceMethods.cleanupInbox as any).call(host, { now: "2026-06-01T00:00:00.000Z" });

    expect(result.results.some((item: any) => item.status === "cleared")).toBe(false);
    expect(host.metadataServer.notifyChange).not.toHaveBeenCalled();
  });
});
