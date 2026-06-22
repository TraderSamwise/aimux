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
      sessionId: "teammate-1",
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

  it("forces coordination refresh after thread workflow mutations", async () => {
    const host: any = {
      postToProjectService: vi.fn(async () => ({ ok: true })),
      refreshCoordinationFromService: vi.fn(async () => true),
      renderCoordination: vi.fn(),
    };

    await runThreadHandoffAction(host, "accept", "thread-1");
    await vi.waitFor(() => {
      expect(host.refreshCoordinationFromService).toHaveBeenCalledWith({ force: true });
      expect(host.renderCoordination).toHaveBeenCalledOnce();
    });

    expect(host.postToProjectService).toHaveBeenCalledWith("/handoff/accept", {
      threadId: "thread-1",
      from: "user",
    });
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

    expect(host.refreshCoordinationFromService).toHaveBeenCalledWith({ force: true });
    expect(host.setDashboardScreen).toHaveBeenCalledWith("coordination");
    expect(host.openDashboardOverlay).toHaveBeenCalledWith("thread-reply");
  });
});
