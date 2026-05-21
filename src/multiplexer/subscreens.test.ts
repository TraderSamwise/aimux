import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initPaths } from "../paths.js";
import { createThread } from "../threads.js";
import { handleThreadsKey } from "./subscreens.js";

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
      threadEntries: [{ thread, displayTitle: "Review" }],
      threadIndex: 0,
      getDashboardSessions: vi.fn(() => []),
      dashboardTeammatesCache: [teammate],
      activateDashboardEntry: vi.fn(),
      dashboardState: { toggleDetailsSidebar: vi.fn() },
      handleDashboardSubscreenNavigationKey: vi.fn(() => false),
      exitDashboardClientOrProcess: vi.fn(),
      setDashboardScreen: vi.fn(),
      renderDashboard: vi.fn(),
      showHelp: vi.fn(),
    };

    handleThreadsKey(host, Buffer.from("\r"));

    expect(host.activateDashboardEntry).toHaveBeenCalledWith(teammate, { preserveDashboardSelection: true });
  });
});
