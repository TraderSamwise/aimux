import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initPaths } from "../paths.js";
import { createService, removeOfflineService, resumeOfflineService, stopService } from "./services.js";

describe("services", () => {
  let repoRoot = "";

  const originalCwd = process.cwd();

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "aimux-services-"));
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    process.chdir(repoRoot);
    await initPaths(repoRoot);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("kills lingering managed tmux windows when removing an offline service", () => {
    const killWindow = vi.fn();
    const host = {
      offlineServices: [{ id: "svc-1", label: "shell", worktreePath: repoRoot }],
      tmuxRuntimeManager: {
        getProjectSession: vi.fn(() => ({ sessionName: "aimux-repo" })),
        findManagedWindow: vi.fn(() => ({
          target: { sessionName: "aimux-repo", windowId: "@7", windowIndex: 7, windowName: "shell" },
          metadata: { kind: "service", sessionId: "svc-1" },
        })),
        killWindow,
      },
      saveState: vi.fn(),
      invalidateDesktopStateSnapshot: vi.fn(),
      refreshLocalDashboardModel: vi.fn(),
      adjustAfterRemove: vi.fn(),
      dashboardWorktreeGroupsCache: [],
    };

    const result = removeOfflineService(host, "svc-1");

    expect(result).toEqual({ serviceId: "svc-1", status: "removed" });
    expect(killWindow).toHaveBeenCalledWith({
      sessionName: "aimux-repo",
      windowId: "@7",
      windowIndex: 7,
      windowName: "shell",
    });
    expect(host.offlineServices).toEqual([]);
    expect(host.saveState).toHaveBeenCalledOnce();
  });

  it("stops a running service by interrupting and retaining its tmux window", () => {
    const killWindow = vi.fn();
    const sendKey = vi.fn();
    const target = { sessionName: "aimux-repo", windowId: "@7", windowIndex: 7, windowName: "shell" };
    const host = {
      offlineServices: [],
      tmuxRuntimeManager: {
        getProjectSession: vi.fn(() => ({ sessionName: "aimux-repo" })),
        findManagedWindow: vi.fn(() => ({
          target,
          metadata: {
            kind: "service",
            sessionId: "svc-1",
            command: "shell",
            args: ["-l"],
            label: "shell",
            worktreePath: repoRoot,
            createdAt: "2026-05-02T00:00:00.000Z",
          },
        })),
        displayMessage: vi.fn(() => join(repoRoot, "apps/web")),
        sendKey,
        setWindowMetadata: vi.fn(),
        applyManagedAgentWindowPolicy: vi.fn(),
        killWindow,
      },
      saveState: vi.fn(),
      invalidateDesktopStateSnapshot: vi.fn(),
      refreshLocalDashboardModel: vi.fn(),
      adjustAfterRemove: vi.fn(),
      dashboardWorktreeGroupsCache: [],
    };

    const result = stopService(host, "svc-1");

    expect(result).toEqual({ serviceId: "svc-1", status: "stopped" });
    expect(killWindow).not.toHaveBeenCalled();
    expect(sendKey).toHaveBeenCalledWith(target, "C-c");
    expect(host.offlineServices).toMatchObject([
      {
        id: "svc-1",
        cwd: join(repoRoot, "apps/web"),
        tmuxTarget: target,
        retained: true,
      },
    ]);
  });

  it("kills a retained service window when removing an offline service", () => {
    const target = { sessionName: "aimux-repo", windowId: "@8", windowIndex: 8, windowName: "shell" };
    const killWindow = vi.fn();
    const host = {
      offlineServices: [{ id: "svc-1", label: "shell", tmuxTarget: target, retained: true }],
      tmuxRuntimeManager: {
        getProjectSession: vi.fn(() => ({ sessionName: "aimux-repo" })),
        findManagedWindow: vi.fn(() => null),
        hasWindow: vi.fn(() => true),
        killWindow,
      },
      saveState: vi.fn(),
      invalidateDesktopStateSnapshot: vi.fn(),
      refreshLocalDashboardModel: vi.fn(),
      adjustAfterRemove: vi.fn(),
      dashboardWorktreeGroupsCache: [],
    };

    removeOfflineService(host, "svc-1");

    expect(killWindow).toHaveBeenCalledWith(target);
    expect(host.offlineServices).toEqual([]);
  });

  it("wraps created service commands to drop into an interactive shell on failure", () => {
    const createWindow = vi.fn(() => ({
      sessionName: "aimux-repo",
      windowId: "@9",
      windowIndex: 9,
      windowName: "dev",
    }));
    const host = {
      tmuxRuntimeManager: {
        ensureProjectSession: vi.fn(() => ({ sessionName: "aimux-repo" })),
        createWindow,
        setWindowMetadata: vi.fn(),
        applyManagedAgentWindowPolicy: vi.fn(),
      },
      startedInDashboard: false,
      mode: "dashboard",
      saveState: vi.fn(),
      invalidateDesktopStateSnapshot: vi.fn(),
      refreshLocalDashboardModel: vi.fn(),
      updateWorktreeSessions: vi.fn(),
      preferDashboardEntrySelection: vi.fn(),
      settleDashboardCreatePending: vi.fn(),
    };

    createService(host, "yarn dev", repoRoot);

    const args = createWindow.mock.calls[0][4] as string[];
    const joined = args.join(" ");
    expect(joined).toContain("Service command exited with status");
    expect(joined).toContain("interactive shell for debugging");
    expect(joined).toContain("exec");
    expect(joined).toContain("-i");
  });

  it("wraps resumed service commands to drop into an interactive shell on failure", () => {
    const createWindow = vi.fn(() => ({
      sessionName: "aimux-repo",
      windowId: "@11",
      windowIndex: 11,
      windowName: "dev",
    }));
    const host = {
      offlineServices: [
        { id: "svc-1", label: "dev", worktreePath: repoRoot, launchCommandLine: "yarn dev", createdAt: "" },
      ],
      tmuxRuntimeManager: {
        getProjectSession: vi.fn(() => ({ sessionName: "aimux-repo" })),
        ensureProjectSession: vi.fn(() => ({ sessionName: "aimux-repo" })),
        findManagedWindow: vi.fn(() => null),
        createWindow,
        setWindowMetadata: vi.fn(),
        applyManagedAgentWindowPolicy: vi.fn(),
      },
      saveState: vi.fn(),
      invalidateDesktopStateSnapshot: vi.fn(),
      refreshLocalDashboardModel: vi.fn(),
      updateWorktreeSessions: vi.fn(),
      preferDashboardEntrySelection: vi.fn(),
    };

    resumeOfflineService(host, host.offlineServices[0]);

    const args = createWindow.mock.calls[0][4] as string[];
    const joined = args.join(" ");
    expect(joined).toContain("Service command exited with status");
    expect(joined).toContain("interactive shell for debugging");
  });

  it("restarts a retained service command in its existing tmux window", () => {
    const target = { sessionName: "aimux-repo", windowId: "@12", windowIndex: 12, windowName: "dev" };
    const sendText = vi.fn();
    const sendEnter = vi.fn();
    const killWindow = vi.fn();
    const createWindow = vi.fn();
    const host = {
      offlineServices: [
        {
          id: "svc-1",
          label: "dev",
          worktreePath: repoRoot,
          cwd: join(repoRoot, "apps/web"),
          launchCommandLine: "yarn dev",
          createdAt: "2026-05-02T00:00:00.000Z",
          tmuxTarget: target,
          retained: true,
        },
      ],
      tmuxRuntimeManager: {
        getProjectSession: vi.fn(() => ({ sessionName: "aimux-repo" })),
        ensureProjectSession: vi.fn(() => ({ sessionName: "aimux-repo" })),
        findManagedWindow: vi.fn(() => ({ target, metadata: { kind: "service", sessionId: "svc-1" } })),
        hasWindow: vi.fn(() => true),
        createWindow,
        killWindow,
        sendText,
        sendEnter,
        setWindowMetadata: vi.fn(),
        applyManagedAgentWindowPolicy: vi.fn(),
      },
      saveState: vi.fn(),
      invalidateDesktopStateSnapshot: vi.fn(),
      refreshLocalDashboardModel: vi.fn(),
      updateWorktreeSessions: vi.fn(),
      preferDashboardEntrySelection: vi.fn(),
    };

    resumeOfflineService(host, host.offlineServices[0]);

    expect(createWindow).not.toHaveBeenCalled();
    expect(killWindow).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledWith(target, "yarn dev");
    expect(sendEnter).toHaveBeenCalledWith(target);
    expect(host.offlineServices).toEqual([]);
  });

  it("creates a new window when a retained service window is gone", () => {
    const target = { sessionName: "aimux-repo", windowId: "@13", windowIndex: 13, windowName: "dev" };
    const createWindow = vi.fn(() => target);
    const respawnWindow = vi.fn();
    const host = {
      offlineServices: [
        {
          id: "svc-1",
          label: "dev",
          worktreePath: repoRoot,
          cwd: join(repoRoot, "apps/web"),
          launchCommandLine: "yarn dev",
          tmuxTarget: { sessionName: "aimux-repo", windowId: "@12", windowIndex: 12, windowName: "dev" },
          retained: true,
        },
      ],
      tmuxRuntimeManager: {
        getProjectSession: vi.fn(() => ({ sessionName: "aimux-repo" })),
        ensureProjectSession: vi.fn(() => ({ sessionName: "aimux-repo" })),
        findManagedWindow: vi.fn(() => null),
        hasWindow: vi.fn(() => false),
        createWindow,
        respawnWindow,
        setWindowMetadata: vi.fn(),
        applyManagedAgentWindowPolicy: vi.fn(),
      },
      saveState: vi.fn(),
      invalidateDesktopStateSnapshot: vi.fn(),
      refreshLocalDashboardModel: vi.fn(),
      updateWorktreeSessions: vi.fn(),
      preferDashboardEntrySelection: vi.fn(),
    };

    resumeOfflineService(host, host.offlineServices[0]);

    expect(respawnWindow).not.toHaveBeenCalled();
    expect(createWindow).toHaveBeenCalledWith(
      "aimux-repo",
      "dev",
      join(repoRoot, "apps/web"),
      expect.any(String),
      expect.any(Array),
      { detached: true },
    );
  });

  it("seeds an optimistic service row during dashboard create", () => {
    const createWindow = vi.fn(() => ({
      sessionName: "aimux-repo",
      windowId: "@9",
      windowIndex: 9,
      windowName: "dev",
    }));
    const host = {
      tmuxRuntimeManager: {
        ensureProjectSession: vi.fn(() => ({ sessionName: "aimux-repo" })),
        createWindow,
        setWindowMetadata: vi.fn(),
        applyManagedAgentWindowPolicy: vi.fn(),
      },
      startedInDashboard: true,
      mode: "dashboard",
      setPendingDashboardSessionAction: vi.fn(),
      saveState: vi.fn(),
      invalidateDesktopStateSnapshot: vi.fn(),
      refreshLocalDashboardModel: vi.fn(),
      updateWorktreeSessions: vi.fn(),
      preferDashboardEntrySelection: vi.fn(),
      settleDashboardCreatePending: vi.fn(),
    };

    const result = createService(host, "yarn dev", repoRoot);

    expect(result.serviceId).toMatch(/^service-/);
    expect(host.setPendingDashboardSessionAction).toHaveBeenCalledWith(
      result.serviceId,
      "creating",
      expect.objectContaining({
        serviceSeed: expect.objectContaining({
          id: result.serviceId,
          label: "yarn",
          status: "running",
          worktreePath: repoRoot,
          optimistic: true,
        }),
      }),
    );
  });
});
