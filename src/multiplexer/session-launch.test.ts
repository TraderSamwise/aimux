import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initPaths } from "../paths.js";
import { createSession, handleAction, runProjectService } from "./session-launch.js";

describe("createSession", () => {
  it("does not inject startup preamble when explicitly suppressed", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-launch-"));
    execFileSync("git", ["init"], { cwd: repoRoot, stdio: "ignore" });
    await initPaths(repoRoot);

    const buildSessionPreamble = vi.fn(() => "aimux preamble");
    const deliverDetachedCodexKickoffPrompt = vi.fn();
    const sessions: any[] = [];
    const host: any = {
      sessionBootstrap: {
        buildSessionPreamble,
        ensurePlanFile: vi.fn(),
        finalizePreamble: vi.fn(),
        buildInitialKickoffPrompt: vi.fn(() => "kickoff"),
        deliverDetachedCodexKickoffPrompt,
      },
      tmuxRuntimeManager: {
        ensureProjectSession: vi.fn(() => ({ sessionName: "aimux-test" })),
        createWindow: vi.fn(() => ({ sessionName: "aimux-test", windowId: "@1", windowName: "codex" })),
        getTargetByWindowId: vi.fn(() => ({ sessionName: "aimux-test", windowId: "@1", windowName: "codex" })),
        isWindowAlive: vi.fn(() => true),
      },
      sessionTmuxTargets: new Map(),
      syncTmuxWindowMetadata: vi.fn(),
      registerManagedSession: vi.fn((session: any) => sessions.push(session)),
      sessions,
      getSessionLabel: vi.fn(),
      startedInDashboard: false,
      mode: "session",
      saveState: vi.fn(),
      activeIndex: 0,
    };

    const session = createSession(
      host,
      "codex",
      [],
      undefined,
      "codex",
      undefined,
      undefined,
      repoRoot,
      "backend-session",
      "codex-1",
      false,
      true,
    );

    expect(buildSessionPreamble).not.toHaveBeenCalled();
    expect(host.sessionBootstrap.buildInitialKickoffPrompt).not.toHaveBeenCalled();
    expect(deliverDetachedCodexKickoffPrompt).not.toHaveBeenCalled();

    session.destroy();
    rmSync(repoRoot, { recursive: true, force: true });
  });
});

describe("runProjectService", () => {
  it("starts the dispatcher refresh loop", async () => {
    const resolveRun = vi.fn();
    const host: any = {
      mode: "dashboard",
      syncSessionsFromState: vi.fn(),
      createTaskDispatcher: vi.fn(() => ({ tick: vi.fn(), drainEvents: vi.fn(() => []) })),
      createOrchestrationDispatcher: vi.fn(() => ({ tick: vi.fn(), drainEvents: vi.fn(() => []) })),
      writeInstructionFiles: vi.fn(),
      startProjectServices: vi.fn(),
      startStatusRefresh: vi.fn(() => resolveRun(0)),
      refreshDesktopStateSnapshot: vi.fn(),
      writeStatuslineFile: vi.fn(),
      teardown: vi.fn(),
      resolveRun: undefined,
    };

    const runPromise = runProjectService(host);
    await vi.waitFor(() => expect(host.resolveRun).toBeTypeOf("function"));
    host.resolveRun(0);
    await expect(runPromise).resolves.toBe(0);

    expect(host.mode).toBe("project-service");
    expect(host.startStatusRefresh).toHaveBeenCalledOnce();
  });
});

describe("handleAction", () => {
  it("opens the dashboard chip tab by bottom-chip order for leader digits", () => {
    const host: any = {
      clearDashboardSubscreens: vi.fn(),
      setDashboardScreen: vi.fn(),
      persistDashboardUiState: vi.fn(),
      openTmuxDashboardTarget: vi.fn(),
    };

    handleAction(host, { type: "dashboard-tab", index: 2 });

    expect(host.clearDashboardSubscreens).toHaveBeenCalledOnce();
    expect(host.setDashboardScreen).toHaveBeenCalledWith("notifications");
    expect(host.persistDashboardUiState).toHaveBeenCalledOnce();
    expect(host.openTmuxDashboardTarget).toHaveBeenCalledOnce();
  });

  it("ignores out-of-range dashboard chip indices", () => {
    const host: any = {
      clearDashboardSubscreens: vi.fn(),
      setDashboardScreen: vi.fn(),
      persistDashboardUiState: vi.fn(),
      openTmuxDashboardTarget: vi.fn(),
    };

    handleAction(host, { type: "dashboard-tab", index: 8 });

    expect(host.clearDashboardSubscreens).not.toHaveBeenCalled();
    expect(host.setDashboardScreen).not.toHaveBeenCalled();
    expect(host.persistDashboardUiState).not.toHaveBeenCalled();
    expect(host.openTmuxDashboardTarget).not.toHaveBeenCalled();
  });
});
